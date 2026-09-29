import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { OrchestratorDispatchError, OrchestratorV2 } from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import { makeSingleLayer } from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

// Run 1 leaves a native background subagent running; run 2 completes. Stop
// targets the latest run, as the UI's Waiting banner does.
for (const withBackgroundWork of [true, false]) {
  it.effect(
    withBackgroundWork
      ? "interrupting the latest run stops a subagent an earlier run left running"
      : "interrupting a settled run without background work still fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace(
            `background-work-interrupt-${String(withBackgroundWork)}`,
          );
          const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
          const started: ProviderAdapterV2TurnInput[] = [];
          const calls: string[] = [];
          let subagentRunning = false;
          const adapter: ProviderAdapterV2Shape = {
            instanceId,
            driver,
            getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
            planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
            openSession: (input) =>
              Effect.gen(function* () {
                const now = yield* DateTime.now;
                yield* Effect.addFinalizer(() => Effect.sync(() => calls.push("session closed")));
                return {
                  instanceId,
                  driver,
                  providerSessionId: input.providerSessionId,
                  providerSession: {
                    id: input.providerSessionId,
                    driver,
                    providerInstanceId: instanceId,
                    status: "ready",
                    cwd,
                    model: modelSelection.model,
                    capabilities: ClaudeProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  events: Stream.fromQueue(events),
                  // Claude keeps background subagents off the thread roster.
                  hasPendingBackgroundWork: Effect.sync(() => subagentRunning),
                  hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
                  ensureThread: ({ threadId }) =>
                    Effect.succeed({
                      id: ProviderThreadId.make(`provider-thread:${threadId}`),
                      driver,
                      providerInstanceId: instanceId,
                      providerSessionId: input.providerSessionId,
                      appThreadId: threadId,
                      ownerNodeId: null,
                      nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                      nativeConversationHeadRef: null,
                      status: "idle",
                      firstRunOrdinal: null,
                      lastRunOrdinal: null,
                      handoffIds: [],
                      forkedFrom: null,
                      createdAt: now,
                      updatedAt: now,
                    }),
                  resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                  startTurn: (turn) =>
                    Effect.sync(() => {
                      started.push(turn);
                    }),
                  steerTurn: () => Effect.die("unused"),
                  interruptTurn: () => Effect.sync(() => calls.push("interruptTurn")),
                  respondToRuntimeRequest: () => Effect.void,
                  readThreadSnapshot: () => Effect.die("unused"),
                  rollbackThread: () => Effect.die("unused"),
                  forkThread: () => Effect.die("unused"),
                };
              }),
          };
          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const threadId = ThreadId.make("thread:background-work-interrupt");
            const sink = yield* EventSinkV2;
            // Reads the cursor before forking so an event committed while the
            // watcher starts is not missed.
            const watch = Effect.fn(function* (
              predicate: (event: OrchestrationV2DomainEvent) => boolean,
            ) {
              const afterSequence = yield* sink.latestSequence();
              return yield* sink.stream({ afterSequence }).pipe(
                Stream.filter((stored) => predicate(stored.event)),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            });
            // Runs one user turn to completion, optionally leaving a running subagent item.
            const completeTurn = Effect.fn(function* (index: number, leaveSubagent: boolean) {
              const turnStarted = yield* watch(
                (event) => event.type === "run.updated" && event.payload.status === "running",
              );
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`message:${index}`),
                threadId,
                messageId: MessageId.make(`message:${index}`),
                text: `turn ${index}`,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              yield* worker.drain();
              yield* Fiber.join(turnStarted);
              const turn = started[index]!;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
              const now = yield* DateTime.now;
              const providerTurn = {
                id: providerTurnId,
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: now,
                completedAt: null,
              } as const;
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn,
              });
              if (leaveSubagent) {
                subagentRunning = true;
                yield* Queue.offer(events, {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make("turn-item:background-subagent"),
                    threadId,
                    runId: turn.runId,
                    nodeId: turn.rootNodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    nativeItemRef: { driver, nativeId: "task-1", strength: "strong" },
                    parentItemId: null,
                    ordinal: 1,
                    status: "running",
                    title: "Background subagent",
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                    type: "subagent",
                    subagentId: NodeId.make("node:background-subagent"),
                    origin: "provider_native",
                    driver,
                    providerInstanceId: instanceId,
                    childThreadId: null,
                    prompt: "sleep then report",
                    result: null,
                  },
                });
              }
              const waiting = yield* watch(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === turn.runId &&
                  event.payload.status === "waiting",
              );
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...providerTurn, status: "completed", completedAt: now },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
              yield* Fiber.join(waiting);
              // Checkpoint capture flips waiting to completed.
              yield* worker.drain();
              return turn.runId;
            });

            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create"),
              threadId,
              projectId: ProjectId.make("project:background-work-interrupt"),
              title: "Background work interrupt",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            yield* completeTurn(0, withBackgroundWork);
            const latestRunId: RunId = yield* completeTurn(1, false);

            const interrupt = orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("stop"),
              threadId,
              runId: latestRunId,
              holdQueue: true,
            });
            if (!withBackgroundWork) {
              const failure = yield* Effect.flip(interrupt);
              assert.instanceOf(failure, OrchestratorDispatchError);
              assert.equal(failure.cause, `Run ${latestRunId} is not interruptible.`);
              return;
            }
            yield* interrupt;
            yield* worker.drain();

            const projection = yield* orchestrator.getThreadProjection(threadId);
            const subagent = projection.turnItems.find((item) => item.type === "subagent");
            assert.equal(subagent?.status, "cancelled");
            assert.deepEqual(calls, ["session closed"]);
            assert.equal(projection.providerSessions[0]?.status, "stopped");
          }).pipe(
            Effect.provide(
              makeOrchestratorV2ReplayLayerWithRegistry(
                { name: `background-work-interrupt-${String(withBackgroundWork)}` },
                makeSingleLayer(adapter),
                { runEffectWorker: false },
              ),
            ),
          );
        }),
      ),
  );
}
