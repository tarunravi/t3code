import {
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export class CheckpointCaptureExecutionError extends Schema.TaggedError<CheckpointCaptureExecutionError>()(
  "CheckpointCaptureExecutionError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    reason: Schema.optional(Schema.Literal("incomplete-target")),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isCheckpointCaptureExecutionError = Schema.is(CheckpointCaptureExecutionError);

export interface CheckpointCaptureServiceV2Shape {
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
    readonly historicalRefOnly?: boolean | undefined;
  }) => Effect.Effect<void, CheckpointCaptureExecutionError>;
}

export class CheckpointCaptureServiceV2 extends Context.Service<
  CheckpointCaptureServiceV2,
  CheckpointCaptureServiceV2Shape
>()("t3/orchestration-v2/CheckpointCaptureService/CheckpointCaptureServiceV2") {}

export const make = Effect.gen(function* () {
  const checkpoints = yield* CheckpointService.CheckpointServiceV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const commands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

  const execute = Effect.fn("orchestrationV2.checkpointCapture.execute")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly scopeId: CheckpointScopeId;
    readonly historicalRefOnly?: boolean | undefined;
  }) {
    // This read is inside the existing dispatch lock, before any Git/ref operation.
    const thread = yield* projections.getThread(input.threadId);
    if (thread.preservationOnly === true) return;
    const { run, rootNode, scope, providerThread, readyCheckpointOrdinals, turnCheckpoints } =
      yield* projections.getCheckpointCaptureContext(input.threadId, input);
    if (input.historicalRefOnly) {
      // A Stop, archive, rollback or newer turn after startup wins over repair.
      if (run?.status !== "waiting") return;
      const current = yield* projections.getThreadRecords(input.threadId, ["runs"]);
      if (
        current.thread.archivedAt !== null ||
        current.thread.deletedAt !== null ||
        current.runs.some(
          (other) =>
            other.ordinal > run.ordinal &&
            other.status !== "queued" &&
            !(
              other.status === "cancelled" &&
              other.startedAt === null &&
              other.checkpointId === null
            ),
        )
      )
        return;
    }
    // A stopped or failed run is already terminal. Its checkpoint is the
    // rollback point for rewriting that message, so capture leaves its status alone.
    const preservesTerminalStatus =
      run?.status === "interrupted" || run?.status === "cancelled" || run?.status === "failed";

    // The effect is at-least-once. A settled run with a checkpoint proves
    // that an earlier execution committed its result.
    if (
      run !== undefined &&
      run.checkpointId !== null &&
      (run.status === "completed" || preservesTerminalStatus)
    ) {
      return;
    }
    // Rollback shares this effect lane, so it can only land before a capture
    // runs, e.g. while a failed capture waits to retry. The workspace now
    // holds the rollback target, and the run must stay discarded.
    if (run?.status === "rolled_back") {
      return;
    }

    if (
      run === undefined ||
      (run.status !== "waiting" && !preservesTerminalStatus) ||
      rootNode === undefined ||
      scope === undefined ||
      rootNode.checkpointScopeId !== scope.id ||
      providerThread === undefined
    ) {
      return yield* new CheckpointCaptureExecutionError({
        threadId: input.threadId,
        runId: input.runId,
        scopeId: input.scopeId,
        reason: "incomplete-target",
        cause: "The persisted checkpoint capture target is incomplete or no longer waiting.",
      });
    }

    const capturedAt = yield* DateTime.now;
    const baselineOrdinalWithinScope = Math.max(0, run.ordinal - 1);
    const hasReadyCheckpoint = (ordinalWithinScope: number) =>
      readyCheckpointOrdinals.includes(ordinalWithinScope);
    if (preservesTerminalStatus) {
      // A stop or failure can land before the run recorded its baseline. The
      // provider has not touched the workspace then, so the current tree is
      // the baseline; an existing baseline ref is left as is.
      yield* checkpoints
        .captureBaseline({ scope, ordinalWithinScope: baselineOrdinalWithinScope })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orchestration V2 terminal run baseline capture failed", {
              runId: run.id,
              cause: String(cause),
            }),
          ),
        );
    }
    // A baseline re-materialized over a completed turn's checkpoint (for
    // example one left "missing" outside git) keeps that turn's identity, so
    // the turn stays addressable for rewrites.
    const materializeBaseline = (ordinalWithinScope: number) =>
      checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope }).pipe(
        Effect.map((baseline) => {
          const turn = turnCheckpoints.find(
            (candidate) => candidate.ordinalWithinScope === ordinalWithinScope,
          );
          return turn === undefined
            ? baseline
            : { ...baseline, runId: turn.runId, appRunOrdinal: turn.appRunOrdinal };
        }),
      );
    const threadStartCheckpoint =
      baselineOrdinalWithinScope === 0 || hasReadyCheckpoint(0)
        ? null
        : yield* materializeBaseline(0);
    const baselineCheckpoint = hasReadyCheckpoint(baselineOrdinalWithinScope)
      ? null
      : yield* materializeBaseline(baselineOrdinalWithinScope);
    const checkpoint = yield* checkpoints.capture({
      scope,
      runId: run.id,
      nodeId: rootNode.id,
      ordinalWithinScope: run.ordinal,
      appRunOrdinal: run.ordinal,
      capturedAt,
      // Git may have succeeded before the event transaction failed. Retrying
      // must preserve that boundary, not capture later workspace edits.
      keepExistingRef: true,
      historicalRefOnly: input.historicalRefOnly,
    });
    // Match RunExecutionService: capture loaded the waiting run before
    // materializing baselines. Omit delegatedCompletion so a newer cohort
    // write during capture is not overwritten by this stale snapshot
    // (ProjectionStore preserves the field when absent from the payload).
    const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } = run;
    const commandId = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
    const finalize = eventSink.commitCommand({
      commandId,
      threadId: input.threadId,
      commandType: "checkpoint.capture",
      acceptedAt: capturedAt,
      effects: [],
      events: [
        ...(threadStartCheckpoint === null
          ? []
          : [
              {
                id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                type: "checkpoint.captured" as const,
                threadId: input.threadId,
                nodeId: threadStartCheckpoint.nodeId,
                driver: providerThread.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: capturedAt,
                payload: threadStartCheckpoint,
              },
            ]),
        ...(baselineCheckpoint === null
          ? []
          : [
              {
                id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                type: "checkpoint.captured" as const,
                threadId: input.threadId,
                nodeId: baselineCheckpoint.nodeId,
                driver: providerThread.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: capturedAt,
                payload: baselineCheckpoint,
              },
            ]),
        {
          id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
          type: "checkpoint.captured",
          threadId: input.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          driver: providerThread.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: capturedAt,
          payload: checkpoint,
        },
        {
          id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
          type: "turn-item.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          driver: providerThread.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: capturedAt,
          payload: makeCheckpointTurnItem({
            idAllocator: ids,
            run,
            rootNode,
            providerThread,
            checkpoint,
            completedAt: capturedAt,
          }),
        },
        {
          id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
          type: "run.updated",
          threadId: input.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: capturedAt,
          payload: preservesTerminalStatus
            ? { ...runWithoutDelegatedCompletion, checkpointId: checkpoint.id }
            : {
                ...runWithoutDelegatedCompletion,
                status: "completed",
                completedAt: capturedAt,
                checkpointId: checkpoint.id,
              },
        },
        ...(preservesTerminalStatus
          ? []
          : [
              {
                id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                type: "node.updated" as const,
                threadId: input.threadId,
                runId: run.id,
                nodeId: rootNode.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: capturedAt,
                payload: {
                  ...rootNode,
                  status: "completed" as const,
                  completedAt: capturedAt,
                  checkpointScopeId: scope.id,
                },
              },
            ]),
      ],
    });
    yield* finalize.pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          yield* eventSink.commitCommand({
            commandId: CommandId.make(`${commandId}:blocked`),
            threadId: input.threadId,
            commandType: "checkpoint.capture.blocked",
            acceptedAt: capturedAt,
            effects: [],
            events: [
              {
                id: yield* ids.allocate.event({ threadId: input.threadId, commandId }),
                type: "turn-item.updated",
                threadId: input.threadId,
                runId: run.id,
                nodeId: rootNode.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: capturedAt,
                payload: {
                  ...makeCheckpointTurnItem({
                    idAllocator: ids,
                    run,
                    rootNode,
                    providerThread,
                    checkpoint,
                    completedAt: capturedAt,
                  }),
                  type: "system_notice",
                  status: "failed",
                  title: "Checkpoint finalization blocked",
                  message:
                    "Provider work has finished, but its checkpoint could not be saved. Queued messages are held while T3 retries checkpoint finalization only. Check the server's data and temporary directories, permissions, and free disk space. Do not resend the provider turn.",
                },
              },
            ],
          });
        }).pipe(
          Effect.catch(() =>
            Effect.logWarning(
              "Checkpoint finalization blocked; checkpoint-only retry remains pending. Unable to persist the queue-held notice; check server storage.",
              { threadId: input.threadId, runId: run.id, scopeId: scope.id },
            ),
          ),
        ),
      ),
    );
  });

  return CheckpointCaptureServiceV2.of({
    execute: Effect.fn("CheckpointCaptureServiceV2.execute")(function (input) {
      // Capture and delegated settlement both rewrite run state. Share the
      // dispatch lock so neither can restore the other's stale snapshot.
      return commands
        .withLock(input.threadId, execute(input))
        .pipe(
          Effect.mapError((cause) =>
            isCheckpointCaptureExecutionError(cause)
              ? cause
              : new CheckpointCaptureExecutionError({ ...input, cause }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(CheckpointCaptureServiceV2, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);

function makeCheckpointTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly checkpoint: OrchestrationV2Checkpoint;
  readonly completedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "checkpoint" }> {
  return {
    id: input.idAllocator.derive.turnItemFromProviderItem({
      driver: input.providerThread.driver,
      nativeItemId: `checkpoint:${input.checkpoint.id}`,
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.run.ordinal * 100 + 99,
    status: "completed",
    title: null,
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "checkpoint",
    checkpointId: input.checkpoint.id,
    scopeId: input.checkpoint.scopeId,
    files: input.checkpoint.files,
  };
}
