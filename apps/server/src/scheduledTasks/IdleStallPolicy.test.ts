import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { decideIdleStallRecovery, type IdleStallRecoveryInput } from "./IdleStallPolicy.ts";

const start = Date.UTC(2026, 9, 23, 12);
let nowMs = start + 120_000;
const providerInstanceId = ProviderInstanceId.make("provider-instance-test");
const runId = RunId.make("run:idle-stall");
const attemptId = RunAttemptId.make("attempt:idle-stall");
const providerThreadId = ProviderThreadId.make("provider:idle-stall");
const providerTurnId = ProviderTurnId.make("turn:idle-stall");
type Observation = NonNullable<IdleStallRecoveryInput["observation"]>;
type Event = Observation["events"][number];

function event(overrides: Partial<Event> = {}): Event {
  return {
    sequence: 10,
    occurredAtMs: start + 1_000,
    kind: "assistant",
    subjectId: "message:1",
    value: "hello",
    ...overrides,
  };
}
function fixture(overrides: Partial<IdleStallRecoveryInput> = {}): IdleStallRecoveryInput {
  return {
    enabled: true,
    taskId: "task:1",
    taskGeneration: "generation:1",
    nowMs,
    timeoutMs: 60_000,
    maxObservationAgeMs: 5_000,
    cooldownMs: 30_000,
    lastRecoveryAtMs: null,
    recoveredEpisodeKeys: [],
    run: {
      id: runId,
      threadId: ThreadId.make("thread:1"),
      activeAttemptId: attemptId,
      providerInstanceId,
      providerThreadId,
      status: "running",
      startedAt: DateTime.makeUnsafe(start),
      completedAt: null,
    },
    attempt: {
      id: attemptId,
      runId,
      providerInstanceId,
      providerThreadId,
      providerTurnId,
      status: "running",
      startedAt: DateTime.makeUnsafe(start),
      completedAt: null,
    },
    blockers: {
      manualStop: false,
      frozen: false,
      superseded: false,
      awaitingInput: false,
      finalizing: false,
      otherActiveOrQueuedRun: false,
    },
    observation: {
      runId,
      attemptId,
      providerInstanceId,
      providerThreadId,
      providerTurnId,
      observedAtMs: nowMs,
      completeSinceMs: start,
      visibility: "complete",
      liveness: "stale",
      failureId: "failure:event:1",
      activeOperations: [],
      events: [event()],
    },
    ...overrides,
  };
}
function observed(overrides: Partial<Observation>): IdleStallRecoveryInput {
  const input = fixture();
  return { ...input, observation: { ...input.observation!, ...overrides } };
}

