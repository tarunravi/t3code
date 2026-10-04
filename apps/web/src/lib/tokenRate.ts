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

export function tokenRateExplanation(turn: OrchestrationV2ProviderTurn | null | undefined): string {
  if (completedTurnTokenRate(turn) !== null)
    return "Completed-turn average output throughput, including reasoning and tool waits; not live generation speed.";
  if (turn?.status === "pending" || turn?.status === "running")
    return "Awaiting turn completion. Output tok/s is only available after a completed turn with supported totals and timing.";
  return "Output tok/s unavailable: awaiting a completed turn with supported output-token totals and timing. Input/context usage is not generation speed.";
}
