import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makePiFamilyAdapter } from "./adapter.ts";
import { makeOmpRecordNormalizer, OMP_RPC_FLAVOR, ompGoalFromNative } from "./omp.ts";
import type { PiRpcRecord } from "./rpc.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const decodeJsonLine = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const OMP_INSTANCE_ID = ProviderInstanceId.make("omp_sparks");
const THREAD_ID = ThreadId.make("thread-omp-test");
const SESSION_ID = ProviderSessionId.make("provider-session-omp-test");
const SESSION_FILE = "/fake/.omp/agent/sessions/--workspace--/0001_omp.jsonl";
const MODEL = "sparksdirect/GLM-5.3-Flash-EXL3";

const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const modelSelection: ModelSelection = { instanceId: OMP_INSTANCE_ID, model: MODEL };

interface FakeOmp {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly emit: (record: PiRpcRecord) => Effect.Effect<void>;
  readonly takeRequest: (type: string) => Effect.Effect<PiRpcRecord>;
  readonly requests: () => ReadonlyArray<PiRpcRecord>;
  /** omp's settle predicate as `get_state` reports it. */
  readonly setSettled: (settled: boolean) => void;
  readonly lastSpawnArgs: () => ReadonlyArray<string>;
}

/**
 * In-process fake `omp --mode rpc` (18.x): acks every id-less `prompt` at
 * once, as omp does, and reports `isSettled` / `goal` in `get_state` the way
 * the selected omp build does.
 */
const makeFakeOmp = (options: { readonly nativeGoals: boolean }) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const requestQueue = yield* Queue.unbounded<PiRpcRecord>();
    const allRequests: Array<PiRpcRecord> = [];
    let settled = true;
    let goal: Record<string, unknown> | null = null;
    let stdinBuffer = "";
    let spawnArgs: ReadonlyArray<string> = [];

    const emit = (record: PiRpcRecord) =>
      Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`)).pipe(
        Effect.asVoid,
      );

    const respond = (record: PiRpcRecord): PiRpcRecord | null => {
      const base = {
        type: "response",
        ...(record["id"] === undefined ? {} : { id: record["id"] }),
        command: String(record["type"]),
        success: true,
      };
      switch (record["type"]) {
        case "prompt":
          return base;
        case "get_state":
          return {
            ...base,
            data: {
              model: { provider: "sparksdirect", id: "GLM-5.3-Flash-EXL3" },
              thinkingLevel: "high",
              isStreaming: !settled,
              isCompacting: false,
              queuedMessageCount: 0,
              hasPendingAsyncWork: false,
              isSettled: settled,
              sessionFile: SESSION_FILE,
              sessionId: "omp-session",
              messageCount: 0,
              ...(options.nativeGoals ? { goal: goal === null ? null : { goal } } : {}),
            },
          };
        case "new_session":
          return { ...base, data: { cancelled: false } };
        case "goal": {
          if (!options.nativeGoals) {
            return { ...base, success: false, error: "Unknown command: goal" };
          }
          switch (record["op"]) {
            case "create":
              goal = {
                id: "goal-1",
                objective: record["objective"],
                status: "active",
                tokensUsed: 0,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 1,
              };
              // omp schedules the first goal turn before answering.
              settled = false;
              break;
            case "drop":
              goal = null;
              break;
          }
          return { ...base, data: { goal, state: goal === null ? null : { goal } } };
        }
        default:
          return record["id"] === undefined ? null : base;
      }
    };

    const handleStdin = (chunk: Uint8Array) =>
      Effect.gen(function* () {
        stdinBuffer += new TextDecoder().decode(chunk);
        while (true) {
          const newline = stdinBuffer.indexOf("\n");
          if (newline === -1) return;
          const line = stdinBuffer.slice(0, newline);
          stdinBuffer = stdinBuffer.slice(newline + 1);
          if (line.length === 0) continue;
          const record = decodeJsonLine(line) as PiRpcRecord;
          allRequests.push(record);
          yield* Queue.offer(requestQueue, record);
          const response = respond(record);
          if (response !== null) yield* emit(response);
        }
      });

    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (ChildProcess.isStandardCommand(command)) spawnArgs = command.args;
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(handleStdin),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );

    return {
      spawner,
      emit,
      takeRequest: (type: string) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* Queue.take(requestQueue);
            if (record["type"] === type) return record;
          }
        }),
      requests: () => allRequests,
      setSettled: (value: boolean) => {
        settled = value;
      },
      lastSpawnArgs: () => spawnArgs,
    } satisfies FakeOmp;
  });

const openOmpRuntime = Effect.fnUntraced(function* (fake: FakeOmp) {
  const offers = yield* Queue.unbounded<ProviderContinuationRequests.ProviderContinuationRequest>();
  const adapter = yield* makePiFamilyAdapter(
    {
      instanceId: OMP_INSTANCE_ID,
      displayName: undefined,
      enabled: true,
      environment: [],
      config: { enabled: true, binaryPath: "omp", launchArgs: "", customModels: [] },
    },
    OMP_RPC_FLAVOR,
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
      offer: (request) => Queue.offer(offers, request).pipe(Effect.asVoid),
      take: Effect.never,
    }),
  );
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection,
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const takeEvent = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(emitted);
        if (predicate(event)) return event;
      }
    });
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection,
    runtimePolicy,
  });
  return { runtime, takeEvent, offers, providerThread };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  text: string,
) {
  const now = yield* DateTime.now;
  const appThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:omp" as OrchestrationV2AppThread["projectId"],
    title: "omp test thread",
    providerInstanceId: OMP_INSTANCE_ID,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
  const runId = RunId.make(`run:${THREAD_ID}:1`);
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${THREAD_ID}:1` as never,
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  });
});

