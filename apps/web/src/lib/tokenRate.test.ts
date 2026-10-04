import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { completedTurnTokenRate, formatTokenRate, latestTokenRateTurn } from "./tokenRate";

function turn(overrides: Partial<OrchestrationV2ProviderTurn> = {}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make("turn:one"),
    providerThreadId: ProviderThreadId.make("provider-thread:z-old"),
    nodeId: NodeId.make("root:one"),
    runAttemptId: RunAttemptId.make("attempt:one"),
    nativeTurnRef: null,
    ordinal: 1,
    status: "completed",
    startedAt: DateTime.makeUnsafe(0),
    completedAt: DateTime.makeUnsafe(4000),
    turnTokenUsage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 1000,
      outputTokens: 400,
      reasoningTokens: 100,
      hasSubagents: false,
    },
    ...overrides,
  };
}

describe("completedTurnTokenRate", () => {
  it("uses complete output totals and provider time, without double-counting reasoning", () => {
    expect(completedTurnTokenRate(turn())).toBe(100);
  });
  it("never mistakes growing adapter-shaped context snapshots for generated output", () => {
    const snapshot = (inputTokens: number) => ({
      usedTokens: inputTokens + 100,
      inputTokens,
      outputTokens: 100,
      updatedAt: "2026-10-03T10:00:00Z",
    });
    expect(
      completedTurnTokenRate(
        turn({
          status: "running",
          completedAt: null,
          turnTokenUsage: undefined,
          tokenUsage: snapshot(1000),
        }),
      ),
    ).toBeNull();
    expect(
      completedTurnTokenRate(
        turn({
          status: "running",
          completedAt: null,
          turnTokenUsage: undefined,
          tokenUsage: snapshot(10000),
        }),
      ),
    ).toBeNull();
    expect(completedTurnTokenRate(turn({ tokenUsage: snapshot(10000) }))).toBe(100);
  });
  it("does not accumulate last-message output snapshots even on a completed turn", () => {
    expect(
      completedTurnTokenRate(
        turn({
          turnTokenUsage: undefined,
          tokenUsage: { usedTokens: 10100, outputTokens: 100, updatedAt: "2026-10-03T10:00:01Z" },
        }),
      ),
    ).toBeNull();
  });
  it("hides unsupported, partial, or missing telemetry", () => {
    expect(completedTurnTokenRate(null)).toBeNull();
    expect(completedTurnTokenRate(turn({ startedAt: null }))).toBeNull();
    expect(completedTurnTokenRate(turn({ completedAt: null }))).toBeNull();
    expect(
      completedTurnTokenRate(
        turn({
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "partial",
            outputTokens: 400,
            hasSubagents: false,
          },
        }),
      ),
    ).toBeNull();
    expect(
      completedTurnTokenRate(
        turn({
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "unavailable",
            hasSubagents: false,
          },
        }),
      ),
    ).toBeNull();
  });
  it("reports zero output honestly and rejects invalid totals", () => {
    for (const outputTokens of [0, -1, NaN, Infinity]) {
      expect(
        completedTurnTokenRate(
          turn({
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              inputTokens: 10000,
              outputTokens,
              hasSubagents: false,
            },
          }),
        ),
      ).toBe(outputTokens === 0 ? 0 : null);
    }
  });
  it("rejects invalid duration and incomplete or unsuccessful turns", () => {
    expect(completedTurnTokenRate(turn({ completedAt: DateTime.makeUnsafe(0) }))).toBeNull();
    expect(completedTurnTokenRate(turn({ completedAt: DateTime.makeUnsafe(-1000) }))).toBeNull();
    for (const status of ["pending", "running", "failed", "cancelled", "interrupted"] as const)
      expect(completedTurnTokenRate(turn({ status }))).toBeNull();
  });
});

describe("formatTokenRate", () => {
  it("visibly labels throughput as a turn average", () => {
    expect(formatTokenRate(41.6)).toBe("42 tok/s (turn avg)");
    expect(formatTokenRate(0)).toBe("0 tok/s (turn avg)");
    expect(formatTokenRate(null)).toBeNull();
    expect(formatTokenRate(NaN)).toBeNull();
  });
});

