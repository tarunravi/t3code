import type { OrchestrationV2Run, OrchestrationV2RunAttempt } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type Run = Pick<
  OrchestrationV2Run,
  | "id"
  | "threadId"
  | "activeAttemptId"
  | "providerInstanceId"
  | "providerThreadId"
  | "status"
  | "startedAt"
  | "completedAt"
>;
type Attempt = Pick<
  OrchestrationV2RunAttempt,
  | "id"
  | "runId"
  | "providerInstanceId"
  | "providerThreadId"
  | "providerTurnId"
  | "status"
  | "startedAt"
  | "completedAt"
>;

/** Server-local evidence, not a wire/persisted activity model. Missing evidence must stay unknown. */
export interface IdleStallRecoveryInput {
  readonly enabled?: boolean | undefined;
  readonly taskId: string;
  readonly taskGeneration: string;
  readonly run: Run | null;
  readonly attempt: Attempt | null;
  readonly nowMs: number;
  readonly timeoutMs: number;
  readonly maxObservationAgeMs: number;
  readonly cooldownMs: number;
  readonly lastRecoveryAtMs: number | null;
  readonly recoveredEpisodeKeys: readonly string[];
  readonly blockers: Readonly<
    Record<
      | "manualStop"
      | "frozen"
      | "superseded"
      | "awaitingInput"
      | "finalizing"
      | "otherActiveOrQueuedRun",
      boolean
    >
  >;
  readonly observation: {
    readonly runId: Run["id"];
    readonly attemptId: Attempt["id"];
    readonly providerInstanceId: Attempt["providerInstanceId"];
    readonly providerThreadId: Attempt["providerThreadId"];
    readonly providerTurnId: Attempt["providerTurnId"];
    readonly observedAtMs: number;
    readonly completeSinceMs: number;
    /** Complete requires observing pre-filter content too; persisted silence alone is insufficient. */
    readonly visibility: "complete" | "buffered" | "unknown";
    readonly liveness: "active" | "stale" | "idle" | "unknown";
    readonly failureId: string | null;
    readonly activeOperations: readonly { readonly deadlineAtMs: number | null }[];
    /** Complete ordered history for this attempt; child values require joined, actually started child attempts. */
    readonly events: readonly {
      readonly sequence: number;
      readonly occurredAtMs: number;
      readonly kind: "assistant" | "reasoning" | "tool" | "child" | "heartbeat";
      /** Stable message/tool/owned-child identity; value includes substantive content/lifecycle only. */
      readonly subjectId: string;
      readonly value: string;
    }[];
  } | null;
}

export type IdleStallRecoveryReason =
  | "disabled"
  | "blocked"
  | "identity_unknown"
  | "not_started"
  | "observation_unknown"
  | "protected_work"
  | "not_idle_or_stale"
  | "below_timeout"
  | "already_recovered"
  | "cooldown"
  | "eligible_idle"
  | "eligible_stall";
export interface IdleStallRecoveryDecision {
  readonly eligible: boolean;
  readonly reason: IdleStallRecoveryReason;
  readonly episodeKey: string | null;
}

