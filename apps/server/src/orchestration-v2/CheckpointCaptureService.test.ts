import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventStore from "./EventStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as RunExecution from "./RunExecutionService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as TurnItemPositions from "./TurnItemPositionStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerProjectionStoreTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

const threadId = ThreadId.make("thread:checkpoint-capture-delegated");
const projectId = ProjectId.make("project:checkpoint-capture-delegated");
const runId = RunId.make("run:checkpoint-capture-delegated");
const scopeId = CheckpointScopeId.make("scope:checkpoint-capture-delegated");
const rootNodeId = NodeId.make("node:checkpoint-capture-delegated-root");
const taskId = NodeId.make("node:checkpoint-capture-task");
const deliveryMessageId = MessageId.make("message:checkpoint-capture-delivery");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-capture-delegated");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} as const;

it.layer(layerProjectionStoreTest)("CheckpointCaptureServiceV2", (it) => {
  it.effect.each([
    "normal",
    "lookup-failure",
    "append-failure",
    "all-appends-fail",
    "legacy-exhausted",
    "incomplete-target",
  ] as const)(
    "captures without decoding history or losing newer delegated completion, scenario=%s",
    (scenario) =>
      Effect.gen(function* () {
        const refLookupFails = scenario === "lookup-failure";
        const retryCapture =
          scenario === "append-failure" ||
          scenario === "all-appends-fail" ||
          scenario === "legacy-exhausted";
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const later = DateTime.add(now, { seconds: 1 });

        const staleDelegatedCompletion = {
          disposition: "open" as const,
          nextGeneration: 1,
          delivery: null,
        };
        const newerCohort = {
          disposition: "open" as const,
          nextGeneration: 2,
          delivery: {
            generation: 1,
            messageId: deliveryMessageId,
            taskIds: [taskId],
          },
        };
        const staleRun: OrchestrationV2Run = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:checkpoint-capture-user"),
          rootNodeId,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          delegatedCompletion: staleDelegatedCompletion,
        };
        const rootNode = {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn" as const,
          status: "waiting" as const,
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: now,
          completedAt: null,
        };
        const scope = {
          id: scopeId,
          threadId,
          runId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run" as const,
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: now,
        };
        const providerThread = {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const readyBaseline = {
          id: CheckpointId.make("checkpoint:baseline-0"),
          threadId,
          scopeId,
          runId: null,
          nodeId: rootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("checkpoint-ref:baseline-0"),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        };
        const captured = {
          id: CheckpointId.make("checkpoint:captured-1"),
          threadId,
          scopeId,
          runId,
          nodeId: rootNodeId,
          parentCheckpointId: readyBaseline.id,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("checkpoint-ref:captured-1"),
          status: "ready" as const,
          files: [],
          capturedAt: now,
        };

        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: "Checkpoint capture delegated completion",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:run-stale"),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: staleRun,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:node"),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: now,
          payload: rootNode,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:provider-thread"),
          type: "provider-thread.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: providerThread,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:scope"),
          type: "checkpoint-scope.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          occurredAt: now,
          payload: scope,
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-capture:baseline"),
          type: "checkpoint.captured",
          threadId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: readyBaseline,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json)
          VALUES ('obsolete-history', ${threadId}, ${runId}, ${rootNodeId}, NULL, NULL,
            NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(now)}, '{"obsolete":true}')`;
        yield* sql`UPDATE orchestration_v2_projection_checkpoints
          SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
          WHERE checkpoint_id = ${readyBaseline.id}`;
        assert.equal(
          (yield* Effect.exit(projectionStore.getThreadProjection(threadId)))._tag,
          "Failure",
        );

        const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
        const realSink = yield* EventSink.EventSinkV2.pipe(
          Effect.provide(EventSink.layer.pipe(Layer.provide(EventStore.layer))),
        );
        const layerCapture = CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              refLookupFails
                ? CheckpointService.layer.pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        IdAllocator.layer,
                        PreviewAgentActivity.layer,
                        NodeCrypto.layer,
                        Layer.mock(CheckpointStore.CheckpointStore)({
                          listAuthoredPaths: () => Effect.succeed(null),
                          isGitRepository: () => Effect.succeed(true),
                          captureCheckpoint: () => Effect.void,
                          hasCheckpointRef: () =>
                            Effect.fail(
                              new VcsProcessTimeoutError({
                                operation: "test.hasCheckpointRef",
                                command: "git",
                                cwd: "/repo",
                                timeoutMs: 30000,
                              }),
                            ),
                        }),
                      ),
                    ),
                  )
                : Layer.mock(CheckpointService.CheckpointServiceV2)({
                    materializeBaselineCheckpoint: () =>
                      Effect.die(
                        "baseline materialization must be skipped when ordinal 0 is ready",
                      ),
                    capture: (input) => {
                      assert.isTrue(input.keepExistingRef);
                      if (scenario === "legacy-exhausted" && input.historicalRefOnly !== undefined)
                        assert.isTrue(input.historicalRefOnly);
                      return Effect.succeed(captured);
                    },
                  }),
              Layer.mock(EventSink.EventSinkV2)({
                commitCommand: (input) =>
                  retryCapture
                    ? realSink
                        .commitCommand(input)
                        .pipe(Effect.tap(() => Ref.set(committed, input.events)))
                    : Ref.set(committed, input.events).pipe(
                        Effect.as({
                          commandId: input.commandId,
                          committed: true,
                          sequence: 1,
                          events: input.events,
                          effects: [],
                        } as never),
                      ),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
          const incomplete = yield* service
            .execute({ threadId, runId, scopeId: CheckpointScopeId.make("missing-scope") })
            .pipe(Effect.flip);
          assert.instanceOf(incomplete, CheckpointCaptureService.CheckpointCaptureExecutionError);
          assert.equal(incomplete.reason, "incomplete-target");
          if (scenario === "incomplete-target") {
            let cleanupCalls = 0;
            const workerLayer = EffectWorker.layer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  EffectOutbox.layer,
                  Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
                    execute: (effect) =>
                      effect.request.type === "checkpoint.capture"
                        ? service
                            .execute({ threadId, runId, scopeId: effect.request.scopeId })
                            .pipe(
                              Effect.mapError(
                                (cause) =>
                                  new EffectWorker.OrchestrationEffectExecutionError({
                                    effectId: effect.id,
                                    effectType: effect.request.type,
                                    cause: new RunFinalization.RunFinalizationError({
                                      threadId,
                                      runId,
                                      scopeId: CheckpointScopeId.make("missing-scope"),
                                      operation: "capture-checkpoint",
                                      cause,
                                    }),
                                  }),
                              ),
                            )
                        : Effect.sync(() => {
                            assert.equal(effect.request.type, "terminal.cleanup");
                            cleanupCalls++;
                          }),
                  }),
                ),
              ),
            );
            yield* Effect.gen(function* () {
              const outbox = yield* EffectOutbox.EffectOutboxV2;
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              yield* outbox.enqueue([
                {
                  id: "incomplete-capture",
                  threadId,
                  commandId: CommandId.make("incomplete-capture"),
                  request: {
                    type: "checkpoint.capture",
                    runId,
                    scopeId: CheckpointScopeId.make("missing-scope"),
                  },
                },
                {
                  id: "later-cleanup",
                  threadId,
                  commandId: CommandId.make("later-cleanup"),
                  request: { type: "terminal.cleanup" },
                },
              ]);
              for (let attempt = 1; attempt <= 5; attempt++) {
                assert.isTrue(yield* worker.runOnce);
                assert.equal(cleanupCalls, 0);
                yield* TestClock.adjust("31 seconds");
              }
              const failed = Option.getOrThrow(yield* outbox.get("incomplete-capture"));
              assert.equal(failed.status, "failed");
              assert.equal(failed.attemptCount, 5);
              assert.isTrue(yield* worker.runOnce);
              assert.equal(cleanupCalls, 1);
              assert.equal(
                Option.getOrThrow(yield* outbox.get("later-cleanup")).status,
                "succeeded",
              );
              assert.isFalse(yield* worker.runOnce);
            }).pipe(Effect.provide(workerLayer));
            return;
          }
          if (refLookupFails) {
            const failure = yield* service.execute({ threadId, runId, scopeId }).pipe(Effect.flip);
            assert.instanceOf(failure, CheckpointCaptureService.CheckpointCaptureExecutionError);
            assert.deepEqual(yield* Ref.get(committed), []);
            return;
          }
          if (retryCapture) {
            const attemptId = RunAttemptId.make("attempt:checkpoint-recovery");
            const providerTurnId = ProviderTurnId.make("turn:checkpoint-recovery");
            const activeRun = {
              ...staleRun,
              status: "running" as const,
              activeAttemptId: attemptId,
            };
            const activeNode = { ...rootNode, status: "running" as const, providerTurnId };
            yield* realSink.write({
              events: [
                {
                  id: EventId.make("event:recovery:running"),
                  type: "run.updated",
                  threadId,
                  runId,
                  nodeId: rootNodeId,
                  occurredAt: now,
                  payload: activeRun,
                },
                {
                  id: EventId.make("event:recovery:node-running"),
                  type: "node.updated",
                  threadId,
                  runId,
                  nodeId: rootNodeId,
                  occurredAt: now,
                  payload: activeNode,
                },
              ],
            });
            const turnStarted = yield* Deferred.make<void>();
            const ingestionDone = yield* Deferred.make<void>();
            let originalProviderStarts = 0;
            const executionLayer = RunExecution.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  IdAllocator.layer,
                  PreviewAgentActivity.layer,
                  ServerSettings.layerTest(),
                  McpAppModelContext.layerEmpty,
                  TurnItemPositions.layer,
                  Layer.succeed(EventSink.EventSinkV2, realSink),
                  Layer.mock(CheckpointService.CheckpointServiceV2)({
                    captureBaseline: () => Effect.void,
                  }),
                  Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({
                    ingestNormalized: () => Effect.succeed([]),
                  }),
                  Layer.mock(RunFinalization.RunFinalizationObserver)({
                    refreshAfterTurn: () => Effect.void,
                  }),
                ),
              ),
            );
            yield* Effect.gen(function* () {
              const execution = yield* RunExecution.RunExecutionServiceV2;
              yield* execution.startRootRun({
                commandId: CommandId.make("command:provider-completion"),
                appThread: yield* projectionStore.getThread(threadId),
                providerSessionId: ProviderSessionId.make("session:checkpoint-recovery"),
                session: {
                  events: Stream.empty,
                  subscribeEvents: Effect.succeed({
                    events: Stream.fromEffect(Deferred.await(turnStarted)).pipe(
                      Stream.map(() => ({
                        type: "turn.terminal" as const,
                        driver,
                        providerThreadId,
                        providerTurnId,
                        runOrdinal: 1,
                        status: "completed" as const,
                        failure: null,
                        threadDisposition: "reusable" as const,
                      })),
                    ),
                    close: Deferred.succeed(ingestionDone, undefined),
                  }),
                  startTurn: () =>
                    Effect.sync(() => {
                      originalProviderStarts++;
                    }).pipe(
                      Effect.andThen(Deferred.succeed(turnStarted, undefined)),
                      Effect.asVoid,
                    ),
                } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
                run: activeRun,
                rootNode: activeNode,
                checkpointScope: scope,
                providerThread,
                attempt: {
                  id: attemptId,
                  runId,
                  attemptOrdinal: 1,
                  rootNodeId,
                  providerInstanceId,
                  providerThreadId,
                  providerTurnId,
                  reason: "initial",
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
                attemptId,
                providerTurnOrdinal: 1,
                message: {
                  messageId: staleRun.userMessageId,
                  text: "Finish once",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
                modelSelection,
                runtimePolicy: {
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  cwd: "/repo",
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              });
              yield* Deferred.await(ingestionDone);
            }).pipe(Effect.provide(executionLayer));
            assert.equal(originalProviderStarts, 1);
            // Fail at the actual event INSERT, after Git capture but before the atomic
            // checkpoint/run/node commit. Other writes remain available for the outbox.
            yield* sql.unsafe(`CREATE TEMP TRIGGER checkpoint_append_unavailable
              BEFORE INSERT ON orchestration_events
              ${scenario === "append-failure" ? "WHEN NEW.event_type = 'checkpoint.captured'" : ""}
              BEGIN SELECT RAISE(FAIL, 'injected checkpoint append failure'); END`);
            let providerStarts = 0;
            const workerLayer = EffectWorker.layer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  EffectOutbox.layer,
                  Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
                    execute: (effect) =>
                      effect.request.type === "checkpoint.capture"
                        ? service
                            .execute({
                              threadId,
                              runId,
                              scopeId,
                              historicalRefOnly: effect.request.historicalRefOnly,
                            })
                            .pipe(
                              Effect.mapError(
                                (cause) =>
                                  new EffectWorker.OrchestrationEffectExecutionError({
                                    effectId: effect.id,
                                    effectType: effect.request.type,
                                    cause,
                                  }),
                              ),
                            )
                        : Effect.sync(() => {
                            providerStarts++;
                          }),
                  }),
                ),
              ),
            );
            yield* Effect.gen(function* () {
              const outbox = yield* EffectOutbox.EffectOutboxV2;
              const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
              for (let attempt = 1; attempt <= 6; attempt++) {
                assert.isTrue(yield* worker.runOnce);
                if (attempt === 1) {
                  yield* outbox.enqueue([
                    {
                      id: "queued-followup",
                      commandId: CommandId.make("queued-followup"),
                      threadId,
                      request: { type: "provider-turn.start", runId: RunId.make("next-run") },
                    },
                  ]);
                }
                const pending = Option.getOrThrow(
                  yield* outbox.get(`effect:checkpoint.capture:${runId}`),
                );
                assert.equal(pending.status, "pending");
                assert.equal(
                  pending.attemptCount,
                  scenario === "legacy-exhausted" && attempt === 6 ? 7 : attempt,
                );
                assert.include(pending.lastError ?? "", "injected checkpoint append failure");
                assert.equal(providerStarts, 0);
                assert.isFalse(yield* worker.runOnce);
                const context = yield* projectionStore.getCheckpointCaptureContext(threadId, {
                  runId,
                  scopeId,
                });
                assert.equal(context.run?.status, "waiting");
                assert.equal(context.run?.checkpointId, null);
                assert.deepEqual(context.run?.delegatedCompletion, staleDelegatedCompletion);
                yield* TestClock.adjust("30 seconds");
                if (scenario === "legacy-exhausted" && attempt === 5) {
                  // Seed the old server's exhausted state, not a new failure mode.
                  yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'failed',
                    completed_at = ${DateTime.formatIso(now)}
                    WHERE effect_id = ${`effect:checkpoint.capture:${runId}`}`;
                  yield* outbox.enqueue([
                    {
                      id: "unrelated-exhausted-cleanup",
                      threadId,
                      commandId: CommandId.make("unrelated-exhausted-cleanup"),
                      request: { type: "terminal.cleanup" },
                    },
                  ]);
                  yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'failed', attempt_count = 5 WHERE effect_id = 'unrelated-exhausted-cleanup'`;
                  const unrelatedBefore = Option.getOrThrow(
                    yield* outbox.get("unrelated-exhausted-cleanup"),
                  );
                  const identity = sql<{
                    rowid: number;
                    command_id: string;
                  }>`SELECT rowid, command_id FROM orchestration_v2_effect_outbox WHERE effect_id = ${`effect:checkpoint.capture:${runId}`}`;
                  const identityBefore = yield* identity;
                  const recoveryLayer = ProviderRuntimeRecovery.layer.pipe(
                    Layer.provide(
                      Layer.mergeAll(
                        Layer.succeed(ProjectionStore.ProjectionStoreV2, projectionStore),
                        Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
                        Layer.succeed(EventSink.EventSinkV2, realSink),
                        IdAllocator.layer,
                        PreviewAgentActivity.layer,
                        ServerSettings.layerTest(),
                      ),
                    ),
                  );
                  yield* Effect.gen(function* () {
                    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
                    assert.equal((yield* recovery.recover).terminalizedRuns, 0);
                    const recovered = Option.getOrThrow(
                      yield* outbox.get(`effect:checkpoint.capture:${runId}`),
                    );
                    assert.deepEqual(yield* identity, identityBefore);
                    assert.deepEqual(
                      Option.getOrThrow(yield* outbox.get("unrelated-exhausted-cleanup")),
                      unrelatedBefore,
                    );
                    assert.equal(recovered.status, "pending");
                    assert.equal(recovered.attemptCount, 5);
                    assert.isTrue(
                      recovered.request.type === "checkpoint.capture" &&
                        recovered.request.historicalRefOnly,
                    );
                    assert.equal((yield* recovery.recover).terminalizedRuns, 0);
                    assert.isFalse(yield* outbox.recoverFailedCheckpoint(recovered));
                    // Simulate process loss after requeue, before retry.
                    const claimed = Option.getOrThrow(
                      yield* outbox.claimNext({ workerId: "lost-worker", leaseDurationMs: 1000 }),
                    );
                    assert.equal(claimed.id, recovered.id);
                    assert.equal((yield* recovery.recover).requeuedEffects, 1);
                    const replay = Option.getOrThrow(yield* outbox.get(recovered.id));
                    assert.isTrue(
                      replay.request.type === "checkpoint.capture" &&
                        replay.request.historicalRefOnly,
                    );
                  }).pipe(Effect.provide(recoveryLayer));
                }
              }
              const notices = yield* sql<{
                type: string;
                payload_json: string;
              }>`SELECT type, payload_json
                FROM orchestration_v2_projection_turn_items WHERE type = 'system_notice'`;
              assert.equal(notices.length, scenario === "append-failure" ? 1 : 0);
              if (notices[0]) assert.include(notices[0].payload_json, "Queued messages are held");
              yield* sql.unsafe("DROP TRIGGER checkpoint_append_unavailable");
              // Only checkpoint finalization is retried after storage recovers.
              assert.isTrue(yield* worker.runOnce);
              assert.equal(providerStarts, 0);
              const recovered = Option.getOrThrow(
                yield* outbox.get(`effect:checkpoint.capture:${runId}`),
              );
              assert.equal(recovered.status, "succeeded");
              assert.equal(recovered.attemptCount, scenario === "legacy-exhausted" ? 8 : 7);
              const finalized = yield* projectionStore.getCheckpointCaptureContext(threadId, {
                runId,
                scopeId,
              });
              assert.equal(finalized.run?.status, "completed");
              assert.equal(finalized.run?.checkpointId, captured.id);
              assert.equal(finalized.rootNode?.status, "completed");
              assert.deepEqual(finalized.run?.delegatedCompletion, staleDelegatedCompletion);
              const queued = Option.getOrThrow(yield* outbox.get("queued-followup"));
              assert.equal(
                queued.status,
                scenario === "legacy-exhausted" ? "cancelled" : "pending",
              );
              assert.equal(queued.attemptCount, 0);
              const items = yield* sql<{
                type: string;
              }>`SELECT type FROM orchestration_v2_projection_turn_items
                WHERE type IN ('checkpoint', 'system_notice')`;
              assert.deepEqual(
                items.map((item) => item.type),
                ["checkpoint"],
              );
              if (scenario === "legacy-exhausted") {
                // Startup retires process-bound starts. Recovery must not revive
                // one: only a later legitimate queue resume may enqueue new work.
                assert.isFalse(yield* worker.runOnce);
                assert.equal(providerStarts, 0);
              } else {
                assert.isTrue(yield* worker.runOnce);
                assert.equal(providerStarts, 1);
              }
              assert.equal(
                originalProviderStarts,
                1,
                "recovery must never replay the completed provider turn",
              );
            }).pipe(Effect.provide(workerLayer));
          } else {
            yield* service.execute({ threadId, runId, scopeId });
          }

          const events = yield* Ref.get(committed);
          const runUpdated = events.find((event) => event.type === "run.updated");
          assert.isDefined(runUpdated);
          if (runUpdated?.type !== "run.updated") {
            return;
          }
          assert.equal(runUpdated.payload.status, "completed");
          assert.equal(runUpdated.payload.checkpointId, captured.id);
          assert.isUndefined(
            runUpdated.payload.delegatedCompletion,
            "checkpoint capture must omit delegatedCompletion so ProjectionStore can keep a newer cohort",
          );

          yield* projectionStore.apply({
            id: EventId.make("event:checkpoint-capture:newer-cohort"),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId,
            occurredAt: later,
            payload: {
              ...staleRun,
              delegatedCompletion: newerCohort,
            },
          });

          yield* projectionStore.apply(runUpdated);

          const projectedRun = (yield* projectionStore.getCheckpointCaptureContext(threadId, {
            runId,
            scopeId,
          })).run;
          assert.isDefined(projectedRun);
          assert.equal(projectedRun?.status, "completed");
          assert.equal(projectedRun?.checkpointId, runUpdated.payload.checkpointId);
          assert.deepEqual(projectedRun?.delegatedCompletion, newerCohort);
          assert.equal(projectedRun?.delegatedCompletion?.delivery?.messageId, deliveryMessageId);
          assert.deepEqual(projectedRun?.delegatedCompletion?.delivery?.taskIds, [taskId]);
          yield* Ref.set(committed, []);
          yield* service.execute({ threadId, runId, scopeId });
          assert.deepEqual(yield* Ref.get(committed), []);
        }).pipe(Effect.provide(layerCapture));
      }).pipe(Effect.provide(Layer.fresh(layerProjectionStoreTest))),
  );

  it.effect("does not capture a stopped run that a rollback already discarded", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const stoppedThreadId = ThreadId.make("thread:checkpoint-capture-rolled-back");
      const stoppedRunId = RunId.make("run:checkpoint-capture-rolled-back");
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-rolled-back:thread"),
        type: "thread.created",
        threadId: stoppedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: stoppedThreadId,
          projectId,
          title: "Checkpoint capture after rollback",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: stoppedThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const stoppedRun: OrchestrationV2Run = {
        id: stoppedRunId,
        threadId: stoppedThreadId,
        ordinal: 2,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("message:checkpoint-capture-rolled-back"),
        rootNodeId,
        activeAttemptId: null,
        status: "interrupted",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-rolled-back:run"),
        type: "run.updated",
        threadId: stoppedThreadId,
        runId: stoppedRunId,
        providerInstanceId,
        occurredAt: now,
        payload: { ...stoppedRun, status: "rolled_back" },
      });

      const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              materializeBaselineCheckpoint: () => Effect.die("a discarded run has no baseline"),
              capture: () => Effect.die("a discarded run must not be captured"),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
            }),
          ),
        ),
      );

      yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
        Effect.flatMap((service) =>
          service.execute({ threadId: stoppedThreadId, runId: stoppedRunId, scopeId }),
        ),
        Effect.provide(layerCapture),
      );

      assert.deepEqual(yield* Ref.get(committed), []);
      const projected = yield* projectionStore.getCheckpointCaptureContext(stoppedThreadId, {
        runId: stoppedRunId,
        scopeId,
      });
      assert.equal(projected.run?.status, "rolled_back");
      assert.isNull(projected.run?.checkpointId ?? null);
    }),
  );

  it.effect("records the checkpoint of a cancelled run and keeps it cancelled", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const cancelledAt = DateTime.add(now, { seconds: 1 });
      const cancelledThreadId = ThreadId.make("thread:checkpoint-capture-cancelled");
      const cancelledRunId = RunId.make("run:checkpoint-capture-cancelled");
      const cancelledScopeId = CheckpointScopeId.make("scope:checkpoint-capture-cancelled");
      const cancelledRootNodeId = NodeId.make("node:checkpoint-capture-cancelled-root");
      const cancelledProviderThreadId = ProviderThreadId.make(
        "provider-thread:checkpoint-capture-cancelled",
      );
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:thread"),
        type: "thread.created",
        threadId: cancelledThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: cancelledThreadId,
          projectId,
          title: "Checkpoint capture after cancel",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: cancelledThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const runningRun: OrchestrationV2Run = {
        id: cancelledRunId,
        threadId: cancelledThreadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: cancelledProviderThreadId,
        userMessageId: MessageId.make("message:checkpoint-capture-cancelled"),
        rootNodeId: cancelledRootNodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const runningRootNode = {
        id: cancelledRootNodeId,
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        parentNodeId: null,
        rootNodeId: cancelledRootNodeId,
        kind: "root_turn" as const,
        status: "running" as const,
        countsForRun: true,
        providerThreadId: cancelledProviderThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: cancelledScopeId,
        startedAt: now,
        completedAt: null,
      };
      const scope = {
        id: cancelledScopeId,
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        parentScopeId: null,
        providerThreadId: cancelledProviderThreadId,
        kind: "root_run" as const,
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo",
        createdAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:provider-thread"),
        type: "provider-thread.updated",
        threadId: cancelledThreadId,
        nodeId: cancelledRootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: cancelledProviderThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: cancelledThreadId,
          ownerNodeId: cancelledRootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:scope"),
        type: "checkpoint-scope.created",
        threadId: cancelledThreadId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        occurredAt: now,
        payload: scope,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-cancelled:baseline"),
        type: "checkpoint.captured",
        threadId: cancelledThreadId,
        nodeId: cancelledRootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: CheckpointId.make("checkpoint:cancelled-baseline-0"),
          threadId: cancelledThreadId,
          scopeId: cancelledScopeId,
          runId: null,
          nodeId: cancelledRootNodeId,
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("checkpoint-ref:cancelled-baseline-0"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      });
      for (const [status, completedAt] of [
        ["running", null],
        ["cancelled", cancelledAt],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-cancelled:run-${status}`),
          type: "run.updated",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: completedAt ?? now,
          payload: { ...runningRun, status, completedAt },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:checkpoint-capture-cancelled:node-${status}`),
          type: "node.updated",
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          nodeId: cancelledRootNodeId,
          providerInstanceId,
          occurredAt: completedAt ?? now,
          payload: { ...runningRootNode, status, completedAt },
        });
      }

      const captured = {
        id: CheckpointId.make("checkpoint:cancelled-captured-1"),
        threadId: cancelledThreadId,
        scopeId: cancelledScopeId,
        runId: cancelledRunId,
        nodeId: cancelledRootNodeId,
        parentCheckpointId: CheckpointId.make("checkpoint:cancelled-baseline-0"),
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: CheckpointRef.make("checkpoint-ref:cancelled-captured-1"),
        status: "ready" as const,
        files: [],
        capturedAt: cancelledAt,
      };
      const commits = yield* Ref.make(0);
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              captureBaseline: () => Effect.void,
              materializeBaselineCheckpoint: () =>
                Effect.die("baseline materialization must be skipped when ordinal 0 is ready"),
              capture: () => Effect.succeed(captured),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Effect.forEach(input.events, (event) => projectionStore.apply(event)).pipe(
                  Effect.andThen(Ref.update(commits, (count) => count + 1)),
                  Effect.as({ committed: true } as never),
                  Effect.orDie,
                ),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
        yield* service.execute({
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
        yield* service.execute({
          threadId: cancelledThreadId,
          runId: cancelledRunId,
          scopeId: cancelledScopeId,
        });
      }).pipe(Effect.provide(layerCapture));

      assert.equal(yield* Ref.get(commits), 1);
      const projected = yield* projectionStore.getCheckpointCaptureContext(cancelledThreadId, {
        runId: cancelledRunId,
        scopeId: cancelledScopeId,
      });
      assert.equal(projected.run?.status, "cancelled");
      assert.equal(projected.run?.checkpointId, captured.id);
      const completedAt = projected.run?.completedAt;
      assert.equal(
        completedAt ? DateTime.formatIso(completedAt) : completedAt,
        DateTime.formatIso(cancelledAt),
      );
      assert.equal(projected.rootNode?.status, "cancelled");
      assert.deepEqual([...projected.readyCheckpointOrdinals].toSorted(), [0, 1]);
    }),
  );
});

it.effect(
  "keeps a completed turn's identity when its missing checkpoint is re-materialized",
  () => {
    const firstRunId = RunId.make("run:capture-outside-git:1");
    const secondRunId = RunId.make("run:capture-outside-git:2");
    const outsideGitScopeId = CheckpointScopeId.make("scope:capture-outside-git");
    const nodeId = NodeId.make("node:capture-outside-git");
    const committed: Array<OrchestrationV2DomainEvent> = [];
    const baselineFor = (ordinalWithinScope: number) => ({
      id: CheckpointId.make(`checkpoint:outside-git:${ordinalWithinScope}`),
      threadId,
      scopeId: outsideGitScopeId,
      runId: null,
      nodeId,
      parentCheckpointId: null,
      ordinalWithinScope,
      appRunOrdinal: null,
      ref: CheckpointRef.make(`checkpoint-ref:outside-git:${ordinalWithinScope}`),
      status: "missing" as const,
      files: [],
      capturedAt: DateTime.makeUnsafe("2026-09-24T00:00:00Z"),
    });
    const layer = CheckpointCaptureService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed({} as never),
            getCheckpointCaptureContext: () =>
              Effect.succeed({
                run: {
                  id: secondRunId,
                  ordinal: 2,
                  status: "waiting",
                  checkpointId: null,
                  providerInstanceId,
                  delegatedCompletion: null,
                },
                rootNode: { id: nodeId, checkpointScopeId: outsideGitScopeId },
                scope: { id: outsideGitScopeId, kind: "root_run", cwd: "/outside-git" },
                providerThread: { driver },
                readyCheckpointOrdinals: [],
                turnCheckpoints: [{ ordinalWithinScope: 1, runId: firstRunId, appRunOrdinal: 1 }],
              } as never),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            materializeBaselineCheckpoint: ({ ordinalWithinScope }) =>
              Effect.succeed(baselineFor(ordinalWithinScope)),
            capture: () =>
              Effect.succeed({ ...baselineFor(2), runId: secondRunId, appRunOrdinal: 2 }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) =>
              Effect.sync(() => {
                committed.push(...input.events);
                return {
                  commandId: input.commandId,
                  committed: true,
                  sequence: 1,
                  events: input.events,
                  effects: [],
                } as never;
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
      yield* service.execute({ threadId, runId: secondRunId, scopeId: outsideGitScopeId });
      const captured = committed.flatMap((event) =>
        event.type === "checkpoint.captured" ? [event.payload] : [],
      );
      const firstTurn = captured.find((checkpoint) => checkpoint.ordinalWithinScope === 1);
      assert.equal(firstTurn?.runId, firstRunId);
      assert.equal(firstTurn?.appRunOrdinal, 1);
      const threadStart = captured.find((checkpoint) => checkpoint.ordinalWithinScope === 0);
      assert.equal(threadStart?.runId, null);
      assert.equal(threadStart?.appRunOrdinal, null);
    }).pipe(Effect.provide(layer));
  },
);

it.effect.each(["interrupted", "failed", "cancelled"] as const)(
  "checkpoints a %s turn without changing its terminal status",
  (status) => {
    const terminalRunId = RunId.make(`run:capture-${status}:1`);
    const terminalScopeId = CheckpointScopeId.make(`scope:capture-${status}`);
    const nodeId = NodeId.make(`node:capture-${status}`);
    const committed: Array<OrchestrationV2DomainEvent> = [];
    const baselineCaptures: Array<number> = [];
    const captureInputs: Array<{ readonly keepExistingRef?: boolean }> = [];
    const checkpointFor = (ordinalWithinScope: number) => ({
      id: CheckpointId.make(`checkpoint:${status}:${ordinalWithinScope}`),
      threadId,
      scopeId: terminalScopeId,
      runId: ordinalWithinScope === 0 ? null : terminalRunId,
      nodeId,
      parentCheckpointId: null,
      ordinalWithinScope,
      appRunOrdinal: ordinalWithinScope === 0 ? null : ordinalWithinScope,
      ref: CheckpointRef.make(`checkpoint-ref:${status}:${ordinalWithinScope}`),
      status: "ready" as const,
      files: [],
      capturedAt: DateTime.makeUnsafe("2026-09-25T00:00:00Z"),
    });
    const run = {
      id: terminalRunId,
      ordinal: 1,
      status,
      checkpointId: null as CheckpointId | null,
      completedAt: DateTime.makeUnsafe("2026-09-25T00:00:00Z"),
      providerInstanceId,
      delegatedCompletion: null,
    };
    const layer = CheckpointCaptureService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed({} as never),
            getCheckpointCaptureContext: () =>
              Effect.succeed({
                run,
                rootNode: {
                  id: nodeId,
                  status,
                  checkpointScopeId: terminalScopeId,
                },
                scope: { id: terminalScopeId, kind: "root_run", cwd: "/repo" },
                providerThread: { driver },
                readyCheckpointOrdinals: [],
                turnCheckpoints: [],
              } as never),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureBaseline: ({ ordinalWithinScope }) =>
              Effect.sync(() => {
                baselineCaptures.push(ordinalWithinScope);
              }),
            materializeBaselineCheckpoint: ({ ordinalWithinScope }) =>
              Effect.succeed(checkpointFor(ordinalWithinScope)),
            capture: (input) =>
              Effect.sync(() => {
                captureInputs.push(input);
                return checkpointFor(input.ordinalWithinScope);
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            commitCommand: (input) =>
              Effect.sync(() => {
                committed.push(...input.events);
                return {
                  commandId: input.commandId,
                  committed: true,
                  sequence: 1,
                  events: input.events,
                  effects: [],
                } as never;
              }),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
      yield* service.execute({
        threadId,
        runId: terminalRunId,
        scopeId: terminalScopeId,
        historicalRefOnly: true,
      });
      assert.deepEqual(captureInputs, []);
      assert.deepEqual(baselineCaptures, []);
      assert.deepEqual(committed, []);
      yield* service.execute({ threadId, runId: terminalRunId, scopeId: terminalScopeId });

      // The rewrite target (the thread start) exists even if the stop beat the run's baseline.
      assert.deepEqual(baselineCaptures, [0]);
      assert.deepEqual(
        committed.flatMap((event) =>
          event.type === "checkpoint.captured" ? [event.payload.ordinalWithinScope] : [],
        ),
        [0, 1],
      );
      assert.equal(captureInputs[0]?.keepExistingRef, true);
      const runUpdated = committed.find((event) => event.type === "run.updated");
      assert.equal(runUpdated?.type === "run.updated" && runUpdated.payload.status, status);
      assert.equal(
        runUpdated?.type === "run.updated" && runUpdated.payload.checkpointId,
        checkpointFor(1).id,
      );
      // The terminal root node already holds its status and scope.
      assert.isFalse(committed.some((event) => event.type === "node.updated"));

      committed.length = 0;
      run.checkpointId = checkpointFor(1).id;
      yield* service.execute({ threadId, runId: terminalRunId, scopeId: terminalScopeId });
      assert.deepEqual(committed, []);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "denies late frozen capture before context, baseline materialization or ref writes",
  () => {
    let workspaceCalls = 0;
    const deny = () =>
      Effect.sync(() => {
        workspaceCalls++;
        throw new Error("Frozen workspace write");
      });
    return Effect.gen(function* () {
      const capture = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
      for (const historicalRefOnly of [false, true]) {
        yield* capture.execute({ threadId, runId, scopeId, historicalRefOnly });
      }
      assert.equal(workspaceCalls, 0);
    }).pipe(
      Effect.provide(
        CheckpointCaptureService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: () => Effect.succeed({ preservationOnly: true } as never),
                getCheckpointCaptureContext: deny,
              }),
              Layer.mock(CheckpointService.CheckpointServiceV2)({
                capture: deny,
                captureBaseline: deny,
                materializeBaselineCheckpoint: deny,
              }),
              Layer.mock(EventSink.EventSinkV2)({ commitCommand: deny }),
              IdAllocator.layer,
            ),
          ),
        ),
      ),
    );
  },
);
