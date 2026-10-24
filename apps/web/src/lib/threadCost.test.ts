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
    runs: [
      {
        id: "run:1",
        rootNodeId: "root",
        providerThreadId: `pt:${model}`,
        modelSelection: { model },
      },
    ],
    attempts: [{ id: "attempt:1", runId: "run:1" }],
    providerThreads: [
      {
        id: `pt:${model}`,
        nativeMetadata:
          reportedModel === undefined ? null : { modelSelection: { model: reportedModel } },
      },
    ],
    providerTurns: turns.map((turn, index) => ({
      id: `turn:${model}:${index}`,
      nodeId: "root",
      providerThreadId: `pt:${model}`,
      runAttemptId: "attempt:1",
      servedModel: reportedModel ?? model,
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
            reasoningOutputTokens: 25,
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
      incomplete: true,
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
    expect(estimate.parent).toEqual({ usd: expect.closeTo(3.15, 10), partial: false });
    expect(estimate.subagents).toEqual({ usd: expect.closeTo(0.45 + 0.07, 10), partial: false });
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
    // Only the subagents are partial; the parent's own price is exact.
    expect(estimate.parent).toEqual({ usd: expect.closeTo(3.15, 10), partial: false });
    expect(estimate.subagents).toEqual({ usd: 0, partial: true });
    expect(estimate.rows.map((row) => row.costUsd)).toEqual([
      expect.closeTo(3.15, 10),
      null,
      null,
      null,
    ]);
  });
  it("includes child costs when the parent has no own usage", () => {
    const estimate = estimateThreadCost(
      [source("parent", 0, projection("parent-model", [])), source("child", 1, child)],
      new Map([["child-model", perMillion(1, 5)]]),
    );
    expect(estimate.totalUsd).toBeCloseTo(0.45);
    expect(estimate.partial).toBe(false);
  });

  it("keeps missing and in-flight usage unknown, but cancelled unstarted turns cost nothing", () => {
    for (const value of [
      projection("missing", [{}]),
      projection("running", [{ status: "running" }]),
      null,
    ]) {
      const estimate = estimateThreadCost([source("parent", 0, value)], new Map());
      expect(estimate.partial).toBe(true);
      expect(estimate.rows[0]?.costUsd).toBeNull();
    }
    const cancelled = estimateThreadCost(
      [source("parent", 0, projection("unused", [{ status: "cancelled", startedAt: null }]))],
      new Map(),
    );
    expect(cancelled.partial).toBe(false);
    expect(cancelled.totalUsd).toBe(0);
  });

  it("does not count duplicate sources or mirrored native turns twice", () => {
    const estimate = estimateThreadCost(
      [
        source("parent", 0, parent),
        source("parent", 1, parent),
        source("native-mirror", 1, parent),
        source("child", 1, child),
      ],
      new Map([
        ["parent-model", perMillion(3, 15, 0.3)],
        ["child-model", perMillion(1, 5)],
      ]),
    );
    expect(estimate.totalUsd).toBeCloseTo(3.6);
    expect(estimate.partial).toBe(false);
  });

  it("retains distinct turns on the same provider thread while deduplicating overlapping mirrors", () => {
    const mirror = {
      ...parent,
      providerTurns: [
        ...parent.providerTurns,
        { ...parent.providerTurns[0]!, id: "distinct-turn" },
      ],
    } as ThreadCostProjection;
    const estimate = estimateThreadCost(
      [source("parent", 0, parent), source("mirror", 1, mirror)],
      new Map([["parent-model", perMillion(3, 15, 0.3)]]),
    );
    expect(estimate.parent.usd).toBeCloseTo(3.15);
    expect(estimate.subagents.usd).toBeCloseTo(3.15);
    expect(estimate.totalUsd).toBeCloseTo(6.3);
    expect(estimate.partial).toBe(false);
  });

  it("keeps completed usage as a partial estimate while another turn is running", () => {
    const value = projection("parent-model", [
      { usage: { inputTokens: 1_000_000, outputTokens: 100_000 } },
      { status: "running", usage: { inputTokens: 9999, outputTokens: 9999 } },
    ]);
    const estimate = estimateThreadCost(
      [source("parent", 0, value)],
      new Map([["parent-model", perMillion(3, 15)]]),
    );
    expect(estimate.totalUsd).toBeCloseTo(4.5);
    expect(estimate.partial).toBe(true);
    expect(estimate.parent.partial).toBe(true);
    expect(estimate.rows[0]?.incompleteUsage).toBe(true);
  });

  it("sums every parent model into the parent subtotal when there are no subagents", () => {
    const twoModels = {
      ...parent,
      runs: [...parent.runs, { ...parent.runs[0]!, id: "run:2", providerThreadId: "pt2" }],
      attempts: [...parent.attempts, { id: "attempt:2", runId: "run:2" }],
      providerThreads: [{ id: "pt2", nativeMetadata: { modelSelection: { model: "glm-5.3" } } }],
      providerTurns: [
        ...parent.providerTurns,
        {
          ...parent.providerTurns[0]!,
          id: "turn:pt2",
          servedModel: "glm-5.3",
          providerThreadId: "pt2",
          runAttemptId: "attempt:2",
          turnTokenUsage: {
            ...parent.providerTurns[0]!.turnTokenUsage!,
            inputTokens: 100_000,
            cachedInputTokens: 0,
            outputTokens: 10_000,
          },
        },
      ],
    } as unknown as ThreadCostProjection;
    const estimate = estimateThreadCost(
      [source("parent", 0, twoModels)],
      new Map([
        ["parent-model", perMillion(3, 15, 0.3)],
        ["glm-5.3", perMillion(0.5, 2)],
      ]),
    );
    expect(estimate.rows.map((row) => row.model)).toEqual(["parent-model", "glm-5.3"]);
    expect(estimate.parent).toEqual({ usd: expect.closeTo(3.15 + 0.07, 10), partial: false });
    expect(estimate.subagents).toEqual({ usd: 0, partial: false });
    expect(estimate.totalUsd).toBeCloseTo(3.22, 10);
  });
  it("marks only the parent partial when its own model is unpriced", () => {
    const estimate = estimateThreadCost(
      sources,
      new Map([
        ["parent-model", null],
        ["child-model", perMillion(1, 5)],
        ["glm-5.3", perMillion(0.5, 2)],
      ]),
    );
    expect(estimate.parent).toEqual({ usd: 0, partial: true });
    expect(estimate.subagents).toEqual({ usd: expect.closeTo(0.52, 10), partial: false });
    expect(estimate.partial).toBe(true);
  });
});