const assistantText = (text: string): ReadonlyArray<PiRpcRecord> => [
  { type: "message_start", message: { role: "assistant" } },
  {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } },
];

describe("omp RPC records", () => {
  it("maps omp's settle and compaction records onto Pi's", () => {
    const normalize = makeOmpRecordNormalizer();
    assert.deepEqual(normalize({ type: "session_settled" }), { type: "agent_settled" });
    assert.deepEqual(normalize({ type: "auto_compaction_end", aborted: false }), {
      type: "compaction_end",
      aborted: false,
    });
  });

  it("acks a prompt with its prompt_result instead of omp's early ack", () => {
    const normalize = makeOmpRecordNormalizer();
    assert.isUndefined(normalize({ type: "response", command: "prompt", success: true }));
    assert.deepEqual(
      normalize({
        type: "prompt_result",
        agentInvoked: true,
        status: "completed",
        sessionSettled: true,
      }),
      { type: "response", command: "prompt", success: true },
    );
  });

  it("reports a rejected prompt once, through its error response", () => {
    const normalize = makeOmpRecordNormalizer();
    assert.isUndefined(normalize({ type: "response", command: "prompt", success: true }));
    const rejection = { type: "response", command: "prompt", success: false, error: "No model" };
    assert.deepEqual(normalize(rejection), rejection);
    assert.isUndefined(
      normalize({ type: "prompt_result", agentInvoked: false, status: "error", error: {} }),
    );
  });

  it("drops omp's dropped goal and maps its budget status", () => {
    assert.isNull(ompGoalFromNative({ objective: "x", status: "dropped" }));
    assert.deepEqual(
      ompGoalFromNative({ objective: "ship", status: "budget-limited", tokensUsed: 12.7 }),
      { objective: "ship", status: "budget_limited", tokensUsed: 12, tokenBudget: null },
    );
  });
});

