import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { completedTurnTokenRate, formatTokenRate, latestTokenRateTurn } from "./tokenRate";

function turn(overrides: Partial<OrchestrationV2ProviderTurn> = {}): OrchestrationV2ProviderTurn {
  return {
    id: "turn:one",
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
  } as OrchestrationV2ProviderTurn;
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
  it("rejects invalid duration and incomplete or unsuccessful turns", () => {
    expect(completedTurnTokenRate(turn({ completedAt: DateTime.makeUnsafe(0) }))).toBeNull();
    expect(completedTurnTokenRate(turn({ completedAt: DateTime.makeUnsafe(-1000) }))).toBeNull();
    for (const status of ["pending", "running", "failed", "cancelled", "interrupted"] as const)
      expect(completedTurnTokenRate(turn({ status }))).toBeNull();
  });
  it("does not leak stale rates between turns even when counters grow", () => {
    const old = turn();
    const next = turn({ id: "turn:two" as never, status: "running", completedAt: null });
    expect(completedTurnTokenRate(latestTokenRateTurn({ providerTurns: [old, next] }))).toBeNull();
    expect(
      completedTurnTokenRate(
        latestTokenRateTurn({
          providerTurns: [
            old,
            turn({
              id: next.id,
              startedAt: DateTime.makeUnsafe(10000),
              completedAt: DateTime.makeUnsafe(12000),
            }),
          ],
        }),
      ),
    ).toBe(200);
    expect(latestTokenRateTurn(null)).toBeNull();
    expect(latestTokenRateTurn({ providerTurns: [] })).toBeNull();
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
