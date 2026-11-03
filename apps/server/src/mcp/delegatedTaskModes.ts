import {
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** How much a runtime mode allows, narrowest first. */
export function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

/** How much an interaction mode allows: plan, then default. */
export function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

/** Authority comparisons also serve Stop/read paths; do not normalize or elevate these ceilings. */
export function assertRuntimeModeWithinLimit(
  ceiling: RuntimeMode,
  target: RuntimeMode,
): Effect.Effect<void, OrchestratorMcpFailure> {
  return runtimeModeRank(target) > runtimeModeRank(ceiling)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "runtime_mode_escalation_denied",
          message: `Runtime mode ${target} exceeds caller authority (${ceiling}).`,
        }),
      )
    : Effect.void;
}

/** Launch selection is separate from the caller's real authority ceiling. */
export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: {
    readonly modelSelection: ModelSelection;
    readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  },
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  if (parentMode !== "full-access") {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "runtime_mode_escalation_denied",
        message: `Full-access execution exceeds caller authority (${parentMode}). The grant was not upgraded.`,
      }),
    );
  }
  if (requested !== undefined && requested !== "inherit" && requested !== "full-access") {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Only Full-access execution is supported.",
      }),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported !== undefined && !supported.includes("full-access")) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider ${target?.modelSelection.instanceId} does not support Full-access execution. No approval-mode fallback is available.`,
      }),
    );
  }
  return Effect.succeed("full-access");
}

/** The same, for interaction modes. */
export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "interaction_mode_escalation_denied",
          message: `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        }),
      )
    : Effect.succeed(resolved);
}

/** The task as its child receives it, with the role the caller asked for. */
export function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.task;
}
