import { describe, expect, it } from "vite-plus/test";

import {
  TokenRateTracker,
  formatTokenRate,
  latestTokenUsage,
  tokenRateFromSamples,
} from "./tokenRate";

describe("tokenRateFromSamples", () => {
  it("computes tokens per second over a rolling window", () => {
    const samples = [
      { usedTokens: 100, nowMs: 0 },
      { usedTokens: 500, nowMs: 4_000 },
      { usedTokens: 900, nowMs: 8_000 },
    ];
    expect(tokenRateFromSamples(samples, 8_000, 8_000)).toBeCloseTo(100);
  });

  it("returns null with no samples", () => {
    expect(tokenRateFromSamples([], 10_000, 8_000)).toBeNull();
  });

  it("returns null with a single sample (no measurable span)", () => {
    expect(tokenRateFromSamples([{ usedTokens: 100, nowMs: 5_000 }], 5_000, 8_000)).toBeNull();
  });

  it("returns null when two samples share a timestamp (division by zero)", () => {
    const samples = [
      { usedTokens: 100, nowMs: 4_000 },
      { usedTokens: 300, nowMs: 4_000 },
    ];
    expect(tokenRateFromSamples(samples, 4_000, 8_000)).toBeNull();
  });

  it("measures a sparse tick pair using the base tick outside the window", () => {
    const samples = [
      { usedTokens: 100, nowMs: 1_000 },
      { usedTokens: 400, nowMs: 7_000 },
    ];
    expect(tokenRateFromSamples(samples, 8_000, 4_000)).toBeCloseTo(50);
  });

  it("ignores samples that fall entirely outside the window with no newer tick", () => {
    const samples = [
      { usedTokens: 100, nowMs: 0 },
      { usedTokens: 500, nowMs: 4_000 },
    ];
    expect(tokenRateFromSamples(samples, 20_000, 8_000)).toBeNull();
  });

  it("returns null when the counter went backwards (no negative rate)", () => {
    const samples = [
      { usedTokens: 900, nowMs: 0 },
      { usedTokens: 100, nowMs: 4_000 },
    ];
    expect(tokenRateFromSamples(samples, 4_000, 8_000)).toBeNull();
  });
});

describe("TokenRateTracker", () => {
  it("computes rate from pushed ticks", () => {
    const tracker = new TokenRateTracker();
    tracker.push(0, 0);
    tracker.push(800, 4_000);
    expect(tracker.rate(4_000, 8_000)).toBeCloseTo(200);
  });

  it("resets history when usedTokens drops (new turn)", () => {
    const tracker = new TokenRateTracker();
    tracker.push(5000, 0);
    tracker.push(5500, 1_000);
    tracker.push(100, 2_000);
    expect(tracker.rate(2_000, 8_000)).toBeNull();
    tracker.push(600, 6_000);
    expect(tracker.rate(6_000, 8_000)).toBeCloseTo(125);
  });

  it("ignores non-finite input", () => {
    const tracker = new TokenRateTracker();
    tracker.push(Number.NaN, 0);
    tracker.push(100, Number.POSITIVE_INFINITY);
    expect(tracker.rate(0, 8_000)).toBeNull();
  });
});

describe("formatTokenRate", () => {
  it("formats rounded rates", () => {
    expect(formatTokenRate(41.6)).toBe("42 tok/s");
    expect(formatTokenRate(0)).toBe("0 tok/s");
  });

  it("returns null when no rate exists", () => {
    expect(formatTokenRate(null)).toBeNull();
    expect(formatTokenRate(Number.NaN)).toBeNull();
  });
});

describe("latestTokenUsage", () => {
  it("returns the newest turn's usage", () => {
    expect(
      latestTokenUsage({
        providerTurns: [
          { tokenUsage: { usedTokens: 10 } },
          {},
          { tokenUsage: { usedTokens: 42 } },
        ] as never,
      }),
    ).toEqual({ usedTokens: 42 });
  });

  it("returns null without any usage", () => {
    expect(latestTokenUsage({ providerTurns: [{}] as never })).toBeNull();
    expect(latestTokenUsage(null)).toBeNull();
  });
});