// R1-F2: a provider-thread model selection is mutable, unlike owning run identity.
describe("R1-F2 historical model attribution", () => {
  const rates = new Map([
    ["provider/A", perMillion(0, 1)],
    ["provider/B", perMillion(0, 10)],
    ["default", perMillion(0, 0.25)],
  ]);

  function history(secondTurn = false, firstModel = "provider/A", selected = "provider/B") {
    const first = projection(firstModel, [{ usage: { inputTokens: 0, outputTokens: 1_000_000 } }]);
    const providerThreadId = first.providerTurns[0]!.providerThreadId;
    return {
      ...first,
      runs: [
        ...first.runs,
        {
          ...first.runs[0]!,
          id: "run:2",
          rootNodeId: "root:2",
          modelSelection: { model: "provider/B" },
        },
      ].slice(0, secondTurn ? 2 : 1),
      attempts: [
        { ...first.attempts[0]!, providerThreadId },
        { id: "attempt:2", runId: "run:2", providerThreadId },
      ].slice(0, secondTurn ? 2 : 1),
      providerThreads: [{ ...first.providerThreads[0]!, nativeMetadata: { modelSelection: { model: selected } } }],
      providerTurns: [
        ...first.providerTurns.map((turn) => ({ ...turn, servedModel: firstModel === "default" ? undefined : firstModel })),
        { ...first.providerTurns[0]!, id: "turn:2", nodeId: "root:2", runAttemptId: "attempt:2", servedModel: "provider/B" },
      ].slice(0, secondTurn ? 2 : 1),
    } as unknown as ThreadCostProjection;
  }

  it("does not reprice T1 after selecting B without any new tokens", () => {
    const before = estimateThreadCost([source("parent", 0, history(false, "provider/A", "provider/A"))], rates);
    expect(before.totalUsd).toBe(1);
    const after = estimateThreadCost([source("parent", 0, history())], rates);
    expect(after.totalUsd).toBe(1);
    expect(after.partial).toBe(false);
  });

  it("prices known A and B runs on one provider thread as 11 dollars, not 20", () => {
    const value = estimateThreadCost([source("parent", 0, history(true))], rates);
    expect(value.totalUsd).toBe(11);
    expect(value.partial).toBe(false);
  });

  it("does not price an unknown historical default route from either alias or current model", () => {
    const value = estimateThreadCost([source("parent", 0, history(false, "default"))], rates);
    expect(value.partial).toBe(true);
    expect(value.totalUsd).toBe(0);
    expect(value.rows[0]?.costUsd).toBeNull();
  });

  it("suppresses missing attempt evidence instead of selecting the first matching root", () => {
    const original = history();
    const value = {
      ...original,
      providerThreads: [],
      attempts: [],
      providerTurns: original.providerTurns.map((turn) => ({ ...turn, servedModel: undefined })),
      runs: [original.runs[0]!, { ...original.runs[0]!, id: "ambiguous-run", modelSelection: { model: "provider/B" } }],
    } as unknown as ThreadCostProjection;
    const estimate = estimateThreadCost([source("parent", 0, value)], rates);
    expect(estimate.partial).toBe(true);
    expect(estimate.totalUsd).toBe(0);
  });

  it("retains same-session parent and child subtotals without double-counting a mirror", () => {
    const parent = history(true);
    const child = { ...parent, providerTurns: parent.providerTurns.map((turn) => ({ ...turn, id: `child:${turn.id}` })) } as unknown as ThreadCostProjection;
    const estimate = estimateThreadCost([
      source("parent", 0, parent),
      source("child", 1, child),
      source("mirror", 2, child),
    ], rates);
    expect(estimate.parent).toEqual({ usd: 11, partial: false });
    expect(estimate.subagents).toEqual({ usd: 11, partial: false });
    expect(estimate.totalUsd).toBe(22);
  });
});


describe("scoped served-model evidence", () => {
  it.each([undefined, null])("leaves legacy or mixed evidence %s unknown even with requested/current prices", (servedModel) => {
    const original = projection("requested-alias", [{ usage: { inputTokens: 0, outputTokens: 1_000_000 } }], "current-model");
    const value = { ...original, providerTurns: original.providerTurns.map((turn) => ({ ...turn, servedModel })) };
    const estimate = estimateThreadCost([source("parent", 0, value)], new Map([
      ["requested-alias", perMillion(0, 1)], ["current-model", perMillion(0, 10)],
    ]));
    expect(estimate.totalUsd).toBe(0);
    expect(estimate.partial).toBe(true);
    expect(estimate.rows[0]?.costUsd).toBeNull();
  });
});
