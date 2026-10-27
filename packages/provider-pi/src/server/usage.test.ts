import { describe, expect, it } from "vite-plus/test";
import { ompUsageReader, piUsageFormat } from "./usage.ts";

describe("omp usage history", () => {
  it("reads nested native messages and preserves local zero cost independently of Pi", () => {
    if (ompUsageReader.kind !== "transcripts") throw new Error("Expected transcript reader");
    const format = ompUsageReader.format;
    const state = format.state?.initial();
    format.parseLine('{"type":"session","id":"omp-session"}', state);
    const line = JSON.stringify({
      type: "message",
      id: "message-1",
      timestamp: "2026-10-27T10:00:00Z",
      message: {
        role: "assistant",
        provider: "sparksdirect",
        model: "DeepSeek-V4.1-Flash-1017",
        usage: { input: 100, output: 50, cacheRead: 20, cost: { total: 0 } },
      },
    });
    expect(format.parseLine(line, state)[0]).toMatchObject({
      provider: "omp",
      sessionId: "omp-session",
      model: "sparksdirect/DeepSeek-V4.1-Flash-1017",
      reportedCostUsd: 0,
      totals: { uncachedInputTokens: 100, cachedInputTokens: 20, outputTokens: 50 },
    });
    expect(piUsageFormat.parseLine(line, { sessionId: "pi-session" })[0]).toMatchObject({
      provider: "pi",
      reportedCostUsd: null,
    });
  });
});
