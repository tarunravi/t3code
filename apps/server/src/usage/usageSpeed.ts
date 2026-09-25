/**
 * Request speed from the places that record timing: OpenCodex request history
 * (exact, including time to first token), Claude Code transcripts (end-to-end
 * estimates from record timestamps), and Cursor turns run through T3 Code
 * (turn timing without token counts). Pure: no filesystem or network access,
 * so callers stream input and tests pass fixtures.
 *
 * @module usageSpeed
 */
import type { UsageSpeedRow, UsageSpeedSourceKind } from "@t3tools/contracts";

export interface SpeedSample {
  readonly harness: string;
  readonly upstream: string | null;
  readonly model: string;
  readonly effort: string | null;
  readonly speedTier: string | null;
  readonly source: UsageSpeedSourceKind;
  readonly timestampMs: number;
  readonly ok: boolean;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly durationMs: number;
  readonly ttftMs: number | null;
}

/** Longest believable single request; longer gaps are idle time, not generation. */
const MAX_REQUEST_MS = 15 * 60_000;
/**
 * Routed requests (combos, retries) can report a first token only moments
 * before the end, leaving a decode window too short to measure a rate.
 */
const MIN_DECODE_MS = 250;
const MIN_DECODE_FRACTION = 0.1;

function hasMeasurableDecode(sample: SpeedSample): boolean {
  if (sample.ttftMs === null) return false;
  const decodeMs = sample.durationMs - sample.ttftMs;
  return decodeMs >= MIN_DECODE_MS && decodeMs >= sample.durationMs * MIN_DECODE_FRACTION;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/* -------------------------------------------------------------------------- */
/* OpenCodex request history                                                  */
/* -------------------------------------------------------------------------- */

/** One `/api/request-history` entry, or null when it carries no timing. */
export function speedSampleFromOpenCodex(entry: unknown): SpeedSample | null {
  const row = record(entry);
  if (row === null) return null;
  const timestampMs = row["timestamp"];
  const durationMs = row["durationMs"];
  if (typeof timestampMs !== "number" || typeof durationMs !== "number" || durationMs <= 0) {
    return null;
  }
  const model = text(row["resolvedModel"]) ?? text(row["model"]);
  if (model === null) return null;
  const attempts = Array.isArray(row["attempts"]) ? row["attempts"].map(record) : [];
  const lastAttempt = attempts.findLast((attempt) => attempt !== null) ?? null;
  // The top-level field is often unset; the final attempt carries it.
  const firstOutputMs =
    typeof row["firstOutputMs"] === "number"
      ? row["firstOutputMs"]
      : typeof lastAttempt?.["firstOutputMs"] === "number"
        ? lastAttempt["firstOutputMs"]
        : null;
  const usage = record(row["usage"]);
  const status = row["status"];
  const tierOutcome = record(row["tierOutcome"]);
  // The API labels fast requests; the local log records the applied tier instead.
  const speedTier =
    text(row["requestedSpeedLabel"]) ??
    (row["requestedServiceTier"] === "priority" || tierOutcome?.["fastOutcome"] === "applied"
      ? "fast"
      : "standard");
  return {
    harness: "codex",
    upstream: text(row["provider"]),
    model,
    effort: text(row["requestedEffort"]),
    speedTier,
    source: "opencodex",
    timestampMs,
    ok: typeof status === "number" && status >= 200 && status < 300,
    outputTokens: count(usage?.["outputTokens"]),
    reasoningTokens: count(usage?.["reasoningOutputTokens"]),
    durationMs,
    ttftMs:
      firstOutputMs !== null && firstOutputMs >= 0 && firstOutputMs <= durationMs
        ? firstOutputMs
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Claude Code transcripts                                                    */
/* -------------------------------------------------------------------------- */

interface PendingClaudeMessage {
  startMs: number;
  endMs: number;
  model: string;
  speedTier: string | null;
  outputTokens: number;
  reasoningTokens: number;
}

/**
 * Line-at-a-time reader for one Claude Code transcript. A response starts at
 * the last non-assistant record (the prompt or tool result) and ends at its
 * last content block, so the estimate includes time to first token. Claude
 * writes one record per content block with the same usage, so blocks are
 * merged by message id.
 */
export class ClaudeSpeedReader {
  private lastInputMs: number | null = null;
  private readonly pending = new Map<string, PendingClaudeMessage>();

  push(line: string): void {
    if (!line.includes('"timestamp"')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const row = record(parsed);
    if (row === null) return;
    const timestampMs = typeof row["timestamp"] === "string" ? Date.parse(row["timestamp"]) : NaN;
    if (!Number.isFinite(timestampMs)) return;
    if (row["type"] !== "assistant") {
      if (row["type"] === "user") this.lastInputMs = timestampMs;
      return;
    }
    const message = record(row["message"]);
    const usage = record(message?.["usage"]);
    const id = text(message?.["id"]);
    const model = text(message?.["model"]);
    if (message === null || usage === null || id === null || model === null) return;
    if (model === "<synthetic>") return;
    const existing = this.pending.get(id);
    if (existing !== undefined) {
      existing.endMs = Math.max(existing.endMs, timestampMs);
      existing.outputTokens = Math.max(existing.outputTokens, count(usage["output_tokens"]));
      return;
    }
    if (this.lastInputMs === null || this.lastInputMs > timestampMs) return;
    const details = record(usage["output_tokens_details"]);
    this.pending.set(id, {
      startMs: this.lastInputMs,
      endMs: timestampMs,
      model,
      speedTier: text(usage["speed"]) ?? text(usage["service_tier"]),
      outputTokens: count(usage["output_tokens"]),
      reasoningTokens: count(details?.["thinking_tokens"]),
    });
  }

  samples(): SpeedSample[] {
    return [...this.pending.values()].flatMap((message) => {
      const durationMs = message.endMs - message.startMs;
      if (durationMs <= 0 || durationMs > MAX_REQUEST_MS) return [];
      return [
        {
          harness: "claude",
          upstream: null,
          model: message.model,
          effort: null,
          speedTier: message.speedTier,
          source: "claude-transcripts" as const,
          timestampMs: message.endMs,
          ok: true,
          outputTokens: message.outputTokens,
          reasoningTokens: message.reasoningTokens,
          durationMs,
          ttftMs: null,
        },
      ];
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Cursor turns run through T3 Code                                           */
/* -------------------------------------------------------------------------- */

/** Agent turns run tools between model calls, so they legitimately outlast one request. */
const MAX_TURN_MS = 2 * 60 * 60_000;

/** One finished Cursor provider turn, joined with its run's model selection. */
export interface CursorTurnRow {
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Start of the turn's first reasoning, message, or tool item. */
  readonly firstOutputAt: string | null;
  readonly model: string | null;
  /** The run's `modelSelection.options` as JSON text: `[{ id, value }]`. */
  readonly options: string | null;
}

function cursorModelOptions(options: string | null): {
  readonly effort: string | null;
  readonly speedTier: string | null;
} {
  let parsed: unknown;
  try {
    parsed = options === null ? [] : JSON.parse(options);
  } catch {
    parsed = [];
  }
  let effort: string | null = null;
  let speedTier: string | null = null;
  for (const option of Array.isArray(parsed) ? parsed.map(record) : []) {
    const id = text(option?.["id"]);
    if (id === null) continue;
    if (/effort/iu.test(id)) effort = text(option?.["value"]);
    if (id === "fastMode") speedTier = option?.["value"] === true ? "fast" : "standard";
  }
  return { effort, speedTier };
}

/**
 * One Cursor turn as a sample. The Cursor SDK reports no token usage, so
 * rates stay empty; the turn spans every model call and tool run in it, and
 * time to first token is the delay before its first streamed item.
 * Interrupted turns say nothing about speed and are skipped.
 */
export function speedSampleFromCursorTurn(row: CursorTurnRow): SpeedSample | null {
  if (row.status !== "completed" && row.status !== "failed") return null;
  const model = text(row.model);
  const startMs = row.startedAt === null ? NaN : Date.parse(row.startedAt);
  const endMs = row.completedAt === null ? NaN : Date.parse(row.completedAt);
  if (model === null || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const durationMs = endMs - startMs;
  if (durationMs <= 0 || durationMs > MAX_TURN_MS) return null;
  const firstOutputMs = row.firstOutputAt === null ? NaN : Date.parse(row.firstOutputAt);
  const ttftMs = firstOutputMs - startMs;
  return {
    harness: "cursor",
    upstream: null,
    model,
    ...cursorModelOptions(row.options),
    source: "cursor-turns",
    timestampMs: endMs,
    ok: row.status === "completed",
    outputTokens: 0,
    reasoningTokens: 0,
    durationMs,
    ttftMs: Number.isFinite(ttftMs) && ttftMs >= 0 && ttftMs <= durationMs ? ttftMs : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function spread(values: readonly number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  return {
    medianMs: Math.round(percentile(sorted, 0.5)),
    p90Ms: Math.round(percentile(sorted, 0.9)),
  };
}

function rate(tokens: number, ms: number): number | null {
  return ms > 0 && tokens > 0 ? Math.round((tokens / ms) * 10_000) / 10 : null;
}

/**
 * Groups samples by harness, upstream, model, effort, tier, and source.
 * Rates are token-weighted over successful requests (total tokens over total
 * time), so one long request cannot be drowned out by many short ones.
 */
export function aggregateSpeed(samples: readonly SpeedSample[]): UsageSpeedRow[] {
  const groups = new Map<string, SpeedSample[]>();
  for (const sample of samples) {
    const key = JSON.stringify([
      sample.harness,
      sample.upstream,
      sample.model,
      sample.effort,
      sample.speedTier,
      sample.source,
    ]);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [sample]);
    else group.push(sample);
  }
  const rows: UsageSpeedRow[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const succeeded = group.filter((sample) => sample.ok);
    const timed = succeeded.filter((sample) => sample.ttftMs !== null);
    const decoding = succeeded.filter(hasMeasurableDecode);
    const outputTokens = succeeded.reduce((sum, sample) => sum + sample.outputTokens, 0);
    const decodeTokens = decoding.reduce((sum, sample) => sum + sample.outputTokens, 0);
    rows.push({
      harness: first.harness,
      upstream: first.upstream,
      model: first.model,
      effort: first.effort,
      speedTier: first.speedTier,
      source: first.source,
      requests: group.length,
      failedRequests: group.length - succeeded.length,
      outputTokens,
      reasoningTokens: succeeded.reduce((sum, sample) => sum + sample.reasoningTokens, 0),
      timeToFirstToken: timed.length === 0 ? null : spread(timed.map((sample) => sample.ttftMs!)),
      duration: spread((succeeded.length > 0 ? succeeded : group).map((s) => s.durationMs)),
      outputTokensPerSecond: rate(
        outputTokens,
        succeeded.reduce((sum, sample) => sum + sample.durationMs, 0),
      ),
      decodeTokensPerSecond: rate(
        decodeTokens,
        decoding.reduce((sum, sample) => sum + sample.durationMs - sample.ttftMs!, 0),
      ),
    });
  }
  return rows.toSorted((left, right) => right.requests - left.requests);
}
