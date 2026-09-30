import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy, type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import { makeZCodeAdapterV2 } from "./ZCodeAdapterV2.ts";
import {
  buildZCodePromptArgs,
  zcodePermissionMode,
  ZCodeTurnProjection,
} from "./ZCodeStreamJson.ts";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-zcode-v2-adapter-",
}).pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.mergeAll(NodeServices.layer, idAllocatorLayer, serverConfigLayer);

const INSTANCE_ID = ProviderInstanceId.make("zcode");
const THREAD_ID = ThreadId.make("thread-zcode-test");
const SESSION_ID = ProviderSessionId.make("provider-session-zcode-test");
const ZCODE_SESSION = "sess_8d4e6d5c-2f9d-45b8-ad04-9cbd50bc600d";

const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

/** A ZCode stream-json event line, shaped like the CLI's `mapSessionEvent` output. */
const event = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ type, payload, sessionId: ZCODE_SESSION, turnId: "turn_1", seq: 1 });
const streaming = (kind: string, delta = "") =>
  event("model.streaming", { assistantMessageId: "msg_1", kind, delta, done: false });

/** Recorded from `zcode-glm -p … --output-format stream-json --mode yolo`, trimmed. */
const TOOL_TURN = [
  event("turn.started", { input: "Read a.txt", turnNumber: 0 }),
  streaming("start"),
  streaming("reasoning_start"),
  streaming("reasoning_delta", "Check the "),
  streaming("reasoning_delta", "file."),
  streaming("reasoning_end"),
  event("tool.updated", {
    kind: "scheduled",
    toolCallId: "chatcmpl-tool-1",
    toolName: "Bash",
    input: { command: "cat a.txt", description: "Show a.txt" },
  }),
  event("tool.updated", { kind: "started", toolCallId: "chatcmpl-tool-1", toolName: "Bash" }),
  event("tool.updated", {
    kind: "result",
    toolCallId: "chatcmpl-tool-1",
    result: {
      success: true,
      content: "hello world",
      perf: { detail: { kind: "command", command: { exitCode: 0 } } },
    },
  }),
  streaming("text_start"),
  streaming("text_delta", "a.txt says "),
  streaming("text_delta", "hello world"),
  streaming("text_end"),
  event("turn.completed", { response: "a.txt says hello world", resultType: "success" }),
  JSON.stringify({
    type: "result",
    sessionId: ZCODE_SESSION,
    response: "a.txt says hello world",
    usage: { inputTokens: 10_600, outputTokens: 214 },
    projection: { status: "idle", contextUsed: 10_814, contextWindow: 200_000 },
  }),
];

interface ScriptedProcess {
  readonly lines: ReadonlyArray<string>;
  readonly exitCode?: number;
  readonly stderr?: string;
  /** Keep stdout open until the adapter kills the process, then emit these lines. */
  readonly onKill?: ReadonlyArray<string>;
}

function makeFakeZCode(scripts: ReadonlyArray<ScriptedProcess>) {
  const spawned: Array<{ readonly args: ReadonlyArray<string>; readonly cwd: string | undefined }> =
    [];
  const kills: Array<string | undefined> = [];
  const remaining = [...scripts];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("piped command");
      spawned.push({ args: command.args, cwd: command.options.cwd });
      const script = remaining.shift() ?? { lines: [] };
      const stdout = yield* Queue.unbounded<string, Cause.Done>();
      const exited = yield* Deferred.make<number>();
      yield* Queue.offerAll(
        stdout,
        script.lines.map((line) => `${line}\n`),
      );
      if (script.onKill === undefined) {
        yield* Queue.end(stdout);
        yield* Deferred.succeed(exited, script.exitCode ?? 0);
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Deferred.await(exited).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        kill: (options) =>
          Effect.gen(function* () {
            kills.push(options?.killSignal);
            yield* Queue.offerAll(
              stdout,
              (script.onKill ?? []).map((line) => `${line}\n`),
            );
            yield* Queue.end(stdout);
            yield* Deferred.succeed(exited, script.exitCode ?? 130);
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.fromQueue(stdout)),
        stderr: Stream.encodeText(Stream.make(script.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, spawned, kills };
}

const openRuntime = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  model = "default",
) {
  const adapter = makeZCodeAdapterV2({
    instanceId: INSTANCE_ID,
    settings: { enabled: true, binaryPath: "zcode-glm" },
    environment: {},
    spawner,
    idAllocator: yield* IdAllocatorV2,
    serverConfig: yield* ServerConfig,
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: { instanceId: INSTANCE_ID, model },
    runtimePolicy,
  });
  const emitted: Array<ProviderAdapterV2Event> = [];
  const terminals = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((next) =>
      Effect.sync(() => emitted.push(next)).pipe(
        Effect.andThen(next.type === "turn.terminal" ? Queue.offer(terminals, next) : Effect.void),
      ),
    ),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy,
  });
  return { adapter, runtime, emitted, providerThread, nextTerminal: Queue.take(terminals) };
});

