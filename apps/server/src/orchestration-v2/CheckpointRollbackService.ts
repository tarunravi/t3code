import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2DomainEvent,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  checkpointTurnOrdinal,
  decideRollbackExecution,
  isRewriteTarget,
} from "./CommandPolicy.ts";
import { ContextHandoffServiceV2 } from "./ContextHandoffService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackTarget } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";

export class CheckpointRollbackExecutionError extends Schema.TaggedError<CheckpointRollbackExecutionError>()(
  "CheckpointRollbackExecutionError",
  {
    reason: Schema.Literals([
      "rollback-target-invalid",
      "active-provider-changed",
      "provider-turn-unavailable",
      "unexpected-failure",
      "shared-workspace",
    ]),
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    checkpointId: CheckpointId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "rollback-target-invalid":
        return `Rollback target ${this.checkpointId} for provider thread ${this.providerThreadId} on thread ${this.threadId} is incomplete or invalid.`;
      case "active-provider-changed":
        return `Active provider changed before rollback target ${this.checkpointId} could execute on thread ${this.threadId}.`;
      case "provider-turn-unavailable":
        return `Provider turn for rollback target ${this.checkpointId} is unavailable on provider thread ${this.providerThreadId}.`;
      case "shared-workspace":
        return SHARED_WORKSPACE_RESTORE_MESSAGE;
      case "unexpected-failure":
        return `Failed to execute rollback target ${this.checkpointId} on provider thread ${this.providerThreadId} for thread ${this.threadId}.`;
    }
  }
}

const isCheckpointRollbackExecutionError = Schema.is(CheckpointRollbackExecutionError);

export interface CheckpointRollbackServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly checkpointId: CheckpointId;
    readonly scopeId: CheckpointScopeId;
    readonly restoreFiles?: boolean;
  }) => Effect.Effect<void, CheckpointRollbackExecutionError>;
}

export class CheckpointRollbackServiceV2 extends Context.Service<
  CheckpointRollbackServiceV2,
  CheckpointRollbackServiceV2Shape
>()("t3/orchestration-v2/CheckpointRollbackService/CheckpointRollbackServiceV2") {}

export const layer: Layer.Layer<
  CheckpointRollbackServiceV2,
  never,
  | CheckpointServiceV2
  | ContextHandoffServiceV2
  | EventSinkV2
  | IdAllocatorV2
  | ProjectionStoreV2
  | ProviderSessionManagerV2
  | RuntimePolicyV2
  | FileSystem.FileSystem