describe("decideIdleStallRecovery", () => {
  beforeEach(() => {
    nowMs = start + 120_000;
  });

  it.each([undefined, false])(
    "requires explicit opt-in (%s); ordinary reminders stay outside this policy",
    (enabled) => {
      expect(decideIdleStallRecovery(fixture({ enabled }))).toEqual({
        eligible: false,
        reason: "disabled",
        episodeKey: null,
      });
    },
  );

  it("does not opt in when the flag is absent", () => {
    const input = { ...fixture() };
    delete input.enabled;
    expect(decideIdleStallRecovery(input).reason).toBe("disabled");
  });

  it("proposes only after the semantic quiet timeout with affirmative exact-attempt stale evidence", () => {
    expect(decideIdleStallRecovery(fixture())).toMatchObject({
      eligible: true,
      reason: "eligible_stall",
      episodeKey: expect.any(String),
    });
    expect(decideIdleStallRecovery(observed({ liveness: "active" })).reason).toBe(
      "not_idle_or_stale",
    );
    expect(decideIdleStallRecovery(observed({ liveness: "unknown" })).eligible).toBe(false);
    expect(decideIdleStallRecovery(observed({ failureId: null })).eligible).toBe(false);
  });

  it.each(["assistant", "reasoning", "tool", "child"] as const)(
    "changed %s content/lifecycle resets quiet time and episode identity",
    (kind) => {
      const first = event({ kind });
      const base = decideIdleStallRecovery(observed({ events: [first] }));
      const changed = observed({
        events: [
          first,
          event({
            kind,
            sequence: 20,
            occurredAtMs: nowMs - 1_000,
            value: "substantive advance/completed",
          }),
        ],
      });
      const result = decideIdleStallRecovery(changed);
      expect(result.reason).toBe("below_timeout");
      expect(result.episodeKey).not.toBe(base.episodeKey);
      nowMs += 60_000;
      expect(
        decideIdleStallRecovery({
          ...changed,
          nowMs,
          observation: { ...changed.observation!, observedAtMs: nowMs },
        }).eligible,
      ).toBe(true);
    },
  );

  it.each(["assistant", "reasoning", "tool", "child"] as const)(
    "duplicate %s reports do not advance progress or episode identity",
    (kind) => {
      const first = event({ kind });
      const before = decideIdleStallRecovery(observed({ events: [first] }));
      const after = decideIdleStallRecovery(
        observed({ events: [first, event({ kind, sequence: 20, occurredAtMs: nowMs - 1 })] }),
      );
      expect(after).toEqual(before);
    },
  );

  it("compares per semantic subject, not unrelated global revisions, heartbeats or TPS", () => {
    const first = event();
    const base = decideIdleStallRecovery(observed({ events: [first] }));
    const result = decideIdleStallRecovery(
      observed({
        events: [
          first,
          event({
            sequence: 11,
            occurredAtMs: start + 2_000,
            kind: "tool",
            subjectId: "tool:2",
            value: "done",
          }),
          event({ sequence: 15, occurredAtMs: start + 3_000 }),
          event({ sequence: 900, occurredAtMs: nowMs, kind: "heartbeat", value: "TPS:0" }),
        ],
      }),
    );
    expect(result.eligible).toBe(true);
    expect(JSON.parse(result.episodeKey!)[6]).toBe(11);
    expect(base.episodeKey).not.toBe(result.episodeKey);
  });

  it.each(["tool", "child"])(
    "protects a long bounded healthy %s despite a shorter quiet timeout",
    () => {
      expect(
        decideIdleStallRecovery(
          observed({ activeOperations: [{ deadlineAtMs: nowMs + 3_600_000 }] }),
        ).reason,
      ).toBe("protected_work");
    },
  );
  it.each([null, NaN, start + 1_000])(
    "unknown/expired operation deadline %s is not stalled proof",
    (deadlineAtMs) => {
      expect(
        decideIdleStallRecovery(observed({ activeOperations: [{ deadlineAtMs }] })).reason,
      ).toBe("observation_unknown");
    },
  );
  it.each(["buffered", "unknown"] as const)(
    "%s reasoning silence is unknown, never stale proof",
    (visibility) => {
      expect(decideIdleStallRecovery(observed({ visibility })).reason).toBe("observation_unknown");
    },
  );
  it.each([
    { completeSinceMs: start + 1 },
    { completeSinceMs: NaN },
    { observedAtMs: nowMs - 6_000 },
    { observedAtMs: start + 999_999 },
    { events: [event({ occurredAtMs: start - 1 })] },
    { events: [event({ occurredAtMs: start + 999_999 })] },
    { events: [event(), event({ sequence: 10 })] },
    { events: [event(), event({ sequence: 11, occurredAtMs: start })] },
  ])("fails closed for incomplete/stale/backwards/conflicting evidence %#", (overrides) => {
    expect(decideIdleStallRecovery(observed(overrides)).reason).toBe("observation_unknown");
  });

  it.each([
    "manualStop",
    "frozen",
    "superseded",
    "awaitingInput",
    "finalizing",
    "otherActiveOrQueuedRun",
  ] as const)("%s wins before any recovery", (guard) => {
    const input = fixture();
    expect(
      decideIdleStallRecovery({ ...input, blockers: { ...input.blockers, [guard]: true } }).reason,
    ).toBe("blocked");
  });
  it("does not infer a start from requestedAt/workStartedAt or queued status", () => {
    const input = fixture();
    expect(
      decideIdleStallRecovery({ ...input, run: { ...input.run!, startedAt: null } }).reason,
    ).toBe("not_started");
    expect(
      decideIdleStallRecovery({ ...input, attempt: { ...input.attempt!, startedAt: null } }).reason,
    ).toBe("not_started");
    for (const status of ["queued", "preparing", "starting"] as const) {
      expect(decideIdleStallRecovery({ ...input, run: { ...input.run!, status } }).reason).toBe(
        "not_started",
      );
    }
  });
  it("rejects a missing, superseded, mismatched run/attempt/provider owner", () => {
    const input = fixture();
    for (const candidate of [
      observed({ providerInstanceId: ProviderInstanceId.make("provider-instance-other") }),
      fixture({ run: null }),
      fixture({ attempt: null }),
      fixture({ observation: null }),
      { ...input, attempt: { ...input.attempt!, status: "superseded" as const } },
      { ...input, attempt: { ...input.attempt!, runId: RunId.make("run:other") } },
      { ...input, run: { ...input.run!, activeAttemptId: RunAttemptId.make("attempt:newer") } },
      observed({ providerThreadId: ProviderThreadId.make("provider:other") }),
      observed({ providerTurnId: ProviderTurnId.make("turn:other") }),
      { ...input, attempt: { ...input.attempt!, providerTurnId: null } },
    ])
      expect(decideIdleStallRecovery(candidate).reason).toBe("identity_unknown");
  });
  it.each(["waiting", "cancelled", "rolled_back"] as const)(
    "does not reinterpret %s as idle or stalled",
    (status) => {
      const input = fixture();
      expect(decideIdleStallRecovery({ ...input, run: { ...input.run!, status } }).eligible).toBe(
        false,
      );
    },
  );
  it("permits a proven idle terminal episode, not running or queued work", () => {
    const input = observed({ liveness: "idle", failureId: null });
    expect(decideIdleStallRecovery(input).eligible).toBe(false);
    const idle = {
      ...input,
      run: {
        ...input.run!,
        status: "completed" as const,
        completedAt: DateTime.makeUnsafe(start + 2_000),
      },
      attempt: {
        ...input.attempt!,
        status: "completed" as const,
        completedAt: DateTime.makeUnsafe(start + 2_000),
      },
    };
    expect(decideIdleStallRecovery(idle).reason).toBe("eligible_idle");
    expect(
      decideIdleStallRecovery({
        ...idle,
        attempt: { ...idle.attempt, completedAt: DateTime.makeUnsafe(start - 1) },
      }).reason,
    ).toBe("observation_unknown");
    expect(
      decideIdleStallRecovery({
        ...idle,
        run: { ...idle.run, completedAt: DateTime.makeUnsafe(nowMs - 1) },
      }).reason,
    ).toBe("below_timeout");
    expect(
      decideIdleStallRecovery({ ...idle, attempt: { ...idle.attempt, completedAt: null } }).reason,
    ).toBe("observation_unknown");
    expect(
      decideIdleStallRecovery({
        ...idle,
        blockers: { ...idle.blockers, otherActiveOrQueuedRun: true },
      }).eligible,
    ).toBe(false);
  });
  it("uses an exact fake-clock timeout boundary and valid actual attempt start when there are no events", () => {
    nowMs = start + 59_999;
    expect(decideIdleStallRecovery(observed({ events: [] })).reason).toBe("below_timeout");
    nowMs += 1;
    expect(decideIdleStallRecovery(observed({ events: [] })).eligible).toBe(true);
  });
  it("keeps episode identity across ticks/restart and denies a recovered episode after cooldown expires", () => {
    const first = decideIdleStallRecovery(fixture());
    nowMs += 1_000_000;
    const restarted = fixture({
      recoveredEpisodeKeys: [first.episodeKey!],
      lastRecoveryAtMs: start + 120_000,
    });
    expect(decideIdleStallRecovery(fixture()).episodeKey).toBe(first.episodeKey);
    expect(decideIdleStallRecovery(restarted)).toEqual({
      eligible: false,
      reason: "already_recovered",
      episodeKey: first.episodeKey,
    });
  });
  it("cooldown suppresses a new meaningful-progress episode without changing its deterministic key", () => {
    const first = decideIdleStallRecovery(fixture());
    const input = observed({
      events: [event(), event({ sequence: 11, occurredAtMs: start + 2_000, value: "new" })],
    });
    const cooled = {
      ...input,
      recoveredEpisodeKeys: [first.episodeKey!],
      lastRecoveryAtMs: nowMs - 1_000,
    };
    const decision = decideIdleStallRecovery(cooled);
    expect(decision.reason).toBe("cooldown");
    expect(decision.episodeKey).not.toBe(first.episodeKey);
    nowMs += 30_000;
    expect(
      decideIdleStallRecovery({
        ...cooled,
        nowMs,
        observation: { ...cooled.observation!, observedAtMs: nowMs },
      }),
    ).toEqual({ eligible: true, reason: "eligible_stall", episodeKey: decision.episodeKey });
  });
  it("uses source failure and schedule generation identities, not wall clock buckets", () => {
    const first = decideIdleStallRecovery(fixture()).episodeKey;
    expect(decideIdleStallRecovery(observed({ failureId: "failure:event:2" })).episodeKey).not.toBe(
      first,
    );
    expect(
      decideIdleStallRecovery(fixture({ taskGeneration: "generation:2" })).episodeKey,
    ).not.toBe(first);
  });
  it.each([
    { nowMs: start - 1 },
    { timeoutMs: 0 },
    { cooldownMs: -1 },
    { maxObservationAgeMs: NaN },
    { lastRecoveryAtMs: Infinity },
    { lastRecoveryAtMs: start + 999_999 },
  ])("rejects invalid clocks/configuration %#", (overrides) => {
    expect(decideIdleStallRecovery(fixture(overrides)).eligible).toBe(false);
  });
});
