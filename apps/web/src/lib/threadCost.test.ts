import type { UsageModelRate } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  estimateThreadCost,
  threadCostModels,
  threadUsageByModel,
  type ThreadCostProjection,
  type ThreadCostSource,
} from "./threadCost";

const perMillion = (input: number, output: number, cacheRead = input): UsageModelRate => ({
  inputCostPerToken: input / 1_000_000,
  outputCostPerToken: output / 1_000_000,
  cacheReadCostPerToken: cacheRead / 1_000_000,
  cacheCreationCostPerToken: input / 1_000_000,
});

function projection(
  model: string,
  turns: ReadonlyArray<{
    status?: string;
    startedAt?: unknown;
    usage?: Record<string, unknown>;
  }>,
  reportedModel?: string,
): ThreadCostProjection {
  return {
    runs: [{ id: "run:1", rootNodeId: "root", providerThreadId: "pt", modelSelection: { model } }],
    attempts: [{ id: "attempt:1", runId: "run:1" }],
    providerThreads: [
      {
        id: "pt",
        nativeMetadata:
          reportedModel === undefined ? null : { modelSelection: { model: reportedModel } },
      },
    ],
    providerTurns: turns.map((turn, index) => ({
      id: `turn:${index}`,
      nodeId: "root",
      providerThreadId: "pt",
      runAttemptId: "attempt:1",
      status: turn.status ?? "completed",
      startedAt: "startedAt" in turn ? turn.startedAt : 0,
      turnTokenUsage:
        turn.usage === undefined
          ? undefined
          : {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: false,
              ...turn.usage,
            },
    })),
  } as unknown as ThreadCostProjection;
}

const source = (
  threadId: string,
  depth: number,
  value: ThreadCostProjection | null,
): ThreadCostSource => ({ threadId, title: threadId, depth, projection: value });

describe("threadUsageByModel", () => {
  it("splits cached input out of normalized input and sums ended turns by model", () => {
    const result = threadUsageByModel(
      projection("claude-opus-5-5", [
        {
          usage: {
            inputTokens: 1000,
            cachedInputTokens: 600,
            cacheCreationTokens: 100,
            outputTokens: 50,
          },
        },
        { usage: { inputTokens: 500, outputTokens: 25 } },
        { status: "running", usage: { inputTokens: 9999, outputTokens: 9999 } },
      ]),
    );
    expect(result).toEqual({
      usage: [
        {
          model: "claude-opus-5-5",
          uncachedInputTokens: 800,
          cachedInputTokens: 600,
          cacheCreationTokens: 100,
          outputTokens: 75,
        },
      ],
      incomplete: false,
    });
  });
  it("prices the provider-reported model and flags ended turns without totals", () => {
    const result = threadUsageByModel(
      projection("default", [{ usage: { inputTokens: 10, outputTokens: 1 } }, {}], "glm-5.3"),
    );
    expect(result.usage.map((entry) => entry.model)).toEqual(["glm-5.3"]);
    expect(result.incomplete).toBe(true);
    expect(
      threadUsageByModel(projection("m", [{ status: "cancelled", startedAt: null }])).incomplete,
    ).toBe(false);
  });
});

describe("estimateThreadCost", () => {
  const parent = projection("parent-model", [
    { usage: { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 } },
  ]);
  const child = projection("child-model", [
    { usage: { inputTokens: 200_000, outputTokens: 50_000 } },
  ]);
  const grandchild = projection("glm-5.3", [
    { usage: { inputTokens: 100_000, outputTokens: 10_000 } },
  ]);
  const sources = [
    source("parent", 0, parent),
    source("child", 1, child),
    source("grand", 2, grandchild),
  ];

  it("sums the parent and nested subagents, each at its own model's rate", () => {
    const rates = new Map([
      ["parent-model", perMillion(3, 15, 0.3)],
      ["child-model", perMillion(1, 5)],
      // A user override for a custom model arrives through the same rate lookup.
      ["glm-5.3", perMillion(0.5, 2)],
    ]);
    const estimate = estimateThreadCost(sources, rates);
    // parent: 0.5M*3 + 0.5M*0.3 + 0.1M*15 = 1.5 + 0.15 + 1.5
    // child: 0.2M*1 + 0.05M*5 = 0.45; grandchild: 0.1M*0.5 + 0.01M*2 = 0.07
    expect(estimate.totalUsd).toBeCloseTo(3.15 + 0.45 + 0.07, 10);
    expect(estimate.partial).toBe(false);
    expect(estimate.rows.map((row) => [row.threadId, row.depth, row.model])).toEqual([
      ["parent", 0, "parent-model"],
      ["child", 1, "child-model"],
      ["grand", 2, "glm-5.3"],
    ]);
    expect(threadCostModels(sources)).toEqual(["child-model", "glm-5.3", "parent-model"]);
  });
  it("excludes unpriced models and unloaded children, and marks the estimate partial", () => {
    const estimate = estimateThreadCost(
      [...sources, source("loading", 1, null)],
      new Map([
        ["parent-model", perMillion(3, 15, 0.3)],
        ["child-model", null],
      ]),
    );
    expect(estimate.totalUsd).toBeCloseTo(3.15, 10);
    expect(estimate.partial).toBe(true);
    expect(estimate.rows.map((row) => row.costUsd)).toEqual([
      expect.closeTo(3.15, 10),
      null,
      null,
      null,
    ]);
  });
});
