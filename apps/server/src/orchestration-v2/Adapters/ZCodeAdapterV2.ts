/**
 * ZCodeAdapterV2 — orchestrator-v2 adapter for the ZCode CLI
 * (https://github.com/zai-org/ZCode).
 *
 * Each turn is one headless `zcode --prompt=… --output-format stream-json`
 * process; follow-up turns pass `--resume <sessionId>`. ZCode persists the
 * session itself, so the ZCode session id is the durable `nativeThreadRef`
 * and a T3 thread can also be resumed from the ZCode TUI.
 *
 * `zcode app-server` is deliberately not used: it speaks ZCode's internal
 * desktop protocol (binary-framed v4 conversation topics with snapshot and
 * delta reassembly), which is far larger than what T3 needs and changes with
 * every ZCode desktop release. The headless stream is a stable CLI surface.
 *
 * Headless ZCode cannot ask for approval, so tools that would prompt are
 * denied; runtime modes map onto ZCode permission modes (see
 * `zcodePermissionMode`). Stop sends SIGINT to the process group, which ZCode
 * handles as a cancelled turn and persists before exiting.
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  ProviderDriverKind,
  ZCodeSettings,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { IdAllocatorV2 } from "../IdAllocator.ts";
import {
  ProviderAdapterForkThreadError,
  ProviderAdapterInterruptError,
  ProviderAdapterProtocolError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterTurnStartError,
  ProviderAdapterV2,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2OpenSessionInput,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { makeProviderFailure, makeProviderFailureTurnItem } from "../ProviderFailure.ts";
import { turnScopedSelectionTransition } from "../ProviderSelectionTransition.ts";
import { makeProviderTextDeltaCoalescer } from "./ProviderTextDeltaCoalescer.ts";
import {
  buildZCodePromptArgs,
  parseZCodeStreamLine,
  zcodePermissionMode,
  zcodeToolTarget,
  ZCodeTurnProjection,
  type ZCodeStreamItemKind,
  type ZCodeToolState,
  type ZCodeTurnOutcome,
  type ZCodeTurnUsage,
} from "./ZCodeStreamJson.ts";

const ZCODE_PROVIDER = ProviderDriverKind.make("zcode");
const DEFAULT_ZCODE_SETTINGS = Schema.decodeSync(ZCodeSettings)({});

const STREAM_FLUSH_MS = 50;
/** ZCode needs a moment after SIGINT to cancel tools and persist the session. */
const STOP_GRACE = Duration.seconds(10);
const STDERR_TAIL_CHARS = 2_000;
const STDERR_DRAIN_TIMEOUT = Duration.seconds(1);

const ZCodeProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    // Every turn is a fresh process, so the next turn picks up a new mode.
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface ZCodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ZCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
}

