import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "fixture-model" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No real provider is allowed in these admission tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "full-access-admission" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const createThread = (id: string, runtimeMode: RuntimeMode = "full-access") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(id);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${id}`),
      threadId,
      projectId: ProjectId.make("test-project"),
      title: "Test",
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

const permission = (input: {
  readonly id: string;
  readonly automatic?: boolean;
  readonly stopped?: boolean;
}) =>
  Effect.gen(function* () {
    const threadId = yield* createThread(input.id);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const sessionId = ProviderSessionId.make(`session:${input.id}`);
    const requestId = RuntimeRequestId.make(`request:${input.id}`);
    const nodeId = NodeId.make(`node:${input.id}`);
    const base = { threadId, occurredAt: now };
    const request = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: input.automatic === false ? ("user_input" as const) : ("command" as const),
      status: "pending" as const,
      responseCapability: { type: "live" as const, providerSessionId: sessionId },
      createdAt: now,
      resolvedAt: null,
      ...(input.automatic === false
        ? {}
        : { automaticDecision: { policy: "full-access" as const, decision: "accept" as const } }),
    };
    yield* projections.apply({
      ...base,
      id: EventId.make(`session-event:${input.id}`),
      type: "provider-session.attached",
      payload: {
        id: sessionId,
        driver: adapter.driver,
        providerInstanceId: instanceId,
        status: input.stopped ? "stopped" : "ready",
        cwd: "/test-fixture",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    const node = {
      id: nodeId,
      threadId,
      runId: null,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "approval_request" as const,
      status: "waiting" as const,
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    yield* projections.apply({
      ...base,
      id: EventId.make(`node-event:${input.id}`),
      type: "node.updated",
      payload: node,
    });
    yield* projections.apply({
      ...base,
      id: EventId.make(`item-event:${input.id}`),
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`item:${input.id}`),
        threadId,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        requestId,
        requestKind: "command",
        prompt: "echo fixture",
      },
    });
    const event = {
      ...base,
      id: EventId.make(`request-event:${input.id}`),
      type: "runtime-request.updated" as const,
      payload: request,
    };
    return { threadId, sessionId, requestId, sink, projections, event };
  });

it.effect("normalizes legacy internal launch preferences, but never raises a dispatch grant", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const id = yield* createThread("legacy-selection", "auto");
    assert.equal((yield* projections.getThread(id)).runtimeMode, "full-access");
    const denied = yield* createThread("limited-grant", "auto").pipe(
      Effect.provideService(DispatchModeLimit, { runtimeMode: "auto", interactionMode: "default" }),
      Effect.flip,
    );
    assert.equal(denied._tag, "OrchestratorThreadAboveModeLimitError");
    assert.isNull(yield* projections.getThreadShell(ThreadId.make("limited-grant")));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "records one automatic decision with exact routing and one outbox effect, not tool execution",
  () =>
    Effect.gen(function* () {
      const h = yield* permission({ id: "automatic" });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const afterSequence = yield* h.sink.latestSequence();
      const decided = yield* h.sink
        .stream({ afterSequence, eventType: "runtime-request.updated" })
        .pipe(
          Stream.filter(
            (s) =>
              s.event.type === "runtime-request.updated" &&
              s.event.payload.id === h.requestId &&
              s.event.payload.status === "resolved",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
      yield* h.sink.write({ events: [h.event] });
      assert.isTrue(Option.isSome(yield* Fiber.join(decided)));
      const commandId = CommandId.make(
        `command:full-access-permission:${h.sessionId}:${h.requestId}`,
      );
      const replay = yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        threadId: h.threadId,
        requestId: h.requestId,
        commandId,
        decision: "accept",
      });
      assert.isTrue(replay.replayed);
      const effects = yield* outbox.listByCommandId(commandId);
      assert.lengthOf(effects, 1);
      assert.deepEqual(effects[0]?.request, {
        type: "runtime-request.respond",
        providerSessionId: h.sessionId,
        requestId: h.requestId,
        decision: "accept",
      });
      const request = yield* h.projections.getRuntimeRequest(h.threadId, h.requestId);
      assert.equal(request?.decision, "accept");
      assert.equal(
        effects[0]?.status,
        "pending",
        "a recorded decision is not a delivered decision or an executed tool",
      );
      yield* h.sink.write({
        events: [{ ...h.event, id: EventId.make("duplicate-after-resolution") }],
        guardPendingUserInputCancellations: true,
      });
      assert.equal(
        (yield* h.projections.getRuntimeRequest(h.threadId, h.requestId))?.status,
        "resolved",
      );
      const raced = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          threadId: h.threadId,
          requestId: h.requestId,
          commandId: CommandId.make("manual-race"),
          decision: "decline",
        })
        .pipe(Effect.result);
      assert.equal(raced._tag, "Failure");
      assert.isEmpty(yield* outbox.listByCommandId(CommandId.make("manual-race")));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "ordinary questions stay pending and stopped-session permissions fail without a blocking approval",
  () =>
    Effect.gen(function* () {
      const question = yield* permission({ id: "question", automatic: false });
      yield* question.sink.write({ events: [question.event] });
      assert.equal(
        (yield* question.projections.getRuntimeRequest(question.threadId, question.requestId))
          ?.status,
        "pending",
      );
      const stopped = yield* permission({ id: "stopped", stopped: true });
      const afterSequence = yield* stopped.sink.latestSequence();
      const failed = yield* stopped.sink
        .stream({ afterSequence, eventType: "runtime-request.updated" })
        .pipe(
          Stream.filter(
            (s) =>
              s.event.type === "runtime-request.updated" &&
              s.event.payload.id === stopped.requestId &&
              s.event.payload.status === "expired",
          ),
          Stream.runHead,
          Effect.forkChild,
        );
      yield* stopped.sink.write({ events: [stopped.event] });
      assert.isTrue(Option.isSome(yield* Fiber.join(failed)));
      const request = yield* stopped.projections.getRuntimeRequest(
        stopped.threadId,
        stopped.requestId,
      );
      assert.isUndefined(request?.decision, "no false acceptance is recorded on failed admission");
      assert.equal(request?.responseCapability.type, "not_resumable");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "serializes racing native decisions through one command receipt and one outbox effect",
  () =>
    Effect.gen(function* () {
      const h = yield* permission({ id: "race" });
      yield* h.projections.apply(h.event);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const results = yield* Effect.all(
        ["accept", "decline"].map((decision) =>
          orchestrator
            .dispatch({
              type: "runtime-request.respond",
              threadId: h.threadId,
              requestId: h.requestId,
              commandId: CommandId.make(`race:${decision}`),
              decision: decision as "accept" | "decline",
            })
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const accept = yield* outbox.listByCommandId(CommandId.make("race:accept"));
      const decline = yield* outbox.listByCommandId(CommandId.make("race:decline"));
      assert.equal(accept.length + decline.length, 1);
    }).pipe(Effect.provide(layer)),
);
