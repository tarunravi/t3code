/**
 * ZCodeStreamJson — the ZCode CLI's headless `--output-format stream-json`
 * protocol, reduced to the updates `ZCodeAdapterV2` renders.
 *
 * Each turn runs `zcode --prompt=<text> --output-format stream-json`. Stdout
 * carries one ZCode session event per line (`model.streaming`,
 * `tool.updated`, `permission.resolved`, `turn.completed`, …) and ends with a
 * `{"type":"result"}` summary. Every event carries the ZCode `sessionId`,
 * which `--resume` accepts on the next turn.
 *
 * Headless ZCode has no interactive approval surface: a tool that would ask
 * for permission is denied and reported as `permission.resolved` with
 * `decision: "deny"`, so runtime modes map onto ZCode's own permission modes.
 */
import type { RuntimeMode, ProviderInteractionMode } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export type ZCodePermissionMode = "build" | "edit" | "plan" | "yolo";

/** ZCode denies anything that would prompt, so stricter T3 modes deny rather than ask. */
export function zcodePermissionMode(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}): ZCodePermissionMode {
  if (input.interactionMode === "plan") return "plan";
  switch (input.runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto":
    case "auto-accept-edits":
      return "edit";
    case "approval-required":
      return "build";
  }
}

export function buildZCodePromptArgs(input: {
  readonly prompt: string;
  readonly mode: ZCodePermissionMode;
  readonly resumeSessionId: string | null;
  readonly attachmentPaths: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  return [
    // `=` keeps a prompt that starts with "-" from parsing as a flag.
    `--prompt=${input.prompt}`,
    "--output-format",
    "stream-json",
    "--mode",
    input.mode,
    ...(input.resumeSessionId === null ? [] : ["--resume", input.resumeSessionId]),
    ...input.attachmentPaths.flatMap((path) => ["--attach", path]),
  ];
}

export type ZCodeRecord = Record<string, unknown>;

export function parseZCodeStreamLine(line: string): ZCodeRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Predicate.isObject(parsed) && !Array.isArray(parsed)
      ? (parsed as ZCodeRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function field(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? (input as ZCodeRecord)[key] : undefined;
}

function stringField(input: unknown, key: string): string | undefined {
  const value = field(input, key);
  return typeof value === "string" ? value : undefined;
}

function numberField(input: unknown, key: string): number | undefined {
  const value = field(input, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type ZCodeStreamItemKind = "assistant_message" | "reasoning";

export type ZCodeToolStatus = "running" | "completed" | "failed" | "interrupted";

export interface ZCodeToolState {
  readonly toolCallId: string;
  toolName: string;
  input: unknown;
  status: ZCodeToolStatus;
  output?: string;
  exitCode?: number;
}

const FILE_CHANGE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** How a tool renders in T3: shell commands and file edits get dedicated items. */
export function zcodeToolTarget(
  tool: Pick<ZCodeToolState, "toolName" | "input">,
): { readonly command: string } | { readonly fileName: string } | null {
  const nonEmpty = (value: string | undefined) =>
    value !== undefined && value.trim().length > 0 ? value : undefined;
  if (tool.toolName === "Bash") {
    const command = nonEmpty(stringField(tool.input, "command"));
    return command === undefined ? null : { command };
  }
  if (FILE_CHANGE_TOOLS.has(tool.toolName)) {
    const fileName =
      nonEmpty(stringField(tool.input, "file_path")) ?? nonEmpty(stringField(tool.input, "path"));
    return fileName === undefined ? null : { fileName: fileName.trim() };
  }
  return null;
}

export type ZCodeTurnOutcome =
  | { readonly type: "completed" }
  | { readonly type: "cancelled" }
  | { readonly type: "failed"; readonly message: string; readonly code: string | null };

export interface ZCodeTurnUsage {
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type ZCodeTurnUpdate =
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "model"; readonly modelId: string }
  | {
      readonly type: "stream_delta";
      readonly itemId: string;
      readonly kind: ZCodeStreamItemKind;
      readonly delta: string;
    }
  | { readonly type: "stream_end"; readonly itemId: string }
  | { readonly type: "tool"; readonly tool: ZCodeToolState }
  | { readonly type: "outcome"; readonly outcome: ZCodeTurnOutcome }
  | { readonly type: "usage"; readonly usage: ZCodeTurnUsage };

/**
 * Per-turn reducer from ZCode stream records to adapter updates. Stream items
 * are keyed by assistant message and segment so reasoning and text blocks
 * interleaved with tool calls render as separate, ordered items.
 */
export class ZCodeTurnProjection {
  private sessionId: string | null = null;
  private mainTurnId: string | null = null;
  private segment = 0;
  private readonly openItems = new Map<ZCodeStreamItemKind, string>();
  readonly tools = new Map<string, ZCodeToolState>();
  private readonly turnKey: string;

  constructor(turnKey: string, resumeSessionId: string | null = null) {
    this.turnKey = turnKey;
    this.sessionId = resumeSessionId;
  }

  apply(record: ZCodeRecord): ReadonlyArray<ZCodeTurnUpdate> {
    const updates: Array<ZCodeTurnUpdate> = [];
    const sessionId = stringField(record, "sessionId");
    if (
      sessionId !== undefined &&
      this.sessionId === null &&
      (record["type"] === "turn.started" || record["type"] === "result")
    ) {
      this.sessionId = sessionId;
      updates.push({ type: "session", sessionId });
    }
    const payload = field(record, "payload");
    switch (record["type"]) {
      case "turn.started":
        if (sessionId === this.sessionId && this.mainTurnId === null) {
          this.mainTurnId = stringField(record, "turnId") ?? null;
        }
        break;
      case "session.updated": {
        // The mapper drops querySource. Only turn-model-step requests carry
        // iteration; title/compaction/workspace requests do not. Child turns
        // carry their own session/turn IDs. Never infer from a bare model ID.
        const modelId = stringField(payload, "modelId")?.trim();
        const providerId = stringField(payload, "providerId")?.trim();
        const iteration = numberField(payload, "iteration");
        if (
          this.mainTurnId !== null &&
          sessionId === this.sessionId &&
          stringField(record, "turnId") === this.mainTurnId &&
          modelId &&
          providerId &&
          numberField(payload, "messageCount") !== undefined &&
          iteration !== undefined &&
          Number.isInteger(iteration) &&
          iteration >= 0
        ) {
          updates.push({ type: "model", modelId });
        }
        break;
      }
      case "model.streaming":
        this.applyStreaming(payload, updates);
        break;
      case "tool.updated":
        this.applyTool(payload, updates);
        break;
      case "permission.resolved":
        this.applyPermissionResolved(payload, updates);
        break;
      case "turn.completed":
        updates.push({ type: "outcome", outcome: completedOutcome(payload) });
        break;
      case "turn.failed":
        updates.push({
          type: "outcome",
          outcome: {
            type: "failed",
            message: stringField(field(payload, "error"), "message") ?? "ZCode turn failed",
            code: stringField(field(payload, "error"), "code") ?? null,
          },
        });
        break;
      case "result": {
        const usage = resultUsage(record);
        if (usage !== undefined) updates.push({ type: "usage", usage });
        break;
      }
    }
    return updates;
  }

  private applyStreaming(payload: unknown, updates: Array<ZCodeTurnUpdate>) {
    const kind = stringField(payload, "kind");
    const streamKind: ZCodeStreamItemKind | undefined = kind?.startsWith("text_")
      ? "assistant_message"
      : kind?.startsWith("reasoning_")
        ? "reasoning"
        : undefined;
    if (streamKind === undefined || kind === undefined) return;
    if (kind.endsWith("_start")) {
      this.closeItem(streamKind, updates);
      this.openItem(streamKind, stringField(payload, "assistantMessageId"));
      return;
    }
    if (kind.endsWith("_end")) {
      this.closeItem(streamKind, updates);
      return;
    }
    const delta = stringField(payload, "delta") ?? "";
    if (delta.length === 0) return;
    const itemId =
      this.openItems.get(streamKind) ??
      this.openItem(streamKind, stringField(payload, "assistantMessageId"));
    updates.push({ type: "stream_delta", itemId, kind: streamKind, delta });
  }

  private openItem(kind: ZCodeStreamItemKind, assistantMessageId: string | undefined): string {
    const itemId = `${this.turnKey}:${assistantMessageId ?? "message"}:${kind}:${this.segment++}`;
    this.openItems.set(kind, itemId);
    return itemId;
  }

  private closeItem(kind: ZCodeStreamItemKind, updates: Array<ZCodeTurnUpdate>) {
    const itemId = this.openItems.get(kind);
    if (itemId === undefined) return;
    this.openItems.delete(kind);
    updates.push({ type: "stream_end", itemId });
  }

  private applyTool(payload: unknown, updates: Array<ZCodeTurnUpdate>) {
    const toolCallId = stringField(payload, "toolCallId");
    if (toolCallId === undefined) return;
    const phase = stringField(payload, "kind");
    const existing = this.tools.get(toolCallId);
    if (existing !== undefined && existing.status !== "running") return;
    const tool: ZCodeToolState = existing ?? {
      toolCallId,
      toolName: stringField(payload, "toolName") ?? "tool",
      input: field(payload, "input") ?? {},
      status: "running",
    };
    this.tools.set(toolCallId, tool);
    switch (phase) {
      case "scheduled":
      case "started":
        tool.toolName = stringField(payload, "toolName") ?? tool.toolName;
        if (field(payload, "input") !== undefined) tool.input = field(payload, "input");
        break;
      case "progress": {
        const preview = stringField(field(payload, "outputPreview"), "text");
        if (preview === undefined || preview.length === 0) return;
        tool.output = preview;
        break;
      }
      case "result": {
        const result = field(payload, "result");
        tool.status = field(result, "success") === false ? "failed" : "completed";
        const content = stringField(result, "content");
        if (content !== undefined) tool.output = content;
        const exitCode = numberField(
          field(field(field(result, "perf"), "detail"), "command"),
          "exitCode",
        );
        if (exitCode !== undefined) tool.exitCode = exitCode;
        break;
      }
      case "error": {
        const error = field(payload, "error");
        tool.status = stringField(error, "code") === "TOOL_CANCELLED" ? "interrupted" : "failed";
        tool.output = stringField(error, "message") ?? "Tool failed";
        break;
      }
      default:
        return;
    }
    updates.push({ type: "tool", tool: { ...tool } });
  }

  private applyPermissionResolved(payload: unknown, updates: Array<ZCodeTurnUpdate>) {
    if (stringField(payload, "decision") !== "deny") return;
    const tool = this.tools.get(stringField(payload, "toolCallId") ?? "");
    if (tool === undefined || tool.status !== "running") return;
    tool.status = "failed";
    tool.output = `Permission denied: ${stringField(payload, "reason") ?? "not allowed in this mode"}`;
    updates.push({ type: "tool", tool: { ...tool } });
  }

  /** Items and tools a turn still owns when the ZCode process exits. */
  openStreamItemIds(): ReadonlyArray<string> {
    return [...this.openItems.values()];
  }

  runningTools(): ReadonlyArray<ZCodeToolState> {
    return [...this.tools.values()].filter((tool) => tool.status === "running");
  }
}

function completedOutcome(payload: unknown): ZCodeTurnOutcome {
  const resultType = stringField(payload, "resultType") ?? "success";
  if (resultType === "success") return { type: "completed" };
  if (resultType === "cancelled") return { type: "cancelled" };
  return { type: "failed", message: `ZCode stopped the turn: ${resultType}`, code: resultType };
}

function resultUsage(record: ZCodeRecord): ZCodeTurnUsage | undefined {
  const projection = field(record, "projection");
  const usedTokens = numberField(projection, "contextUsed");
  const maxTokens = numberField(projection, "contextWindow");
  if (usedTokens === undefined || maxTokens === undefined || maxTokens <= 0) return undefined;
  const usage = field(record, "usage");
  const inputTokens = numberField(usage, "inputTokens");
  const outputTokens = numberField(usage, "outputTokens");
  return {
    usedTokens,
    maxTokens,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}
