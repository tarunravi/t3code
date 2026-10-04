import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
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

/** Never carry a finished turn's average into a new pending/running turn. */
export function latestTokenRateTurn(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns"> | null | undefined,
): OrchestrationV2ProviderTurn | null {
  return projection?.providerTurns.at(-1) ?? null;
}