function run(overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  return {
    id: RunId.make("run:one"),
    threadId: ThreadId.make("thread:one"),
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    providerThreadId: turn().providerThreadId,
    userMessageId: MessageId.make("message:one"),
    rootNodeId: turn().nodeId,
    activeAttemptId: turn().runAttemptId,
    status: "completed",
    requestedAt: DateTime.makeUnsafe(0),
    startedAt: DateTime.makeUnsafe(0),
    completedAt: DateTime.makeUnsafe(4000),
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}
function attempt(overrides: Partial<OrchestrationV2RunAttempt> = {}): OrchestrationV2RunAttempt {
  return {
    id: RunAttemptId.make("attempt:one"),
    runId: run().id,
    attemptOrdinal: 1,
    rootNodeId: turn().nodeId,
    providerInstanceId: run().providerInstanceId,
    providerThreadId: turn().providerThreadId,
    providerTurnId: turn().id,
    reason: "initial",
    status: "completed",
    startedAt: DateTime.makeUnsafe(0),
    completedAt: DateTime.makeUnsafe(4000),
    ...overrides,
  };
}
function projection(
  overrides: Partial<NonNullable<Parameters<typeof latestTokenRateTurn>[0]>> = {},
) {
  return { runs: [run()], attempts: [attempt()], providerTurns: [turn()], ...overrides };
}

describe("latestTokenRateTurn", () => {
  const switchedTurn = turn({
    id: ProviderTurnId.make("turn:switched"),
    providerThreadId: ProviderThreadId.make("provider-thread:a-new"),
    nodeId: NodeId.make("root:switched"),
    runAttemptId: RunAttemptId.make("attempt:switched"),
    startedAt: DateTime.makeUnsafe(10000),
    completedAt: DateTime.makeUnsafe(12000),
  });
  const switchedRun = run({
    id: RunId.make("run:switched"),
    ordinal: 2,
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerThreadId: switchedTurn.providerThreadId,
    rootNodeId: switchedTurn.nodeId,
    activeAttemptId: switchedTurn.runAttemptId,
  });
  const switchedAttempt = attempt({
    id: RunAttemptId.make("attempt:switched"),
    runId: switchedRun.id,
    providerThreadId: switchedTurn.providerThreadId,
    rootNodeId: switchedTurn.nodeId,
    providerInstanceId: switchedRun.providerInstanceId,
    providerTurnId: switchedTurn.id,
  });
  const switched = projection({
    runs: [switchedRun, run()],
    attempts: [switchedAttempt, attempt()],
    providerTurns: [switchedTurn, turn()],
  });

  it("selects the latest run across provider switches regardless of provider-id order", () => {
    expect(latestTokenRateTurn(switched)).toBe(switchedTurn);
    expect(completedTurnTokenRate(latestTokenRateTurn(switched))).toBe(200);
  });
  it("excludes subagent turns even if later, higher ordinal, and on the same attempt", () => {
    const child = turn({
      id: ProviderTurnId.make("turn:child"),
      nodeId: NodeId.make("node:child"),
      ordinal: 99,
    });
    expect(latestTokenRateTurn(projection({ providerTurns: [turn(), child] }))?.id).toBe(turn().id);
  });
  it("selects reconnect's current attempt, never its previous completed attempt", () => {
    const recovered = attempt({
      id: RunAttemptId.make("attempt:recovered"),
      attemptOrdinal: 2,
      providerThreadId: switchedTurn.providerThreadId,
      rootNodeId: switchedTurn.nodeId,
      providerTurnId: null,
      reason: "provider_recovery",
      status: "running",
    });
    const recoveringRun = run({ activeAttemptId: recovered.id, status: "running" });
    const data = projection({ runs: [recoveringRun], attempts: [recovered, attempt()] });
    expect(latestTokenRateTurn(data)).toBeNull();
    const running = turn({
      ...switchedTurn,
      runAttemptId: recovered.id,
      status: "running",
      completedAt: null,
    });
    expect(latestTokenRateTurn({ ...data, providerTurns: [running, turn()] })).toBe(running);
    expect(
      completedTurnTokenRate(latestTokenRateTurn({ ...data, providerTurns: [running, turn()] })),
    ).toBeNull();
    expect(latestTokenRateTurn({ ...data, attempts: [attempt()] })).toBeNull();
  });
  it("prefers a running run over queued work and hides its old completed provider turn", () => {
    const active = run({ status: "running" });
    const queued = run({
      id: RunId.make("run:queued"),
      ordinal: 3,
      status: "queued",
      rootNodeId: null,
    });
    expect(latestTokenRateTurn(projection({ runs: [queued, active] }))).toBeNull();
    const running = turn({ status: "running", completedAt: null });
    expect(
      latestTokenRateTurn(projection({ runs: [queued, active], providerTurns: [running] })),
    ).toBe(running);
  });
  it("suppresses the previous average before the current run has a provider turn", () => {
    for (const status of ["preparing", "starting", "running", "waiting", "queued"] as const) {
      expect(
        latestTokenRateTurn(projection({ runs: [run(), { ...switchedRun, status }] })),
      ).toBeNull();
    }
  });
  it("ignores a held queued run, but never falls back from missing latest-run telemetry", () => {
    const queued = run({
      id: RunId.make("run:queued"),
      ordinal: 3,
      status: "queued",
      queueHeld: true,
    });
    expect(latestTokenRateTurn(projection({ runs: [queued, run()] }))?.id).toBe(turn().id);
    expect(latestTokenRateTurn({ ...switched, providerTurns: [turn()] })).toBeNull();
  });
  it("uses latest attempt ordinal if the run has no active pointer", () => {
    expect(
      latestTokenRateTurn(
        projection({
          runs: [run({ activeAttemptId: null })],
          attempts: [
            attempt({
              id: RunAttemptId.make("attempt:new"),
              attemptOrdinal: 2,
              providerTurnId: null,
            }),
            attempt(),
          ],
        }),
      ),
    ).toBeNull();
  });
  it("handles legacy turns without attempts using the run's root and provider thread", () => {
    const older = turn({ id: ProviderTurnId.make("turn:older"), runAttemptId: null });
    const newer = turn({ id: ProviderTurnId.make("turn:newer"), runAttemptId: null, ordinal: 2 });
    expect(
      latestTokenRateTurn(
        projection({
          runs: [run({ activeAttemptId: null })],
          attempts: [],
          providerTurns: [newer, older],
        }),
      ),
    ).toBe(newer);
  });
  it("returns no rate source without a run or an unambiguous root destination", () => {
    expect(latestTokenRateTurn(null)).toBeNull();
    expect(latestTokenRateTurn(projection({ runs: [] }))).toBeNull();
    expect(latestTokenRateTurn(projection({ providerTurns: [] }))).toBeNull();
    expect(
      latestTokenRateTurn(
        projection({ runs: [run({ activeAttemptId: null, rootNodeId: null })], attempts: [] }),
      ),
    ).toBeNull();
  });
});