const appThread = Effect.map(DateTime.now, (now): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: THREAD_ID,
  projectId: "project:fixture:zcode" as OrchestrationV2AppThread["projectId"],
  title: "ZCode test thread",
  providerInstanceId: INSTANCE_ID,
  modelSelection: { instanceId: INSTANCE_ID, model: "default" },
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
}));

const turnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  runOrdinal: number,
  text: string,
) {
  const runId = RunId.make(`run:${THREAD_ID}:${runOrdinal}`);
  return {
    appThread: yield* appThread,
    threadId: THREAD_ID,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${THREAD_ID}:${runOrdinal}` as never,
      text,
      attachments: [],
      createdBy: "user" as const,
      creationSource: "web" as const,
    },
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy,
  };
});

function latestItems(events: ReadonlyArray<ProviderAdapterV2Event>) {
  const items = new Map<string, OrchestrationV2TurnItem>();
  for (const next of events) {
    if (next.type === "turn_item.updated") items.set(next.turnItem.id, next.turnItem);
  }
  return [...items.values()].toSorted((left, right) => left.ordinal - right.ordinal);
}

describe("ZCode stream-json protocol", () => {
  it("attributes only anchored parent turn requests, excluding child and auxiliary models", () => {
    // Actual mapSessionEvent output: querySource is stripped. turn-model-step
    // supplies iteration; title-generation-sidecar and compact-active do not.
    const projection = new ZCodeTurnProjection("model-test", "parent");
    const request = {
      type: "session.updated",
      sessionId: "parent",
      turnId: "main-turn",
      payload: {
        providerId: "proxy",
        modelId: "alias",
        messageCount: 3,
        toolCount: 8,
        iteration: 0,
      },
    };
    assert.deepEqual(projection.apply(request), []);
    projection.apply({
      type: "turn.started",
      sessionId: "parent",
      turnId: "main-turn",
      payload: { input: "test", turnNumber: 0 },
    });
    assert.deepEqual(projection.apply(request), [{ type: "model", modelId: "alias" }]);
    assert.deepEqual(projection.apply({ ...request, sessionId: "child" }), []);
    assert.deepEqual(projection.apply({ ...request, turnId: "other-turn" }), []);
    for (const [modelId, toolCount] of [
      ["title-model", 0],
      ["compact-model", 8],
    ] as const) {
      assert.deepEqual(
        projection.apply({
          ...request,
          payload: { providerId: "proxy", modelId, messageCount: 3, toolCount },
        }),
        [],
      );
    }
    for (const iteration of [undefined, "0", -1]) {
      assert.deepEqual(
        projection.apply({ ...request, payload: { ...request.payload, iteration } }),
        [],
      );
    }
    assert.deepEqual(projection.apply(request), [{ type: "model", modelId: "alias" }]);
  });

  it("maps T3 runtime modes onto ZCode permission modes", () => {
    const mode = (runtimeMode: typeof runtimePolicy.runtimeMode, plan = false) =>
      zcodePermissionMode({ runtimeMode, interactionMode: plan ? "plan" : "default" });
    assert.equal(mode("full-access"), "yolo");
    assert.equal(mode("auto-accept-edits"), "edit");
    assert.equal(mode("approval-required"), "build");
    assert.equal(mode("full-access", true), "plan");
  });

  it("keeps a dash-prefixed prompt a value and resumes the native session", () => {
    assert.deepEqual(
      buildZCodePromptArgs({
        prompt: "--help me",
        mode: "edit",
        resumeSessionId: ZCODE_SESSION,
        attachmentPaths: ["/tmp/a.png"],
      }),
      [
        "--prompt=--help me",
        "--output-format",
        "stream-json",
        "--mode",
        "edit",
        "--resume",
        ZCODE_SESSION,
        "--attach",
        "/tmp/a.png",
      ],
    );
  });

  it("fails a tool that headless ZCode denied and interrupts a cancelled one", () => {
    const projection = new ZCodeTurnProjection("turn");
    const scheduled = (toolCallId: string) =>
      JSON.parse(
        event("tool.updated", {
          kind: "scheduled",
          toolCallId,
          toolName: "Bash",
          input: { command: "touch c.txt" },
        }),
      );
    projection.apply(scheduled("denied"));
    projection.apply(scheduled("cancelled"));
    const denied = projection.apply(
      JSON.parse(
        event("permission.resolved", {
          toolCallId: "denied",
          decision: "deny",
          reason: "No permission client configured for Bash",
        }),
      ),
    );
    const cancelled = projection.apply(
      JSON.parse(
        event("tool.updated", {
          kind: "error",
          toolCallId: "cancelled",
          error: { code: "TOOL_CANCELLED", message: "Bash was cancelled" },
        }),
      ),
    );
    assert.deepInclude(denied.at(-1), {
      type: "tool",
      tool: {
        toolCallId: "denied",
        toolName: "Bash",
        input: { command: "touch c.txt" },
        status: "failed",
        output: "Permission denied: No permission client configured for Bash",
      },
    });
    const cancelledUpdate = cancelled.at(-1);
    assert.equal(cancelledUpdate?.type === "tool" && cancelledUpdate.tool.status, "interrupted");
    assert.deepEqual(projection.runningTools(), []);
  });
});

describe("ZCodeAdapterV2", () => {
  it.effect("rejects unsupported model selections before spawning a process", () =>
    Effect.gen(function* () {
      const fake = makeFakeZCode([]);
      const opened = yield* openRuntime(fake.spawner, "some-other-model").pipe(Effect.exit);
      assert.equal(opened._tag, "Failure");
      const { adapter, runtime, providerThread } = yield* openRuntime(fake.spawner);
      const capabilities = yield* adapter.getCapabilities();
      const current = { instanceId: INSTANCE_ID, model: "default" };
      const rejected = yield* adapter.planSelectionTransition({
        current,
        target: { ...current, model: "some-other-model" },
        sessionCapabilities: capabilities,
      });
      assert.equal(rejected.type, "reject");
      const accepted = yield* adapter.planSelectionTransition({
        current,
        target: current,
        sessionCapabilities: capabilities,
      });
      assert.equal(accepted.type, "apply_on_next_turn");
      const input = yield* turnInput(providerThread, 1, "test");
      const started = yield* runtime
        .startTurn({ ...input, modelSelection: { ...current, model: "some-other-model" } })
        .pipe(Effect.exit);
      assert.equal(started._tag, "Failure");
      assert.equal(fake.spawned.length, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "reports runtime-requested model IDs, including resumed sessions, without resolving aliases",
    () =>
      Effect.gen(function* () {
        const request = (modelId: string) =>
          event("session.updated", {
            providerId: "bifrost",
            modelId,
            messageCount: 3,
            toolCount: 8,
            iteration: 0,
          });
        const started = event("turn.started", { input: "test", turnNumber: 0 });
        const child = JSON.stringify({
          ...JSON.parse(request("child-model")),
          sessionId: "child",
          turnId: "child-turn",
        });
        const auxiliary = event("session.updated", {
          providerId: "bifrost",
          modelId: "title-model",
          messageCount: 1,
          toolCount: 0,
        });
        const fake = makeFakeZCode([
          {
            lines: [
              started,
              request("sparks/native-model"),
              child,
              auxiliary,
              event("turn.completed", { resultType: "success" }),
            ],
          },
          {
            lines: [
              child,
              started,
              request("auto"),
              auxiliary,
              event("turn.completed", { resultType: "success" }),
            ],
          },
        ]);
        const { runtime, emitted, providerThread, nextTerminal } = yield* openRuntime(fake.spawner);
        assert.equal(runtime.providerSession.model, null);
        yield* runtime.startTurn(yield* turnInput(providerThread, 1, "test"));
        yield* nextTerminal;
        assert.equal(runtime.providerSession.model, "sparks/native-model");
        const resumable = emitted.findLast(
          (next) =>
            next.type === "provider_thread.updated" && next.providerThread.nativeThreadRef !== null,
        );
        assert.isTrue(resumable?.type === "provider_thread.updated");
        if (resumable?.type !== "provider_thread.updated") return;
        yield* runtime.startTurn(yield* turnInput(resumable.providerThread, 2, "again"));
        yield* nextTerminal;
        assert.equal(runtime.providerSession.model, "auto");
        assert.includeMembers([...(fake.spawned[1]?.args ?? [])], ["--resume", ZCODE_SESSION]);
        assert.isTrue(
          emitted.some(
            (next) =>
              next.type === "provider_session.updated" &&
              next.providerSession.model === "sparks/native-model",
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("streams a headless turn and resumes its ZCode session on the next turn", () =>
    Effect.gen(function* () {
      const fake = makeFakeZCode([{ lines: TOOL_TURN }, { lines: TOOL_TURN }]);
      const { runtime, emitted, providerThread, nextTerminal } = yield* openRuntime(fake.spawner);

      yield* runtime.startTurn(yield* turnInput(providerThread, 1, "Read a.txt"));
      const terminal = yield* nextTerminal;

      assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
      assert.deepEqual(fake.spawned[0], {
        cwd: "/workspace",
        args: ["--prompt=Read a.txt", "--output-format", "stream-json", "--mode", "yolo"],
      });
      const items = latestItems(emitted).map((item) => ({
        type: item.type,
        status: item.status,
        ...(item.type === "reasoning" || item.type === "assistant_message"
          ? { text: item.text }
          : {}),
        ...(item.type === "command_execution"
          ? { input: item.input, output: item.output, exitCode: item.exitCode }
          : {}),
      }));
      assert.deepEqual(items, [
        { type: "reasoning", status: "completed", text: "Check the file." },
        {
          type: "command_execution",
          status: "completed",
          input: "cat a.txt",
          output: "hello world",
          exitCode: 0,
        },
        { type: "assistant_message", status: "completed", text: "a.txt says hello world" },
      ]);
      const completedTurn = emitted.findLast(
        (next) => next.type === "provider_turn.updated" && next.providerTurn.status === "completed",
      );
      assert.equal(
        completedTurn?.type === "provider_turn.updated" &&
          completedTurn.providerTurn.tokenUsage?.usedTokens,
        10_814,
      );

      const resumable = emitted.findLast(
        (next) =>
          next.type === "provider_thread.updated" &&
          next.providerThread.nativeThreadRef?.nativeId === ZCODE_SESSION,
      );
      assert.isTrue(resumable?.type === "provider_thread.updated");
      if (resumable?.type !== "provider_thread.updated") return;
      yield* runtime.startTurn(yield* turnInput(resumable.providerThread, 2, "And again"));
      yield* nextTerminal;
      assert.includeMembers([...(fake.spawned[1]?.args ?? [])], ["--resume", ZCODE_SESSION]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the turn with ZCode's error when the process exits early", () =>
    Effect.gen(function* () {
      const fake = makeFakeZCode([
        { lines: [], exitCode: 1, stderr: "Loading config\nError: No model provider configured\n" },
      ]);
      const { runtime, providerThread, nextTerminal } = yield* openRuntime(fake.spawner);

      yield* runtime.startTurn(yield* turnInput(providerThread, 1, "Hello"));
      const terminal = yield* nextTerminal;

      assert.equal(terminal.type === "turn.terminal" && terminal.status, "failed");
      assert.equal(
        terminal.type === "turn.terminal" && terminal.failure?.message,
        "ZCode exited with code 1: Error: No model provider configured",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops a running turn with SIGINT and reports it interrupted", () =>
    Effect.gen(function* () {
      const fake = makeFakeZCode([
        {
          lines: TOOL_TURN.slice(0, 8),
          onKill: [
            event("tool.updated", {
              kind: "error",
              toolCallId: "chatcmpl-tool-1",
              error: { code: "TOOL_CANCELLED", message: "Bash was cancelled" },
            }),
            event("turn.completed", { response: "", resultType: "cancelled" }),
          ],
        },
      ]);
      const { runtime, emitted, providerThread, nextTerminal } = yield* openRuntime(fake.spawner);
      yield* runtime.startTurn(yield* turnInput(providerThread, 1, "Run a long command"));
      const running = yield* Effect.gen(function* () {
        while (true) {
          const turn = emitted.find((next) => next.type === "provider_turn.updated");
          const toolStarted = latestItems(emitted).some(
            (item) => item.type === "command_execution",
          );
          if (turn?.type === "provider_turn.updated" && toolStarted) return turn.providerTurn;
          yield* Effect.yieldNow;
        }
      });

      yield* runtime.interruptTurn({ providerThread, providerTurnId: running.id });
      const terminal = yield* nextTerminal;

      assert.deepEqual(fake.kills, ["SIGINT"]);
      assert.equal(terminal.type === "turn.terminal" && terminal.status, "interrupted");
      const command = latestItems(emitted).find((item) => item.type === "command_execution");
      assert.equal(command?.status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
