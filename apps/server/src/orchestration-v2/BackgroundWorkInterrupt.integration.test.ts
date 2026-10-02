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
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
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

const makeScenario = (name: string, capabilities: OrchestrationV2ProviderCapabilities) =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make(
      capabilities === ClaudeProviderCapabilitiesV2 ? "claudeAgent" : "codex",
    );
    const instanceId = ProviderInstanceId.make(driver);
    const modelSelection = { instanceId, model: "test-model" };
    const cwd = yield* checkpointWorkspace(name);
    const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const started: ProviderAdapterV2TurnInput[] = [];
    const calls: string[] = [];
    // Session-wide work, such as Claude's background subagents or, on a
    // shared session, another thread's work.
    let sessionHasBackgroundWork = false;
    const adapter: ProviderAdapterV2Shape = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
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
              capabilities,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            hasPendingBackgroundWork: Effect.sync(() => sessionHasBackgroundWork),
            hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
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

    const layer = makeOrchestratorV2ReplayLayerWithRegistry({ name }, makeSingleLayer(adapter), {
      runEffectWorker: false,
    });
    const run = <A, E, R>(body: Effect.Effect<A, E, R>) => body.pipe(Effect.provide(layer));

    const helpers = Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const worker = yield* OrchestrationEffectWorkerV2;
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
      const createThread = (threadId: ThreadId) =>
        orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${threadId}`),
          threadId,
          projectId: ProjectId.make(`project:${name}`),
          title: name,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
      const dispatchMessage = (threadId: ThreadId, index: number) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`message:${threadId}:${index}`),
          threadId,
          messageId: MessageId.make(`message:${threadId}:${index}`),
          text: `turn ${index}`,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      // Runs one user turn to completion, optionally leaving a running subagent item.
      const completeTurn = Effect.fn(function* (
        threadId: ThreadId,
        index: number,
        leaveSubagent: boolean,
      ) {
        const turnStarted = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.threadId === threadId &&
            event.payload.status === "running",
        );
        yield* dispatchMessage(threadId, index);
        yield* worker.drain();
        yield* Fiber.join(turnStarted);
        const turn = started.at(-1)!;
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
        yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
        if (leaveSubagent) {
          sessionHasBackgroundWork = true;
          yield* Queue.offer(events, {
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: TurnItemId.make(`turn-item:background-subagent:${threadId}`),
              threadId,
              runId: turn.runId,
              nodeId: turn.rootNodeId,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              nativeItemRef: { driver, nativeId: `task:${threadId}`, strength: "strong" },
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: "Background subagent",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "subagent",
              subagentId: NodeId.make(`node:background-subagent:${threadId}`),
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
      const stop = (threadId: ThreadId, runId: RunId, commandId = `stop:${threadId}`) =>
        orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(commandId),
          threadId,
          runId,
          holdQueue: true,
        });
      return { orchestrator, worker, createThread, dispatchMessage, completeTurn, stop };
    });

    return { calls, run, helpers };
  });

// Run 1 leaves a native background subagent running; run 2 completes. Stop
// targets the latest run, as the UI's Waiting banner does.
it.effect.each([
  {
    withBackgroundWork: true,
    title: "interrupting the latest run stops a subagent an earlier run left running",
  },
  {
    withBackgroundWork: false,
    title: "interrupting a settled run without background work still fails",
  },
])("$title", ({ withBackgroundWork }) => {
  const name = `background-work-interrupt-${String(withBackgroundWork)}`;
  return Effect.scoped(
    Effect.gen(function* () {
      const { calls, run, helpers } = yield* makeScenario(name, ClaudeProviderCapabilitiesV2);
      yield* run(
        Effect.gen(function* () {
          const { orchestrator, worker, createThread, completeTurn, stop } = yield* helpers;
          const threadId = ThreadId.make(`thread:${name}`);
          yield* createThread(threadId);
          yield* completeTurn(threadId, 0, withBackgroundWork);
          const latestRunId = yield* completeTurn(threadId, 1, false);

          if (!withBackgroundWork) {
            const failure = yield* Effect.flip(stop(threadId, latestRunId));
            assert.instanceOf(failure, OrchestratorDispatchError);
            assert.equal(failure.cause, `Run ${latestRunId} is not interruptible.`);
            return;
          }
          yield* stop(threadId, latestRunId);
          yield* worker.drain();

          const projection = yield* orchestrator.getThreadProjection(threadId);
          const subagent = projection.turnItems.find((item) => item.type === "subagent");
          assert.equal(subagent?.status, "interrupted");
          assert.deepEqual(calls, ["interruptTurn"]);
        }),
      );
    }),
  );
});

it.effect(
  "interrupting a latest run stopped before its provider turn still stops earlier background work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "background-work-interrupt-prestart";
        const { calls, run, helpers } = yield* makeScenario(name, ClaudeProviderCapabilitiesV2);
        yield* run(
          Effect.gen(function* () {
            const { orchestrator, worker, createThread, dispatchMessage, completeTurn, stop } =
              yield* helpers;
            const threadId = ThreadId.make(`thread:${name}`);
            yield* createThread(threadId);
            yield* completeTurn(threadId, 0, true);
            // Interrupted before the worker starts its provider turn.
            yield* dispatchMessage(threadId, 1);
            const latestRunId = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.id;
            yield* stop(threadId, latestRunId, "stop:prestart");
            yield* worker.drain();
            const interrupted = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(interrupted.runs.at(-1)?.status, "interrupted");
            assert.equal(
              interrupted.turnItems.find((item) => item.type === "subagent")?.status,
              "running",
            );

            yield* stop(threadId, latestRunId);
            yield* worker.drain();

            const projection = yield* orchestrator.getThreadProjection(threadId);
            const subagent = projection.turnItems.find((item) => item.type === "subagent");
            assert.equal(subagent?.status, "interrupted");
            assert.deepEqual(calls, ["interruptTurn"]);
          }),
        );
      }),
    ),
);

it.effect("stopping one thread's background work leaves a shared session running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "background-work-interrupt-shared-session";
      const { calls, run, helpers } = yield* makeScenario(name, CodexProviderCapabilitiesV2);
      yield* run(
        Effect.gen(function* () {
          const { orchestrator, worker, createThread, completeTurn, stop } = yield* helpers;
          const threadA = ThreadId.make(`thread:${name}:a`);
          const threadB = ThreadId.make(`thread:${name}:b`);
          yield* createThread(threadA);
          yield* createThread(threadB);
          const runA = yield* completeTurn(threadA, 0, true);
          // Thread B's work also keeps the session-wide probe true.
          yield* completeTurn(threadB, 0, true);
          const sessionId = (yield* orchestrator.getThreadProjection(threadA)).providerSessions[0]
            ?.id;
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadB)).providerSessions[0]?.id,
            sessionId,
          );

          yield* stop(threadA, runA);
          yield* worker.drain();

          assert.notInclude(calls, "session closed");
          const projectionB = yield* orchestrator.getThreadProjection(threadB);
          assert.notEqual(projectionB.providerSessions[0]?.status, "stopped");
          assert.equal(
            projectionB.turnItems.find((item) => item.type === "subagent")?.status,
            "running",
          );
        }),
      );
    }),
  ),
);
