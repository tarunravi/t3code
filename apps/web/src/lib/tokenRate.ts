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
  return `${rate > 0 && rate < 1 ? "<1" : Math.max(0, Math.round(rate))} tok/s (turn avg)`;
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
  if (!run) {
    return projection.providerTurns
      .filter((turn) => turn.runAttemptId === null)
      .reduce<OrchestrationV2ProviderTurn | null>(
        (latest, turn) =>
          latest === null ||
          DateTime.toEpochMillis(turn.startedAt ?? turn.completedAt ?? DateTime.makeUnsafe(0)) >
            DateTime.toEpochMillis(latest.startedAt ?? latest.completedAt ?? DateTime.makeUnsafe(0))
            ? turn
            : latest,
        null,
      );
  }
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
  "runs" | "attempts" | "providerTurns" | "turnItems" | "nodes"
>;

/** Rough tokenizer-agnostic estimate; good enough for a fluctuating speed readout. */
export const ESTIMATED_CHARS_PER_TOKEN = 4;
export const LIVE_TOKEN_RATE_WINDOW_MS = 5_000;
const MIN_LIVE_SPAN_MS = 1_000;

export interface TokenRateSample {
  readonly tokens: number;
  readonly atMs: number;
}

/** Prefer live provider output counters; otherwise estimate streamed root-agent text. */
export function liveTokenRateSource(
  projection: TokenRateProjection | null | undefined,
): { readonly key: string; readonly estimatedTokens: number; readonly measured?: boolean } | null {
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
  const nativeTurn = run === null ? latestTokenRateTurn(projection) : null;
  if (run === null && nativeTurn?.status !== "running") return null;
  const turn = nativeTurn ?? latestTokenRateTurn(projection);
  const output =
    turn?.turnTokenUsage?.usageStatus === "unavailable"
      ? undefined
      : turn?.turnTokenUsage?.outputTokens;
  const key = run?.id ?? nativeTurn!.id;
  if (turn?.status === "running" && output !== undefined && Number.isFinite(output) && output > 0)
    return { key: `${key}:usage`, estimatedTokens: output, measured: true };
  const rootNodeIds = new Set<string>();
  if (run?.rootNodeId != null) rootNodeIds.add(run.rootNodeId);
  if (nativeTurn) rootNodeIds.add(nativeTurn.nodeId);
  for (const attempt of projection.attempts)
    if (run !== null && attempt.runId === run.id && attempt.rootNodeId !== null)
      rootNodeIds.add(attempt.rootNodeId);
  const nodesById = new Map(
    projection.nodes
      .filter((node) => node.runId === (run?.id ?? null))
      .map((node) => [node.id, node]),
  );
  let chars = 0;
  for (const item of projection.turnItems) {
    if (item.runId !== (run?.id ?? null) || item.nodeId === null) continue;
    if (item.type !== "assistant_message" && item.type !== "reasoning") continue;
    let nodeId = item.nodeId;
    const visited = new Set<string>();
    while (!rootNodeIds.has(nodeId) && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = nodesById.get(nodeId);
      // Child output is measured in its own projection and summed by the lineage UI.
      if (node?.kind === "subagent" || node?.parentNodeId == null) break;
      nodeId = node.parentNodeId;
    }
    if (rootNodeIds.has(nodeId)) chars += item.text.length;
  }
  return { key, estimatedTokens: chars / ESTIMATED_CHARS_PER_TOKEN };
}

/** A sparse observation cannot establish when output arrived; start a fresh window. */
export function appendTokenRateSample(
  samples: readonly TokenRateSample[],
  sample: TokenRateSample,
  windowMs: number = LIVE_TOKEN_RATE_WINDOW_MS,
): TokenRateSample[] {
  const last = samples.at(-1);
  if (last !== undefined && last.tokens === sample.tokens) return [...samples];
  if (last !== undefined && (sample.atMs - last.atMs > windowMs || sample.tokens < last.tokens))
    return [sample];
  const next = [...samples, sample];
  const cutoff = sample.atMs - windowMs;
  let baseIndex = 0;
  for (let index = 0; index < next.length; index += 1)
    if (next[index]!.atMs <= cutoff) baseIndex = index;
  return next.slice(baseIndex);
}

/** Only recent, positive observed text growth supports a live estimate. */
export function rollingTokenRate(
  samples: readonly TokenRateSample[],
  nowMs: number,
  windowMs: number = LIVE_TOKEN_RATE_WINDOW_MS,
): number | null {
  const newest = samples.at(-1);
  if (newest === undefined || nowMs - newest.atMs >= windowMs) return null;
  const base = samples.find((sample) => sample.atMs >= nowMs - windowMs);
  if (base === undefined) return null;
  const spanMs = nowMs - base.atMs;
  const delta = newest.tokens - base.tokens;
  if (spanMs < MIN_LIVE_SPAN_MS || delta <= 0) return null;
  return (delta / spanMs) * 1000;
}

export function formatLiveTokenRate(rate: number | null, estimated = true): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  if (rate <= 0) return null;
  return `${estimated ? "~" : ""}${rate < 1 ? "<1" : Math.round(rate)} tok/s`;
}

export const LIVE_TOKEN_RATE_EXPLANATION =
  "Recent output speed uses provider-reported output-token counters when available. ~ marks a streamed text/reasoning estimate (~4 characters per token), excluding tool-call arguments and unexposed reasoning. No recent visible output does not mean the provider is idle.";

export function tokenRateExplanation(turn: OrchestrationV2ProviderTurn | null | undefined): string {
  if (completedTurnTokenRate(turn) !== null)
    return "Completed-turn average output throughput, including reasoning and tool waits; not live generation speed.";
  if (turn?.status === "pending" || turn?.status === "running")
    return "Measuring live output speed from streamed text.";
  return "Output tok/s unavailable: awaiting a completed turn with supported output-token totals and timing. Input/context usage is not generation speed.";
}
