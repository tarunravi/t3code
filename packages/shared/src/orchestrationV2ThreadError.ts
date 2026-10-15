import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export function latestRootProviderFailure(
  run: OrchestrationV2Run | null,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ProviderFailure | null {
  if (run?.status !== "failed") return null;
  let latest: Extract<OrchestrationV2TurnItem, { type: "error" }> | null = null;
  for (const item of turnItems) {
    if (
      item.type !== "error" ||
      item.status !== "failed" ||
      item.runId !== run.id ||
      item.nodeId !== run.rootNodeId
    )
      continue;
    if (
      latest === null ||
      DateTime.toEpochMillis(item.updatedAt) > DateTime.toEpochMillis(latest.updatedAt) ||
      (DateTime.toEpochMillis(item.updatedAt) === DateTime.toEpochMillis(latest.updatedAt) &&
        (item.ordinal > latest.ordinal || (item.ordinal === latest.ordinal && item.id > latest.id)))
    ) {
      latest = item;
    }
  }
  return latest?.failure ?? null;
}

/** Failures that a user can resume by replaying the failed turn's input. */
export function isResumableProviderFailure(failure: OrchestrationV2ProviderFailure | null) {
  return (
    failure?.class === "usage_limit" ||
    ((failure?.class === "provider_error" || failure?.class === "transport_error") &&
      failure.retryable === true)
  );
}

/** Runs in the latest uninterrupted streak of retryable provider-loop failures. */
export function latestProviderFailureStreak(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<OrchestrationV2Run> {
  const executed = runs
    .filter(
      (run) => run.status !== "queued" && !(run.status === "cancelled" && run.startedAt === null),
    )
    .toSorted((left, right) => (runRanAfter(left, right) ? 1 : runRanAfter(right, left) ? -1 : 0));
  const streak: OrchestrationV2Run[] = [];
  for (let index = executed.length - 1; index >= 0; index -= 1) {
    const run = executed[index]!;
    if (run.status === "completed") break;
    if (
      run.status !== "failed" ||
      !isResumableProviderFailure(latestRootProviderFailure(run, turnItems))
    ) {
      break;
    }
    streak.push(run);
  }
  return streak;
}

export function consecutiveProviderFailureCount(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): number {
  return latestProviderFailureStreak(runs, turnItems).length;
}

/**
 * The failed run to retry on the fallback model: the latest run when it ends the
 * second consecutive resumable failure and no fallback was tried for it. A failed
 * fallback run is never a source and extends the streak past two, so an
 * automatic retry happens once.
 */
export function providerFallbackSourceRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2Run | null {
  const streak = latestProviderFailureStreak(runs, turnItems);
  const latest = streak[0];
  if (
    streak.length !== 2 ||
    latest === undefined ||
    latest.automaticFallbackOfRunId !== undefined
  ) {
    return null;
  }
  return runs.some((run) => run.automaticFallbackOfRunId === latest.id) ? null : latest;
}

export function threadErrorSummary(
  failure: OrchestrationV2ProviderFailure | null,
  sessionError: string | null,
) {
  const currentFailure =
    sessionError !== null && sessionError !== failure?.message ? null : failure;
  return {
    usageLimitResetAt:
      currentFailure?.class === "usage_limit" ? (currentFailure.resetAt ?? null) : null,
    lastError: sessionError ?? failure?.message ?? null,
    lastErrorClass:
      sessionError !== null && sessionError !== failure?.message ? null : (failure?.class ?? null),
  };
}

export function latestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued") continue;
    if (run.status === "cancelled" && run.startedAt === null) continue;
    if (latest === null || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

/**
 * Ordinals follow submission, but a run can start ahead of a held queue (a
 * restart continuation, or a message sent while the queue is held), so a queued
 * run resumed later can have a lower ordinal than one that already ended. An
 * unfinished run is the latest.
 */
export function runRanAfter(
  run: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
  other: Pick<OrchestrationV2Run, "ordinal" | "completedAt">,
): boolean {
  const end = (candidate: typeof run) =>
    !candidate.completedAt
      ? Number.POSITIVE_INFINITY
      : DateTime.toEpochMillis(candidate.completedAt);
  return end(run) === end(other) ? run.ordinal > other.ordinal : end(run) > end(other);
}

export function usageLimitBlockedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const executed = latestExecutedRun(runs);
  if (executed?.status !== "failed") return null;
  const summary = threadErrorSummary(latestRootProviderFailure(executed, turnItems), sessionError);
  return summary.lastErrorClass === "usage_limit" ? executed : null;
}

/**
 * That limited run, when newer runs were queued or cancelled before starting.
 * Callers that treat the highest-ordinal run as the thread outcome would
 * otherwise hide the limit.
 */
export function usageLimitRunPresentedAsLatest(
  runs: ReadonlyArray<OrchestrationV2Run>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  sessionError: string | null,
): OrchestrationV2Run | null {
  const blocked = usageLimitBlockedRun(runs, turnItems, sessionError);
  return blocked !== null && runs.some((run) => run.ordinal > blocked.ordinal) ? blocked : null;
}

export function latestUnheldRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | null {
  let latest: OrchestrationV2Run | null = null;
  for (const run of runs) {
    if (run.status === "queued" && run.queueHeld === true) continue;
    if (latest === null || run.ordinal > latest.ordinal) latest = run;
  }
  return latest;
}