describe("PiAdapterV2 with the omp flavor", () => {
  it.effect(
    "shows an omp timer wake on the thread and steers a prompt sent during it instead of failing",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeOmp({ nativeGoals: false });
        const { runtime, takeEvent, offers, providerThread } = yield* openOmpRuntime(fake);
        assert.includeMembers([...fake.lastSpawnArgs()], ["--mode", "rpc", "--config"]);

        // T3's turn already ended; a background pytest completion (or a timer
        // wake) starts an omp turn of its own.
        fake.setSettled(false);
        yield* fake.emit({ type: "agent_start" });
        const offer = yield* Queue.take(offers);
        assert.equal(offer.threadId, THREAD_ID);
        yield* takeEvent(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "running",
        );
        for (const record of assistantText("Background pytest passed.")) yield* fake.emit(record);

        // The user (or a delegate_task result delivery) sends a message while
        // omp is still busy with that turn.
        yield* startTurn(runtime, providerThread, "Delegated task reached a terminal state");
        const prompt = yield* fake.takeRequest("prompt");
        assert.equal(prompt["message"], "Delegated task reached a terminal state");
        assert.equal(prompt["streamingBehavior"], "steer");

        const wakeText = yield* takeEvent(
          (event) =>
            event.type === "message.updated" &&
            event.message.text === "Background pytest passed." &&
            !event.message.streaming,
        );
        assert.equal(wakeText.type, "message.updated");

        for (const record of assistantText("Saw the delegated result.")) yield* fake.emit(record);
        fake.setSettled(true);
        yield* fake.emit({ type: "agent_end", messages: [] });
        yield* fake.emit({
          type: "prompt_result",
          agentInvoked: true,
          status: "completed",
          sessionSettled: true,
        });
        yield* fake.emit({ type: "session_settled" });

        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("surfaces a tool approval raised during an omp wake as a pending request", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp({ nativeGoals: false });
      const { takeEvent, offers } = yield* openOmpRuntime(fake);
      fake.setSettled(false);
      yield* fake.emit({ type: "agent_start" });
      yield* Queue.take(offers);
      // The T3 extension's tool_call hook asks before a bash call in
      // Supervised mode, while no T3 turn owns the wake yet.
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-bash-1",
        method: "confirm",
        title: "Allow bash?",
        message: "pytest -q",
      });
      const request = yield* takeEvent((event) => event.type === "runtime_request.updated");
      assert.isTrue(
        request.type === "runtime_request.updated" && request.runtimeRequest.status === "pending",
      );
      assert.isFalse(fake.requests().some((record) => record["type"] === "extension_ui_response"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps the turn open while omp still has background work", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp({ nativeGoals: false });
      const { runtime, takeEvent, providerThread } = yield* openOmpRuntime(fake);
      yield* startTurn(runtime, providerThread, "Run the tests in the background");
      yield* fake.takeRequest("prompt");
      fake.setSettled(false);
      yield* fake.emit({ type: "agent_start" });
      for (const record of assistantText("Started pytest in the background.")) {
        yield* fake.emit(record);
      }
      // A stray settle while the job runs must not end the turn.
      yield* fake.emit({ type: "session_settled" });
      yield* fake.takeRequest("get_state");
      // The job finishes and wakes omp inside the same T3 turn.
      yield* fake.emit({ type: "agent_start" });
      for (const record of assistantText("pytest passed.")) yield* fake.emit(record);
      fake.setSettled(true);
      yield* fake.emit({
        type: "prompt_result",
        agentInvoked: true,
        status: "completed",
        sessionSettled: true,
      });
      yield* fake.emit({ type: "session_settled" });
      const finalText = yield* takeEvent(
        (event) => event.type === "message.updated" && event.message.text === "pytest passed.",
      );
      assert.equal(finalText.type, "message.updated");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("runs /goal on omp's own goal loop when omp supports RPC goals", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp({ nativeGoals: true });
      const { runtime, takeEvent, providerThread } = yield* openOmpRuntime(fake);
      yield* startTurn(runtime, providerThread, "/goal ship the fix");
      const create = yield* fake.takeRequest("goal");
      assert.equal(create["op"], "get");
      const created = yield* fake.takeRequest("goal");
      assert.equal(created["op"], "create");
      assert.equal(created["objective"], "ship the fix");
      const active = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.goal?.status === "active",
      );
      assert.isTrue(
        active.type === "provider_thread.updated" &&
          active.providerThread.goal?.objective === "ship the fix",
      );

      // omp's goal loop runs the goal turn and completes the goal.
      yield* fake.emit({ type: "agent_start" });
      for (const record of assistantText("Fixed and verified.")) yield* fake.emit(record);
      yield* fake.emit({
        type: "goal_updated",
        goal: { objective: "ship the fix", status: "complete", tokensUsed: 40 },
      });
      const complete = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.goal?.status === "complete",
      );
      assert.equal(complete.type, "provider_thread.updated");
      fake.setSettled(true);
      yield* fake.emit({ type: "session_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      assert.isFalse(fake.requests().some((request) => request["type"] === "prompt"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps /goal on T3 for omp builds without RPC goals", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeOmp({ nativeGoals: false });
      const { runtime, takeEvent, providerThread } = yield* openOmpRuntime(fake);
      yield* startTurn(runtime, providerThread, "/goal ship the fix");
      const prompt = yield* fake.takeRequest("prompt");
      assert.include(String(prompt["message"]), "ship the fix");
      assert.notInclude(String(prompt["message"]), "/goal");
      fake.setSettled(false);
      yield* fake.emit({ type: "agent_start" });
      for (const record of assistantText("Done.\nGOAL COMPLETE")) yield* fake.emit(record);
      fake.setSettled(true);
      yield* fake.emit({
        type: "prompt_result",
        agentInvoked: true,
        status: "completed",
        sessionSettled: true,
      });
      yield* fake.emit({ type: "session_settled" });
      const settled = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.goal?.status === "complete",
      );
      assert.equal(settled.type, "provider_thread.updated");
      assert.isFalse(fake.requests().some((request) => request["type"] === "goal"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
