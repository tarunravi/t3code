import { describe, expect, it } from "vite-plus/test";
import { mergeServedModel, sumTurnTokenUsage } from "@t3tools/provider-core/server/usage";
import { piMessageUsage, piReportedCost, piServedModel } from "./turnUsage.ts";

describe("Pi-family turn accounting", () => {
  it("normalizes disjoint cache counters and counts reasoning only inside output", () => {
    const messages = new Map<number, ReturnType<typeof piMessageUsage>>();
    messages.set(1, piMessageUsage({ input: 10, cacheRead: 20, cacheWrite: 5, output: 2 }));
    messages.set(
      1,
      piMessageUsage({ input: 10, cacheRead: 20, cacheWrite: 5, output: 12, reasoning: 7 }),
    );
    messages.set(2, piMessageUsage({ input: 4, output: 3 }));
    expect(sumTurnTokenUsage(messages.values(), true)).toMatchObject({
      usageStatus: "complete",
      inputTokens: 39,
      outputTokens: 15,
      cachedInputTokens: 20,
      cacheCreationTokens: 5,
      reasoningTokens: 7,
    });
  });
  it("keeps missing counts unavailable and recognizes explicit local zero cost", () => {
    expect(piMessageUsage({ totalTokens: 300 })).toMatchObject({ usageStatus: "unavailable" });
    expect(piMessageUsage({ input: -1, output: NaN })).toMatchObject({
      usageStatus: "unavailable",
    });
    expect(piReportedCost({ cost: { total: 0 } }, true)).toBe(0);
    expect(piReportedCost({ cost: { total: 0 } }, false)).toBeUndefined();
    expect(piReportedCost({ cost: { total: -1 } }, true)).toBeUndefined();
  });
  it("freezes native model identity rather than borrowing a requested alias", () => {
    const model = piServedModel({
      provider: "sparksdirect",
      model: "alias",
      responseModel: "DeepSeek-V4.1-Flash-1017",
    });
    expect(model).toBe("sparksdirect/DeepSeek-V4.1-Flash-1017");
    expect(mergeServedModel(undefined, model)).toBe(model);
    expect(mergeServedModel(model, model)).toBe(model);
    expect(mergeServedModel(model, "other/model")).toBeNull();
    expect(mergeServedModel(null, model)).toBeNull();
    expect(mergeServedModel(model, null)).toBeNull();
    expect(mergeServedModel(undefined, null)).toBeNull();
    expect(mergeServedModel(model, "<synthetic>")).toBe(model);
  });
});
