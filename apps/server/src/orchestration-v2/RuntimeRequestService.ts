import {
  ProviderApprovalDecision,
  ProviderSessionId,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export class RuntimeRequestResponseExecutionError extends Schema.TaggedError<RuntimeRequestResponseExecutionError>()(
  "RuntimeRequestResponseExecutionError",
  {
    reason: Schema.Literals([
      "request-missing",
      "request-not-ready",
      "request-not-resumable",
      "provider-session-not-active",
      "unexpected-failure",
    ]),
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "request-missing":
        return `Runtime request ${this.requestId} no longer exists on thread ${this.threadId}.`;
      case "request-not-ready":
        return `Runtime request ${this.requestId} on thread ${this.threadId} is not ready for response execution.`;
      case "request-not-resumable":
        return `Runtime request ${this.requestId} on thread ${this.threadId} is not resumable on provider session ${this.providerSessionId}.`;
      case "provider-session-not-active":
        return `Provider session ${this.providerSessionId} is not active for runtime request ${this.requestId} on thread ${this.threadId}.`;
      case "unexpected-failure":
        return `Failed to respond to runtime request ${this.requestId} on thread ${this.threadId} via provider session ${this.providerSessionId}.`;
    }
  }
}

const isRuntimeRequestResponseExecutionError = Schema.is(RuntimeRequestResponseExecutionError);

export interface RuntimeRequestServiceV2Shape {
  readonly respond: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly requestId: RuntimeRequestId;
    readonly decision?: ProviderApprovalDecision;
    readonly feedback?: string;
    readonly answers?: ProviderUserInputAnswers;
  }) => Effect.Effect<void, RuntimeRequestResponseExecutionError>;
}

export class RuntimeRequestServiceV2 extends Context.Service<
  RuntimeRequestServiceV2,
  RuntimeRequestServiceV2Shape
>()("t3/orchestration-v2/RuntimeRequestService/RuntimeRequestServiceV2") {}

export const layer: Layer.Layer<
  RuntimeRequestServiceV2,
  never,
  ProjectionStore.ProjectionStoreV2 | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  RuntimeRequestServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

    return RuntimeRequestServiceV2.of({
      respond: Effect.fn("RuntimeRequestService.respond")(
        function* (input) {
          const request = yield* projections.getRuntimeRequest(input.threadId, input.requestId);
          if (request === undefined) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-missing",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          // Dispatch persists resolution before this effect runs; pending requests are not executable.
          if (request.status !== "resolved") {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-ready",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          if (
            request.responseCapability.type !== "live" ||
            request.responseCapability.providerSessionId !== input.providerSessionId
          ) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "request-not-resumable",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          const session = yield* sessions.get(input.providerSessionId);
          if (Option.isNone(session)) {
            return yield* new RuntimeRequestResponseExecutionError({
              reason: "provider-session-not-active",
              threadId: input.threadId,
              providerSessionId: input.providerSessionId,
              requestId: input.requestId,
            });
          }
          if (request.automaticDecision !== undefined) {
            const context = yield* projections.getRuntimeResponseContext(
              input.threadId,
              input.requestId,
            );
            const { runs, providerTurns, providerThreads } = yield* projections.getThreadRecords(
              input.threadId,
              ["runs", "providerTurns", "providerThreads"],
            );
            const run = runs.find((candidate) => candidate.id === context.node?.runId);
            const turn = providerTurns.find((candidate) => candidate.id === request.providerTurnId);
            const thread = providerThreads.find(
              (candidate) => candidate.id === context.node?.providerThreadId,
            );
            if (
              input.decision !== request.decision ||
              session.value.providerSession.status === "stopped" ||
              session.value.providerSession.status === "error" ||
              context.node?.providerTurnId !== request.providerTurnId ||
              (context.node?.runId != null &&
                (run === undefined ||
                  run.status !== "running" ||
                  turn === undefined ||
                  turn.status !== "running" ||
                  turn.runAttemptId !== run.activeAttemptId ||
                  turn.providerThreadId !== context.node.providerThreadId ||
                  thread?.providerSessionId !== input.providerSessionId))
            ) {
              return yield* new RuntimeRequestResponseExecutionError({
                reason: "request-not-resumable",
                threadId: input.threadId,
                providerSessionId: input.providerSessionId,
                requestId: input.requestId,
              });
            }
          }
          yield* session.value.respondToRuntimeRequest({
            requestId: input.requestId,
            ...(input.decision === undefined ? {} : { decision: input.decision }),
            ...(input.feedback === undefined ? {} : { feedback: input.feedback }),
            ...(input.answers === undefined ? {} : { answers: input.answers }),
          });
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isRuntimeRequestResponseExecutionError(cause)
                ? cause
                : new RuntimeRequestResponseExecutionError({
                    reason: "unexpected-failure",
                    threadId: input.threadId,
                    providerSessionId: input.providerSessionId,
                    requestId: input.requestId,
                    cause,
                  }),
            ),
          ),
      ),
    });
  }),
);
