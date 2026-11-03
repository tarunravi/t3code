import {
  isRuntimeModeAbove,
  managedRuntimeModeCeilingMessage,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

/**
 * A turn would start in a mode above the policy's ceiling. The orchestrator refuses those when
 * they are dispatched; this catches the ones it never saw, such as a run resumed after a restart
 * on a thread whose mode predates the policy.
 */
export class RuntimePolicyAboveCeilingError extends Schema.TaggedError<RuntimePolicyAboveCeilingError>()(
  "RuntimePolicyAboveCeilingError",
  {
    threadId: ThreadId,
    runtimeMode: RuntimeMode,
    maxRuntimeMode: RuntimeMode,
    organization: Schema.String,
  },
) {
  override get message(): string {
    return `${managedRuntimeModeCeilingMessage(this.organization, this.maxRuntimeMode)} Full-access execution is unavailable under this policy.`;
  }
}

export const isRuntimePolicyAboveCeilingError = Schema.is(RuntimePolicyAboveCeilingError);

export class RuntimePolicyFullAccessUnavailableError extends Schema.TaggedError<RuntimePolicyFullAccessUnavailableError>()(
  "RuntimePolicyFullAccessUnavailableError",
  { providerInstanceId: ProviderInstanceId, detail: Schema.String },
) {
  override get message(): string {
    return `Full-access execution is unavailable for ${this.providerInstanceId}: ${this.detail}`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  RuntimePolicyAboveCeilingError,
  RuntimePolicyFullAccessUnavailableError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: "full-access" as const,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    });
  }),
});

const refuseAboveCeiling = (
  managedPolicy: ServerSettings.ServerSettingsService["Service"]["managedPolicy"],
  thread: OrchestrationV2AppThread,
) => {
  const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
  return managedPolicy !== undefined &&
    maxRuntimeMode !== undefined &&
    isRuntimeModeAbove("full-access", maxRuntimeMode)
    ? Effect.fail(
        new RuntimePolicyAboveCeilingError({
          threadId: thread.id,
          runtimeMode: "full-access",
          maxRuntimeMode,
          organization: managedPolicy.organization,
        }),
      )
    : Effect.void;
};

/** Lays the policy's ceiling over another runtime policy, as `layerFromProjectStore` does. */
export const layerEnforcingCeiling: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolveWithinCeiling")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        return yield* base.resolve(input);
      }),
    });
  }),
);

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  | ProjectStore.ProjectStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ServerSettings.ServerSettingsService
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // The same ceiling the orchestrator enforces, fixed for the server's life.
    const { managedPolicy } = yield* ServerSettings.ServerSettingsService;
    const maxRuntimeMode = managedPolicy?.limits?.maxRuntimeMode;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        yield* refuseAboveCeiling(managedPolicy, input.thread);
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const snapshot = instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
        // These built-in adapters predate explicit capability advertising. Registry agents must opt in.
        const legacyFullAccessDriver =
          snapshot !== undefined &&
          ["codex", "claudeAgent", "cursor", "antigravity"].includes(snapshot.driver);
        if (
          snapshot === undefined ||
          (snapshot.supportedRuntimeModes === undefined
            ? !legacyFullAccessDriver
            : !snapshot.supportedRuntimeModes.includes("full-access"))
        ) {
          return yield* new RuntimePolicyFullAccessUnavailableError({
            providerInstanceId: input.modelSelection.instanceId,
            detail:
              "The provider does not advertise supported Full access. No narrower fallback will be used.",
          });
        }
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: input.thread.interactionMode,
          cwd,
          ...(maxRuntimeMode === undefined ? {} : { maxRuntimeMode }),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.flatMap((policy) => {
              const approvalPolicy = override.approvalPolicy ?? policy.approvalPolicy;
              const sandboxPolicy = override.sandboxPolicy ?? policy.sandboxPolicy;
              if (
                (approvalPolicy !== undefined && approvalPolicy !== "never") ||
                (sandboxPolicy !== undefined &&
                  (typeof sandboxPolicy !== "object" ||
                    sandboxPolicy === null ||
                    !("type" in sandboxPolicy) ||
                    sandboxPolicy.type !== "dangerFullAccess"))
              ) {
                return Effect.fail(
                  new RuntimePolicyFullAccessUnavailableError({
                    providerInstanceId: input.modelSelection.instanceId,
                    detail: "Restrictive runtime overrides cannot be presented as Full access.",
                  }),
                );
              }
              // Canonical Full access has no provider-shaped override. Several adapters interpret any
              // override as a request for supervised execution, even when it says never/unrestricted.
              return Effect.succeed(
                ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                  runtimeMode: "full-access",
                  interactionMode: policy.interactionMode,
                  cwd: override.cwd ?? policy.cwd,
                  ...(policy.maxRuntimeMode === undefined
                    ? {}
                    : { maxRuntimeMode: policy.maxRuntimeMode }),
                  ...(override.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: override.reasoningEffort }),
                }),
              );
            }),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