> = Layer.effect(
  CheckpointRollbackServiceV2,
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const handoffs = yield* ContextHandoffServiceV2;
    const eventSink = yield* EventSinkV2;
    const ids = yield* IdAllocatorV2;
    const projections = yield* ProjectionStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const runtimePolicy = yield* RuntimePolicyV2;
    const fileSystem = yield* FileSystem.FileSystem;

    const execute = Effect.fn("orchestrationV2.checkpointRollback.execute")(function* (input: {
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId;
      readonly checkpointId: CheckpointId;
      readonly scopeId: CheckpointScopeId;
      readonly restoreFiles?: boolean;
    }) {
      const projection = yield* projections.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
        "checkpoints",
        "checkpointScopes",
        "runs",
        "attempts",
        "nodes",
        "providerTurns",
        // A rewrite replays the retained turn items into the fresh provider thread.
        "turnItems",
      ]);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === input.providerThreadId,
      );
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId,
      );
      const scope = projection.checkpointScopes.find((candidate) => candidate.id === input.scopeId);
      if (
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        checkpoint === undefined ||
        scope === undefined ||
        checkpoint.scopeId !== scope.id ||
        !isRewriteTarget(checkpoint, input.restoreFiles)
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }
      if (
        providerThread.id !== projection.thread.activeProviderThreadId ||
        providerThread.providerInstanceId !== projection.thread.modelSelection.instanceId
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "active-provider-changed",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      if (
        input.restoreFiles !== false &&
        !(yield* isCheckpointRestoreIsolated(projection.thread, scope, { fileSystem, projections }))
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "shared-workspace",
          threadId: input.threadId,
          providerThreadId: input.providerThreadId,
          checkpointId: input.checkpointId,
        });
      }

      const modelSelection = projection.thread.modelSelection;
      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection,
      });
      const existingSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerThread.providerSessionId,
      );
      const session = yield* sessions.open({
        threadId: input.threadId,
        providerSessionId: providerThread.providerSessionId,
        modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
        ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
        ...(providerThread.nativeThreadRef?.nativeId == null
          ? {}
          : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
        ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
          ? {}
          : {
              initialProviderItemIdentityVersion: providerThread.nativeMetadata.itemIdentityVersion,
            }),
      });

      const targetOrdinal = checkpointTurnOrdinal(checkpoint, scope);
      if (
        projection.runs.some((run) =>
          ["preparing", "starting", "running", "waiting", "queued"].includes(run.status),
        )
      ) {
        return yield* new CheckpointRollbackExecutionError({
          reason: "rollback-target-invalid",
          ...input,
          cause: "Finish or cancel active and queued turns before rewriting conversation history.",
        });
      }
      let execution = yield* decideRollbackExecution({
        commandId: CommandId.make(`rollback:${input.checkpointId}`),
        threadId: input.threadId,
        providerInstanceId: providerThread.providerInstanceId,
        capabilities: session.providerSession.capabilities,
        canForkFromTarget:
          targetOrdinal > 0 && providerThread.nativeThreadRef?.strength === "strong",
      });
      const runsToRollback = projection.runs.filter(
        (run) => run.ordinal > targetOrdinal && run.status !== "rolled_back",
      );
      // Rolled-back turns stay in the audit history, but no longer exist in
      // the provider conversation and must not be counted by a later rewind.
      const rolledBackRunIds = new Set(
        projection.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
      );
      const rolledBackAttemptIds = new Set(
        projection.attempts
          .filter((attempt) => rolledBackRunIds.has(attempt.runId))
          .map((attempt) => attempt.id),
      );
      const providerThreadTurns = projection.providerTurns.filter(
        (turn) =>
          turn.providerThreadId === providerThread.id &&
          (turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId)),
      );
      const rollbackTarget: ProviderAdapterV2RollbackTarget =
        targetOrdinal === 0 || execution === "portable_context"
          ? {
              type: "thread_start",
              checkpointId: checkpoint.id,
              appRunOrdinal: 0,
            }
          : yield* Effect.gen(function* () {
              const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
              const targetAttempt = projection.attempts.find(
                (attempt) => attempt.id === targetRun?.activeAttemptId,
              );
              const targetTurn = projection.providerTurns.find(
                (turn) =>
                  turn.id === targetAttempt?.providerTurnId ||
                  turn.runAttemptId === targetAttempt?.id,
              );
              if (targetTurn === undefined || targetTurn.providerThreadId !== providerThread.id) {
                return yield* new CheckpointRollbackExecutionError({
                  reason: "provider-turn-unavailable",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                });
              }
              return {
                type: "provider_turn" as const,
                checkpointId: checkpoint.id,
                appRunOrdinal: targetOrdinal,
                providerTurn: targetTurn,
              };
            });

      const nativeSnapshot =
        runsToRollback.length === 0 || execution === "portable_context"
          ? Effect.succeed({ providerThread })
          : execution === "native_fork" && rollbackTarget.type === "provider_turn"
            ? session
                .forkThread({
                  sourceProviderThread: providerThread,
                  sourceProviderTurns: providerThreadTurns,
                  targetThreadId: input.threadId,
                  modelSelection,
                  runtimePolicy: resolvedRuntimePolicy,
                  providerTurnId: rollbackTarget.providerTurn.id,
                })
                .pipe(Effect.map((forked) => ({ providerThread: forked })))
            : session.rollbackThread({
                providerThread,
                target: rollbackTarget,
                providerThreadTurns,
              });
      // Some native threads refuse rollback at runtime (Codex threads with
      // paginated history). A provider that accepts handoff summaries can
      // still continue from the retained prefix in a fresh provider thread.
      const snapshot = yield* nativeSnapshot.pipe(
        Effect.catch((cause) =>
          execution !== "portable_context" &&
          session.providerSession.capabilities.context.canConsumeHandoffSummaries
            ? Effect.logWarning("orchestrationV2.checkpointRollback.portableFallback", {
                threadId: input.threadId,
                providerThreadId: providerThread.id,
                cause,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    execution = "portable_context";
                  }),
                ),
                Effect.as({ providerThread }),
              )
            : Effect.fail(cause),
        ),
      );
      // Later turn boundaries no longer exist; only ready ones own a git ref to delete.
      const staleCheckpoints = projection.checkpoints.filter(
        (candidate) =>
          candidate.scopeId === scope.id &&
          candidate.appRunOrdinal !== null &&
          candidate.appRunOrdinal > targetOrdinal &&
          (candidate.status === "ready" || candidate.status === "missing"),
      );
      const staleCheckpointRefs = staleCheckpoints.filter(
        (candidate) => candidate.status === "ready",
      );

      const now = yield* DateTime.now;
      const makeEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
        Effect.map(
          ids.allocate.event({ threadId: event.threadId }),
          (id) =>
            ({
              ...event,
              id,
            }) as Event,
        );
      const events: Array<OrchestrationV2DomainEvent> = [];
      if (execution === "portable_context") {
        // Keep the original native binding for history/forks. Only the active
        // continuation gets a fresh session and the retained conversation prefix.
        const nextRunId = ids.derive.run({
          threadId: input.threadId,
          ordinal: projection.runs.length + 1,
        });
        const replacement: OrchestrationV2ProviderThread = {
          id: ids.derive.providerThread({
            driver: providerThread.driver,
            nativeThreadId: `rewrite:${nextRunId}:${checkpoint.id}`,
          }),
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          providerSessionId: yield* ids.allocate.providerSession({
            providerInstanceId: providerThread.providerInstanceId,
            threadId: input.threadId,
          }),
          appThreadId: input.threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const retainedRuns = projection.runs.filter(
          (run) => run.ordinal <= targetOrdinal && run.status !== "rolled_back",
        );
        const retainedRunIds = new Set(retainedRuns.map((run) => run.id));
        const handoff = yield* handoffs.prepareProviderHandoff({
          threadId: input.threadId,
          targetRunId: nextRunId,
          transferId: null,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: replacement.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: providerThread.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: Math.max(1, targetOrdinal) },
          strategy: "full_thread_summary",
          runs: retainedRuns,
          items: projection.turnItems.filter(
            (item) => item.runId === null || retainedRunIds.has(item.runId),
          ),
          createdAt: now,
        });
        events.push(
          yield* makeEvent({
            type: "context-handoff.updated",
            threadId: input.threadId,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: handoff,
          }),
          yield* makeEvent({
            type: "provider-thread.updated",
            threadId: input.threadId,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: { ...replacement, handoffIds: [handoff.id] },
          }),
          yield* makeEvent({
            type: "thread.metadata-updated",
            threadId: input.threadId,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: {
              ...projection.thread,
              activeProviderThreadId: replacement.id,
              updatedAt: now,
            },
          }),
        );
      }
      if (execution !== "portable_context") {
        events.push(
          yield* makeEvent({
            type: "provider-thread.updated",
            threadId: input.threadId,
            driver: providerThread.driver,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: {
              ...snapshot.providerThread,
              lastRunOrdinal: targetOrdinal === 0 ? null : targetOrdinal,
              updatedAt: now,
            },
          }),
        );
      }
      if (input.restoreFiles !== false) yield* checkpoints.restore({ scope, checkpoint });
      if (staleCheckpointRefs.length > 0) {
        yield* checkpoints.deleteStaleRefs({ scope, checkpoints: staleCheckpointRefs });
      }
      for (const staleCheckpoint of staleCheckpoints) {
        events.push(
          yield* makeEvent({
            type: "checkpoint.captured",
            threadId: input.threadId,
            ...(staleCheckpoint.runId === null ? {} : { runId: staleCheckpoint.runId }),
            nodeId: staleCheckpoint.nodeId,
            providerInstanceId: providerThread.providerInstanceId,
            occurredAt: now,
            payload: { ...staleCheckpoint, status: "stale" },
          }),
        );
      }
      for (const run of runsToRollback) {
        const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
        events.push(
          yield* makeEvent({
            type: "run.updated",
            threadId: input.threadId,
            runId: run.id,
            ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, status: "rolled_back", completedAt: now },
          }),
        );
        if (rootNode !== undefined) {
          events.push(
            yield* makeEvent({
              type: "node.updated",
              threadId: input.threadId,
              runId: run.id,
              nodeId: rootNode.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...rootNode, status: "rolled_back", completedAt: now },
            }),
          );
        }
      }
      yield* eventSink.write({ events });
    });

    return CheckpointRollbackServiceV2.of({
      execute: (input) =>
        execute(input).pipe(
          Effect.mapError((cause) =>
            isCheckpointRollbackExecutionError(cause)
              ? cause
              : new CheckpointRollbackExecutionError({
                  reason: "unexpected-failure",
                  threadId: input.threadId,
                  providerThreadId: input.providerThreadId,
                  checkpointId: input.checkpointId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
