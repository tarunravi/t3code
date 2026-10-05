import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { latestUnheldRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

/** Context snapshots are per-message usage, not cumulative generated output.
 * Only complete normalized turn totals have a reliable output/time denominator.
 * This average includes tool waits and reasoning; it is not live decoder speed. */
export function completedTurnTokenRate(
  turn: OrchestrationV2ProviderTurn | null | undefined,
): number | null {
  if (
    turn?.status !== "completed" ||
    turn.turnTokenUsage?.usageStatus !== "complete" ||
    turn.startedAt === null ||
    turn.completedAt === null
  )
    return null;
  const elapsedMs =
    DateTime.toEpochMillis(turn.completedAt) - DateTime.toEpochMillis(turn.startedAt);
  const output = turn.turnTokenUsage.outputTokens;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || !Number.isFinite(output) || output < 0)
    return null;
  return (output / elapsedMs) * 1000;
}

export function formatTokenRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return `${Math.max(0, Math.round(rate))} tok/s (turn avg)`;
}

/** Provider turns are grouped by provider thread, not chronological order. */
export function latestTokenRateTurn(
  projection:
    | Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">
    | null
    | undefined,
): OrchestrationV2ProviderTurn | null {
  if (!projection) return null;
  let currentRun: OrchestrationV2ThreadProjection["runs"][number] | null = null;
  for (const run of projection.runs) {
    if (
      (run.status === "preparing" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting") &&
      (currentRun === null || run.ordinal > currentRun.ordinal)
    )
      currentRun = run;
  }
  const run = currentRun ?? latestUnheldRun(projection.runs);
  if (!run) return null;
  let attempt: OrchestrationV2ThreadProjection["attempts"][number] | null = null;
  for (const candidate of projection.attempts) {
    if (candidate.runId !== run.id) continue;
    if (run.activeAttemptId !== null) {
      if (candidate.id === run.activeAttemptId) attempt = candidate;
    } else if (attempt === null || candidate.attemptOrdinal > attempt.attemptOrdinal) {
      attempt = candidate;
    }
  }
  // An unresolved new attempt must not reuse the old attempt's average on reconnect.
  if (run.activeAttemptId !== null && attempt === null) return null;
  const rootNodeId = attempt?.rootNodeId ?? run.rootNodeId;
  const providerThreadId = attempt?.providerThreadId ?? run.providerThreadId;
  if (rootNodeId === null || providerThreadId === null) return null;
  let latest: OrchestrationV2ProviderTurn | null = null;
  for (const turn of projection.providerTurns) {
    if (turn.nodeId !== rootNodeId || turn.providerThreadId !== providerThreadId) continue;
    if (attempt && turn.runAttemptId !== attempt.id) continue;
    if (attempt?.providerTurnId != null && turn.id !== attempt.providerTurnId) continue;
    if (latest === null || turn.ordinal > latest.ordinal) latest = turn;
  }
  // A still-active run may be between provider turns; never show a previous average.
  if (currentRun && latest?.status === "completed") return null;
  return latest;
}

type TokenRateProjection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "attempts" | "providerTurns" | "turnItems"
>;

/** Rough tokenizer-agnostic estimate; good enough for a fluctuating speed readout. */
export const ESTIMATED_CHARS_PER_TOKEN = 4;
export const LIVE_TOKEN_RATE_WINDOW_MS = 5_000;
const MIN_LIVE_SPAN_MS = 1_000;

export interface TokenRateSample {
  readonly tokens: number;
  readonly atMs: number;
}

/**
 * Providers only report trustworthy output totals when a turn completes, so live
 * speed is estimated from the root agent's streamed assistant and reasoning text.
 * Tool-call arguments are not streamed as text and are therefore not counted.
 */
export function liveTokenRateSource(
  projection: TokenRateProjection | null | undefined,
): { readonly key: string; readonly estimatedTokens: number } | null {
  if (!projection) return null;
  let run: TokenRateProjection["runs"][number] | null = null;
  for (const candidate of projection.runs) {
    if (
      (candidate.status === "preparing" ||
        candidate.status === "starting" ||
        candidate.status === "running" ||
        candidate.status === "waiting") &&
      (run === null || candidate.ordinal > run.ordinal)
    )
      run = candidate;
  }
  if (!run) return null;
  const rootNodeIds = new Set<string>();
  if (run.rootNodeId !== null) rootNodeIds.add(run.rootNodeId);
  for (const attempt of projection.attempts)
    if (attempt.runId === run.id && attempt.rootNodeId !== null)
      rootNodeIds.add(attempt.rootNodeId);
  let chars = 0;
  for (const item of projection.turnItems) {
    if (item.runId !== run.id || item.nodeId === null || !rootNodeIds.has(item.nodeId)) continue;
    if (item.type === "assistant_message" || item.type === "reasoning") chars += item.text.length;
  }
  return { key: run.id, estimatedTokens: chars / ESTIMATED_CHARS_PER_TOKEN };
}

/** Keeps only the newest sample before the window as the rate's baseline. */
export function appendTokenRateSample(
  samples: readonly TokenRateSample[],
  sample: TokenRateSample,
  windowMs: number = LIVE_TOKEN_RATE_WINDOW_MS,
): TokenRateSample[] {
  const last = samples.at(-1);
  if (last !== undefined && last.tokens === sample.tokens) return [...samples];
  const next = [...samples, sample];
  const cutoff = sample.atMs - windowMs;
  let baseIndex = 0;
  for (let index = 0; index < next.length; index += 1)
    if (next[index]!.atMs <= cutoff) baseIndex = index;
  return next.slice(baseIndex);
}

/** Measured to `now`, so the rate decays toward zero while streaming stalls. */
export function rollingTokenRate(
  samples: readonly TokenRateSample[],
  nowMs: number,
  windowMs: number = LIVE_TOKEN_RATE_WINDOW_MS,
): number | null {
  const newest = samples.at(-1);
  if (newest === undefined) return null;
  let base = samples[0]!;
  for (const sample of samples) if (sample.atMs <= nowMs - windowMs) base = sample;
  const spanMs = nowMs - base.atMs;
  if (spanMs < MIN_LIVE_SPAN_MS) return null;
  return (Math.max(0, newest.tokens - base.tokens) / spanMs) * 1000;
}

export function formatLiveTokenRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  return `~${Math.max(0, Math.round(rate))} tok/s`;
}

export const LIVE_TOKEN_RATE_EXPLANATION =
  "Live output speed over the last few seconds, estimated from streamed text and reasoning (~4 characters per token). Tool-call arguments are not counted.";

export function tokenRateExplanation(turn: OrchestrationV2ProviderTurn | null | undefined): string {
  if (completedTurnTokenRate(turn) !== null)
    return "Completed-turn average output throughput, including reasoning and tool waits; not live generation speed.";
  if (turn?.status === "pending" || turn?.status === "running")
    return "Measuring live output speed from streamed text.";
  return "Output tok/s unavailable: awaiting a completed turn with supported output-token totals and timing. Input/context usage is not generation speed.";
}