/** Queue-only proposal. Recheck under the existing dispatch lock and claim the key durably there. */
export function decideIdleStallRecovery(input: IdleStallRecoveryInput): IdleStallRecoveryDecision {
  const deny = (
    reason: IdleStallRecoveryReason,
    episodeKey: string | null = null,
  ): IdleStallRecoveryDecision => ({ eligible: false, reason, episodeKey });
  if (input.enabled !== true) return deny("disabled");
  if (
    input.blockers.manualStop !== false ||
    input.blockers.frozen !== false ||
    input.blockers.superseded !== false ||
    input.blockers.awaitingInput !== false ||
    input.blockers.finalizing !== false ||
    input.blockers.otherActiveOrQueuedRun !== false
  )
    return deny("blocked");
  const { run, attempt, observation: observed, nowMs } = input;
  if (
    !run ||
    !attempt ||
    !observed ||
    !input.taskId ||
    !input.taskGeneration ||
    !run.threadId ||
    run.activeAttemptId !== attempt.id ||
    attempt.runId !== run.id ||
    run.providerInstanceId !== attempt.providerInstanceId ||
    observed.providerInstanceId !== attempt.providerInstanceId ||
    run.providerThreadId !== attempt.providerThreadId ||
    observed.runId !== run.id ||
    observed.attemptId !== attempt.id ||
    observed.providerThreadId !== attempt.providerThreadId ||
    attempt.providerTurnId === null ||
    observed.providerTurnId !== attempt.providerTurnId ||
    attempt.status === "superseded"
  )
    return deny("identity_unknown");
  if (
    run.startedAt === null ||
    attempt.startedAt === null ||
    ["queued", "preparing", "starting"].includes(run.status) ||
    attempt.status === "pending"
  )
    return deny("not_started");
  const startedAtMs = DateTime.toEpochMillis(attempt.startedAt);
  const runStartedAtMs = DateTime.toEpochMillis(run.startedAt);
  if (
    ![
      nowMs,
      startedAtMs,
      runStartedAtMs,
      input.timeoutMs,
      input.maxObservationAgeMs,
      input.cooldownMs,
      observed.observedAtMs,
      observed.completeSinceMs,
    ].every(Number.isFinite) ||
    input.timeoutMs <= 0 ||
    input.maxObservationAgeMs <= 0 ||
    input.cooldownMs < 0 ||
    runStartedAtMs > startedAtMs ||
    startedAtMs > observed.observedAtMs ||
    observed.observedAtMs > nowMs ||
    observed.completeSinceMs > startedAtMs ||
    observed.completeSinceMs < 0 ||
    nowMs - observed.observedAtMs > input.maxObservationAgeMs ||
    observed.visibility !== "complete"
  )
    return deny("observation_unknown");
  if (observed.activeOperations.length > 0)
    return deny(
      observed.activeOperations.every(
        (work) =>
          work.deadlineAtMs !== null &&
          Number.isFinite(work.deadlineAtMs) &&
          work.deadlineAtMs > nowMs,
      )
        ? "protected_work"
        : "observation_unknown",
    );
  const idle =
    observed.liveness === "idle" &&
    ["completed", "failed", "interrupted"].includes(run.status) &&
    ["completed", "failed", "interrupted"].includes(attempt.status);
  const stalled =
    observed.liveness === "stale" &&
    !!observed.failureId &&
    ["running", "failed"].includes(run.status) &&
    ["running", "failed"].includes(attempt.status);
  if (!idle && !stalled) return deny("not_idle_or_stale");
  let idleSinceMs = startedAtMs;
  if (idle) {
    if (run.completedAt === null || attempt.completedAt === null)
      return deny("observation_unknown");
    const runCompletedAtMs = DateTime.toEpochMillis(run.completedAt);
    const attemptCompletedAtMs = DateTime.toEpochMillis(attempt.completedAt);
    if (
      ![runCompletedAtMs, attemptCompletedAtMs].every(
        (time) => Number.isFinite(time) && time >= startedAtMs && time <= observed.observedAtMs,
      ) ||
      runCompletedAtMs < attemptCompletedAtMs
    )
      return deny("observation_unknown");
    idleSinceMs = runCompletedAtMs;
  }
  let sequence = 0;
  let progressAtMs = startedAtMs;
  let previousSequence = 0;
  let previousTime = startedAtMs;
  const values = new Map<string, string>();
  for (const event of observed.events) {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= previousSequence ||
      !Number.isFinite(event.occurredAtMs) ||
      event.occurredAtMs < previousTime ||
      event.occurredAtMs > observed.observedAtMs ||
      !event.subjectId
    )
      return deny("observation_unknown");
    previousSequence = event.sequence;
    previousTime = event.occurredAtMs;
    if (event.kind === "heartbeat") continue;
    const subject = JSON.stringify([event.kind, event.subjectId]);
    if (values.get(subject) === event.value || event.value === "") continue;
    values.set(subject, event.value);
    sequence = event.sequence;
    progressAtMs = event.occurredAtMs;
  }
  // Wall-clock time, timer ticks, and cooldown expiry never create a new episode.
  const episodeKey = JSON.stringify([
    "idle-stall-v1",
    input.taskId,
    input.taskGeneration,
    run.threadId,
    run.id,
    attempt.id,
    sequence,
    observed.failureId,
  ]);
  if (input.recoveredEpisodeKeys.includes(episodeKey)) return deny("already_recovered", episodeKey);
  if (nowMs - Math.max(progressAtMs, idleSinceMs) < input.timeoutMs)
    return deny("below_timeout", episodeKey);
  if (
    input.lastRecoveryAtMs !== null &&
    (!Number.isFinite(input.lastRecoveryAtMs) || input.lastRecoveryAtMs > nowMs)
  )
    return deny("observation_unknown", episodeKey);
  if (input.lastRecoveryAtMs !== null && nowMs - input.lastRecoveryAtMs < input.cooldownMs)
    return deny("cooldown", episodeKey);
  return { eligible: true, reason: idle ? "eligible_idle" : "eligible_stall", episodeKey };
}
