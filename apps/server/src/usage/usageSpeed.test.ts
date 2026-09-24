import { describe, expect, it } from "vite-plus/test";

import { aggregateSpeed, ClaudeSpeedReader, speedSampleFromOpenCodex } from "./usageSpeed.ts";

const openCodexEntry = (overrides: Record<string, unknown> = {}) => ({
  timestamp: 1_790_000_000_000,
  provider: "openai",
  model: "gpt-6-luna",
  resolvedModel: "gpt-6-luna",
  requestedEffort: "xhigh",
  requestedSpeedLabel: null,
  status: 200,
  durationMs: 10_000,
  firstOutputMs: null,
  usage: { outputTokens: 900, reasoningOutputTokens: 400 },
  attempts: [{ firstOutputMs: 1_000 }],
  ...overrides,
});

describe("speedSampleFromOpenCodex", () => {
  it("takes time to first token from the final attempt when the entry lacks it", () => {
    const sample = speedSampleFromOpenCodex(openCodexEntry());
    expect(sample).toMatchObject({
      harness: "codex",
      upstream: "openai",
      effort: "xhigh",
      speedTier: "standard",
      ttftMs: 1_000,
      outputTokens: 900,
      reasoningTokens: 400,
      ok: true,
    });
  });

  it("marks failures and ignores entries without timing", () => {
    expect(speedSampleFromOpenCodex(openCodexEntry({ status: 502 }))?.ok).toBe(false);
    expect(
      speedSampleFromOpenCodex(openCodexEntry({ requestedSpeedLabel: "fast" }))?.speedTier,
    ).toBe("fast");
    expect(speedSampleFromOpenCodex(openCodexEntry({ durationMs: 0 }))).toBeNull();
    expect(
      speedSampleFromOpenCodex(
        openCodexEntry({ tierOutcome: { fastOutcome: "applied" }, requestedSpeedLabel: undefined }),
      )?.speedTier,
    ).toBe("fast");
    expect(speedSampleFromOpenCodex(openCodexEntry({ firstOutputMs: 20_000 }))?.ttftMs).toBeNull();
  });
});

describe("ClaudeSpeedReader", () => {
  const line = (value: unknown) => JSON.stringify(value);
  const assistant = (id: string, timestamp: string, outputTokens: number) =>
    line({
      type: "assistant",
      timestamp,
      message: {
        id,
        model: "claude-haiku-4-5",
        usage: { output_tokens: outputTokens, speed: "standard" },
      },
    });

  it("measures from the prompt to the last content block of each message", () => {
    const reader = new ClaudeSpeedReader();
    reader.push(line({ type: "user", timestamp: "2026-09-24T00:00:00.000Z" }));
    reader.push(assistant("msg-1", "2026-09-24T00:00:02.000Z", 50));
    reader.push(assistant("msg-1", "2026-09-24T00:00:04.000Z", 50));
    reader.push(line({ type: "user", timestamp: "2026-09-24T00:00:05.000Z" }));
    reader.push(assistant("msg-2", "2026-09-24T00:00:06.000Z", 10));
    const samples = reader.samples();
    expect(samples.map((sample) => sample.durationMs)).toEqual([4_000, 1_000]);
    expect(samples[0]).toMatchObject({ outputTokens: 50, speedTier: "standard", ttftMs: null });
  });

  it("drops idle gaps and records without a preceding prompt", () => {
    const reader = new ClaudeSpeedReader();
    reader.push(assistant("orphan", "2026-09-24T00:00:02.000Z", 5));
    reader.push(line({ type: "user", timestamp: "2026-09-24T00:00:00.000Z" }));
    reader.push(assistant("idle", "2026-09-24T01:00:00.000Z", 5));
    expect(reader.samples()).toEqual([]);
  });
});

describe("aggregateSpeed", () => {
  it("weights rates by tokens and keeps failures out of speed figures", () => {
    const base = speedSampleFromOpenCodex(openCodexEntry())!;
    const rows = aggregateSpeed([
      base,
      { ...base, durationMs: 30_000, outputTokens: 300, ttftMs: 5_000 },
      { ...base, ok: false, durationMs: 100, outputTokens: 0, ttftMs: null },
    ]);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ requests: 3, failedRequests: 1, outputTokens: 1_200 });
    // 1200 tokens over 40s of successful time.
    expect(row!.outputTokensPerSecond).toBe(30);
    // 1200 tokens over (9s + 25s) after the first token.
    expect(row!.decodeTokensPerSecond).toBeCloseTo(35.3, 1);
    expect(row!.timeToFirstToken).toEqual({ medianMs: 1_000, p90Ms: 5_000 });
  });

  it("skips decode rates when the first token arrives at the very end", () => {
    const base = speedSampleFromOpenCodex(openCodexEntry())!;
    const [row] = aggregateSpeed([{ ...base, durationMs: 10_000, ttftMs: 9_990 }]);
    expect(row!.decodeTokensPerSecond).toBeNull();
    expect(row!.timeToFirstToken?.medianMs).toBe(9_990);
  });

  it("separates speed tiers and models", () => {
    const base = speedSampleFromOpenCodex(openCodexEntry())!;
    const rows = aggregateSpeed([
      base,
      { ...base, speedTier: "fast" },
      { ...base, model: "other" },
    ]);
    expect(rows).toHaveLength(3);
  });
});