function providerRef(
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef {
  return { driver: ZCODE_PROVIDER, nativeId, strength };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The item-specific part of a turn item; `emitItem` fills in identity and timing. */
type ZCodeTurnItemBody = DistributiveOmit<
  Extract<
    OrchestrationV2TurnItem,
    {
      readonly type:
        | "assistant_message"
        | "reasoning"
        | "command_execution"
        | "file_change"
        | "dynamic_tool";
    }
  >,
  | "id"
  | "threadId"
  | "runId"
  | "nodeId"
  | "providerThreadId"
  | "providerTurnId"
  | "nativeItemRef"
  | "parentItemId"
  | "ordinal"
  | "startedAt"
  | "completedAt"
  | "updatedAt"
>;

interface StreamItemState {
  readonly turn: ActiveZCodeTurn;
  readonly kind: ZCodeStreamItemKind;
  readonly startedAt: DateTime.Utc;
}

interface ActiveZCodeTurn {
  readonly input: ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly projection: ZCodeTurnProjection;
  readonly itemOrdinals: Map<string, number>;
  readonly itemStartedAt: Map<string, DateTime.Utc>;
  outcome: ZCodeTurnOutcome | null;
  usage: ZCodeTurnUsage | null;
  interrupted: boolean;
  /** Set once the process is spawned; SIGINTs the process group and waits for exit. */
  stop: Effect.Effect<void> | null;
}

export function makeZCodeAdapterV2(options: ZCodeAdapterV2Options): ProviderAdapterV2Shape {
  const { idAllocator } = options;
  const command = options.settings.binaryPath || "zcode";

  const protocolError = (detail: string) =>
    new ProviderAdapterProtocolError({ driver: ZCODE_PROVIDER, detail });

  return ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: ZCODE_PROVIDER,
    getCapabilities: () => Effect.succeed(ZCodeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("ZCodeAdapterV2.openSession")(function* (
      input: ProviderAdapterV2OpenSessionInput,
    ) {
      const sessionScope = yield* Effect.scope;
      const platform = yield* HostProcessPlatform;
      const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
      const createdAt = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: ZCODE_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: ZCodeProviderCapabilitiesV2,
        createdAt,
        updatedAt: createdAt,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapterV2Event,
        ProviderAdapterV2Error | Cause.Done
      >();
      let providerThread: OrchestrationV2ProviderThread | null = null;
      let activeTurn: ActiveZCodeTurn | null = null;
      const streamItems = new Map<string, StreamItemState>();

      const emit = (event: ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateProviderSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null,
      ) {
        const updatedAt = yield* DateTime.now;
        sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
        yield* emit({
          type: "provider_session.updated",
          driver: ZCODE_PROVIDER,
          providerSession: sessionEntity,
        });
      });

      const updateProviderThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (providerThread === null) return;
        const updatedAt = yield* DateTime.now;
        providerThread = { ...providerThread, ...patch, updatedAt };
        yield* emit({
          type: "provider_thread.updated",
          driver: ZCODE_PROVIDER,
          providerThread,
        });
      });

      const itemOrdinal = (turn: ActiveZCodeTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.input.providerTurnOrdinal * 100 + turn.itemOrdinals.size + 1;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const emitItem = Effect.fnUntraced(function* (
        turn: ActiveZCodeTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        item: ZCodeTurnItemBody,
      ) {
        const updatedAt = yield* DateTime.now;
        const running = item.status === "running";
        const nodeId = idAllocator.derive.nodeFromProviderItem({
          driver: ZCODE_PROVIDER,
          nativeItemId,
        });
        const kind =
          item.type === "assistant_message" || item.type === "reasoning" ? item.type : "tool_call";
        yield* emit({
          type: "node.updated",
          driver: ZCODE_PROVIDER,
          node: {
            id: nodeId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind,
            status: item.status,
            countsForRun: false,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt: running ? null : updatedAt,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: ZCODE_PROVIDER,
          turnItem: {
            ...item,
            id: idAllocator.derive.turnItemFromProviderItem({
              driver: ZCODE_PROVIDER,
              nativeItemId,
            }),
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: providerRef(nativeItemId),
            parentItemId: null,
            ordinal: itemOrdinal(turn, nativeItemId),
            startedAt,
            completedAt: running ? null : updatedAt,
            updatedAt,
          },
        });
        if (item.type === "assistant_message") {
          yield* emit({
            type: "message.updated",
            driver: ZCODE_PROVIDER,
            message: {
              id: item.messageId,
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming: item.streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: startedAt,
              updatedAt,
            },
          });
        }
      });

      const streamText = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: STREAM_FLUSH_MS,
        emit: (update) =>
          Effect.suspend(() => {
            const state = streamItems.get(update.itemId);
            if (state === undefined || update.text.length === 0) return Effect.void;
            if (update.completed) streamItems.delete(update.itemId);
            const streaming = !update.completed;
            return emitItem(
              state.turn,
              update.itemId,
              state.startedAt,
              state.kind === "assistant_message"
                ? {
                    type: "assistant_message",
                    status: streaming ? "running" : "completed",
                    title: null,
                    messageId: idAllocator.derive.messageFromProviderItem({
                      driver: ZCODE_PROVIDER,
                      nativeItemId: update.itemId,
                    }),
                    text: update.text,
                    streaming,
                  }
                : {
                    type: "reasoning",
                    status: streaming ? "running" : "completed",
                    title: null,
                    text: update.text,
                    streaming,
                  },
            );
          }),
      });

      const emitTool = Effect.fnUntraced(function* (turn: ActiveZCodeTurn, tool: ZCodeToolState) {
        const startedAt = turn.itemStartedAt.get(tool.toolCallId) ?? (yield* DateTime.now);
        turn.itemStartedAt.set(tool.toolCallId, startedAt);
        const base = { status: tool.status, title: tool.toolName } as const;
        const output = tool.output === undefined ? {} : { output: tool.output };
        const target = zcodeToolTarget(tool);
        const item: ZCodeTurnItemBody =
          target !== null && "command" in target
            ? {
                ...base,
                ...output,
                type: "command_execution",
                input: target.command,
                ...(tool.exitCode === undefined ? {} : { exitCode: tool.exitCode }),
              }
            : target !== null
              ? { ...base, type: "file_change", fileName: target.fileName }
              : {
                  ...base,
                  ...output,
                  type: "dynamic_tool",
                  toolName: tool.toolName,
                  input: tool.input,
                };
        yield* emitItem(turn, tool.toolCallId, startedAt, item);
      });

      const handleRecord = Effect.fnUntraced(function* (
        turn: ActiveZCodeTurn,
        record: Record<string, unknown>,
      ) {
        for (const update of turn.projection.apply(record)) {
          switch (update.type) {
            case "session":
              if (providerThread?.nativeThreadRef?.nativeId !== update.sessionId) {
                yield* updateProviderThread({ nativeThreadRef: providerRef(update.sessionId) });
              }
              break;
            case "stream_delta":
              if (!streamItems.has(update.itemId)) {
                streamItems.set(update.itemId, {
                  turn,
                  kind: update.kind,
                  startedAt: yield* DateTime.now,
                });
                // Reserve the ordinal on the first delta so items keep stream order.
                itemOrdinal(turn, update.itemId);
              }
              yield* streamText.append({
                turnId: turn.providerTurn.id,
                itemId: update.itemId,
                delta: update.delta,
              });
              break;
            case "stream_end":
              yield* streamText.complete({
                turnId: turn.providerTurn.id,
                itemId: update.itemId,
                emitEmpty: false,
              });
              break;
            case "tool":
              yield* emitTool(turn, update.tool);
              break;
            case "outcome":
              turn.outcome = update.outcome;
              break;
            case "usage":
              turn.usage = update.usage;
              break;
          }
        }
      });

      const finalizeTurn = Effect.fnUntraced(function* (
        turn: ActiveZCodeTurn,
        exitFailure: string | null,
      ) {
        if (activeTurn !== turn) return;
        for (const itemId of turn.projection.openStreamItemIds()) {
          yield* streamText.complete({
            turnId: turn.providerTurn.id,
            itemId,
            emitEmpty: false,
          });
        }
        yield* streamText.flushTurn(turn.providerTurn.id);
        const interrupted = turn.interrupted || turn.outcome?.type === "cancelled";
        for (const tool of turn.projection.runningTools()) {
          tool.status = interrupted ? "interrupted" : "failed";
          yield* emitTool(turn, tool);
        }
        const failure = interrupted
          ? null
          : turn.outcome?.type === "failed"
            ? makeProviderFailure({
                class: "provider_error",
                message: turn.outcome.message,
                code: turn.outcome.code,
              })
            : turn.outcome === null || exitFailure !== null
              ? makeProviderFailure({
                  class: "provider_error",
                  message: exitFailure ?? "ZCode exited without finishing the turn.",
                })
              : null;
        const completedAt = yield* DateTime.now;
        activeTurn = null;
        yield* emit({
          type: "provider_turn.updated",
          driver: ZCODE_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: {
            ...turn.providerTurn,
            status: interrupted ? "interrupted" : failure !== null ? "failed" : "completed",
            completedAt,
            ...(turn.usage === null
              ? {}
              : { tokenUsage: { ...turn.usage, updatedAt: DateTime.formatIso(completedAt) } }),
          },
        });
        yield* updateProviderThread({ status: "idle" });
        yield* updateProviderSession(
          failure === null ? "ready" : "error",
          failure?.message ?? null,
        );
        if (failure === null) {
          yield* emit({
            type: "turn.terminal",
            driver: ZCODE_PROVIDER,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status: interrupted ? "interrupted" : "completed",
            failure: null,
            threadDisposition: "reusable",
          });
          return;
        }
        const failureItemOrdinal = itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`);
        yield* emit({
          type: "turn_item.updated",
          driver: ZCODE_PROVIDER,
          turnItem: makeProviderFailureTurnItem({
            idAllocator,
            driver: ZCODE_PROVIDER,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: failureItemOrdinal,
            failure,
            occurredAt: completedAt,
          }),
        });
        yield* emit({
          type: "turn.terminal",
          driver: ZCODE_PROVIDER,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          failureItemOrdinal,
          status: "failed",
          failure,
          threadDisposition: "reusable",
        });
      });

      const runTurnProcess = (turn: ActiveZCodeTurn, args: ReadonlyArray<string>) => {
        let stderrTail = "";
        return Effect.gen(function* () {
          const spawnCommand = yield* resolveSpawnCommand(command, [...args], {
            env: options.environment,
          });
          const child = yield* options.spawner.spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              cwd,
              env: options.environment,
              extendEnv: false,
              shell: spawnCommand.shell,
              // A process group lets Stop reach the tools ZCode spawned.
              detached: platform !== "win32",
            }),
          );
          turn.stop = child
            .kill({ killSignal: "SIGINT", forceKillAfter: STOP_GRACE })
            .pipe(Effect.ignore);
          if (turn.interrupted) yield* Effect.forkIn(turn.stop, sessionScope);
          const stderrReader = yield* child.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((chunk) =>
              Effect.sync(() => {
                stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
              }),
            ),
            Effect.ignore,
            Effect.forkScoped,
          );
          yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => {
              const record = parseZCodeStreamLine(line);
              return record === undefined ? Effect.void : handleRecord(turn, record);
            }),
          );
          const exitCode = yield* child.exitCode.pipe(Effect.exit);
          const code = Exit.isSuccess(exitCode) ? Number(exitCode.value) : null;
          if (code === 0 || turn.outcome !== null) return null;
          // A tool that inherited stderr can hold it open past ZCode's exit.
          yield* Fiber.await(stderrReader).pipe(Effect.timeoutOption(STDERR_DRAIN_TIMEOUT));
          const lastStderrLine = stderrTail.trim().split("\n").at(-1)?.trim();
          return `ZCode exited with ${code === null ? "a signal" : `code ${code}`}${
            lastStderrLine ? `: ${lastStderrLine}` : "."
          }`;
        }).pipe(
          Effect.scoped,
          // Session teardown interrupts the runner; there is no turn left to report.
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.succeed(
                `Failed to run ZCode (${command}): ${Cause.pretty(cause).split("\n")[0] ?? "unknown error"}`,
              ),
          ),
          Effect.flatMap((exitFailure) => finalizeTurn(turn, exitFailure)),
        );
      };

      /** Binds the orchestrator's provider-thread row to this session. */
      const adoptThread = Effect.fnUntraced(function* (
        appThreadId: OrchestrationV2ProviderThread["appThreadId"],
        existing: OrchestrationV2ProviderThread | undefined,
      ) {
        const now = yield* DateTime.now;
        providerThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                status: "idle",
                updatedAt: now,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: ZCODE_PROVIDER,
                  providerInstanceId: options.instanceId,
                  // ZCode mints its session id on the first turn; until then
                  // the app thread is the only stable identity.
                  nativeThreadId: `t3-thread:${appThreadId ?? input.threadId}`,
                }),
                driver: ZCODE_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: appThreadId ?? input.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt: now,
                updatedAt: now,
              };
        return providerThread;
      });

      const runtime: ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: ZCODE_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          adoptThread(
            threadInput.threadId,
            // A fresh native session: ZCode creates it on the first turn.
            threadInput.existingProviderThread === undefined
              ? undefined
              : { ...threadInput.existingProviderThread, nativeThreadRef: null },
          ),
        resumeThread: (threadInput) =>
          adoptThread(
            threadInput.threadId ?? threadInput.providerThread.appThreadId,
            threadInput.providerThread,
          ),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            if (activeTurn !== null) {
              return yield* protocolError(
                `ZCode provider thread ${turnInput.providerThread.id} already has an active turn`,
              );
            }
            // The orchestrator owns the row identity; keep its native session.
            providerThread = turnInput.providerThread;
            const attachmentPaths = turnInput.message.attachments.flatMap((attachment) => {
              const path = resolveAttachmentPath({
                attachmentsDir: options.serverConfig.attachmentsDir,
                attachment,
              });
              return path === null ? [] : [path];
            });
            const args = buildZCodePromptArgs({
              prompt: turnInput.message.text,
              mode: zcodePermissionMode(turnInput.runtimePolicy),
              resumeSessionId: providerThread.nativeThreadRef?.nativeId ?? null,
              attachmentPaths,
            });
            const startedAt = yield* DateTime.now;
            const nativeTurnId = `${turnInput.providerThread.id}:attempt:${turnInput.attemptId}`;
            const providerTurn: OrchestrationV2ProviderTurn = {
              id: idAllocator.derive.providerTurn({ driver: ZCODE_PROVIDER, nativeTurnId }),
              providerThreadId: turnInput.providerThread.id,
              nodeId: turnInput.rootNodeId,
              runAttemptId: turnInput.attemptId,
              nativeTurnRef: providerRef(nativeTurnId, "weak"),
              ordinal: turnInput.providerTurnOrdinal,
              status: "running",
              startedAt,
              completedAt: null,
            };
            const turn: ActiveZCodeTurn = {
              input: turnInput,
              providerTurn,
              projection: new ZCodeTurnProjection(providerTurn.id),
              itemOrdinals: new Map(),
              itemStartedAt: new Map(),
              outcome: null,
              usage: null,
              interrupted: false,
              stop: null,
            };
            activeTurn = turn;
            yield* emit({
              type: "provider_turn.updated",
              driver: ZCODE_PROVIDER,
              threadId: turnInput.threadId,
              providerTurn,
            });
            yield* updateProviderThread({
              status: "active",
              firstRunOrdinal: providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
              lastRunOrdinal: turnInput.runOrdinal,
            });
            yield* updateProviderSession("running", null);
            yield* runTurnProcess(turn, args).pipe(Effect.forkIn(sessionScope));
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterTurnStartError({
                  driver: ZCODE_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapterSteerRunUnsupportedError({
              driver: ZCODE_PROVIDER,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const turn = activeTurn;
            if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
              return yield* protocolError(
                `ZCode turn ${interruptInput.providerTurnId} is not active`,
              );
            }
            turn.interrupted = true;
            // Before spawn completes there is nothing to signal; the runner
            // checks the flag and stops the process as soon as it exists.
            if (turn.stop !== null) yield* turn.stop;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterInterruptError({
                  driver: ZCODE_PROVIDER,
                  providerThreadId: interruptInput.providerThread.id,
                  providerTurnId: interruptInput.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.fail(
            new ProviderAdapterRuntimeRequestResponseError({
              driver: ZCODE_PROVIDER,
              requestId: requestInput.requestId,
              cause: protocolError("Headless ZCode does not raise interactive requests."),
            }),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.fail(
            new ProviderAdapterReadThreadSnapshotError({
              driver: ZCODE_PROVIDER,
              providerThreadId: snapshotInput.providerThread.id,
              cause: "ZCode's headless CLI does not expose conversation snapshots.",
            }),
          ),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapterRollbackThreadError({
              driver: ZCODE_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              checkpointId: rollbackInput.target.checkpointId,
              cause: "ZCode's headless CLI does not expose conversation rollback.",
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapterForkThreadError({
              driver: ZCODE_PROVIDER,
              providerThreadId: forkInput.sourceProviderThread.id,
              cause: "ZCode's headless CLI does not expose native forks.",
            }),
          ),
      };
      return runtime;
    }),
  });
}

export type ZCodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | IdAllocatorV2
  | ServerConfig;

export const ZCodeAdapterV2Driver: ProviderAdapterDriver<ZCodeSettings, ZCodeAdapterV2DriverEnv> = {
  driverKind: ZCODE_PROVIDER,
  configSchema: ZCodeSettings,
  defaultConfig: (): ZCodeSettings => DEFAULT_ZCODE_SETTINGS,
  create: Effect.fn("ZCodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ZCodeSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      return makeZCodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        idAllocator: yield* IdAllocatorV2,
        serverConfig: yield* ServerConfig,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ZCODE_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create ZCode adapter.",
              cause,
            }),
        ),
      ),
  ),
};
