import type { OrchestrationV2ThreadProjection, UsageModelRate } from "@t3tools/contracts";

export type ThreadCostProjection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "attempts" | "providerTurns" | "providerThreads"
>;

export interface ThreadCostSource {
  readonly threadId: string;
  readonly title: string;
  /** 0 for the thread itself, 1 for its delegated subagents, and so on. */
  readonly depth: number;
  /** Null while a child thread's projection has not loaded. */
  readonly projection: ThreadCostProjection | null;
}

export interface ModelTokenUsage {
  readonly model: string;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
}

export interface ThreadCostRow {
  readonly threadId: string;
  readonly title: string;
  readonly depth: number;
  /** Null when the thread has no measured usage yet. */
  readonly model: string | null;
  readonly totalTokens: number;
  /** Null when usage or the model price is unavailable. */
  readonly costUsd: number | null;
  /** Some turns are unfinished or lack complete usage, or the thread has not loaded. */
  readonly incompleteUsage: boolean;
}

export interface ThreadCostSubtotal {
  readonly usd: number;
  /** True when any of this section's usage is unpriced or unmeasured, so `usd` is a lower bound. */
  readonly partial: boolean;
}

export interface ThreadCostEstimate {
  readonly totalUsd: number;
  /** True when any usage is unpriced or unmeasured, so `totalUsd` is a lower bound. */
  readonly partial: boolean;
  /** The thread itself (depth 0), across all its models. */
  readonly parent: ThreadCostSubtotal;
  /** Every delegated descendant (depth 1 and deeper). */
  readonly subagents: ThreadCostSubtotal;
  readonly rows: readonly ThreadCostRow[];
}

/**
 * Sums ended usage only when the provider attested a single served model for that turn.
 * Legacy, mixed-model and otherwise unattested usage stays unknown, never priced from
 * requested aliases or mutable provider-thread metadata.
 */
export function threadUsageByModel(projection: ThreadCostProjection): {
  readonly usage: readonly ModelTokenUsage[];
  readonly incomplete: boolean;
} {
  const byModel = new Map<string, ModelTokenUsage>();
  let incomplete = false;
  for (const turn of projection.providerTurns) {
    if (turn.status === "pending" || turn.status === "running") {
      if (turn.startedAt !== null) incomplete = true;
      continue;
    }
    const usage = turn.turnTokenUsage;
    if (usage === undefined || usage.usageStatus === "unavailable") {
      // A turn cancelled before it started never consumed tokens.
      if (turn.startedAt !== null) incomplete = true;
      continue;
    }
    if (usage.usageStatus === "partial") incomplete = true;
    const model = turn.servedModel;
    if (model == null) {
      incomplete = true;
      continue;
    }
    const cached = usage.cachedInputTokens ?? 0;
    const cacheCreation = usage.cacheCreationTokens ?? 0;
    const previous = byModel.get(model);
    byModel.set(model, {
      model,
      // Normalized input includes cache reads and writes.
      uncachedInputTokens:
        (previous?.uncachedInputTokens ?? 0) +
        Math.max(0, (usage.inputTokens ?? 0) - cached - cacheCreation),
      cachedInputTokens: (previous?.cachedInputTokens ?? 0) + cached,
      cacheCreationTokens: (previous?.cacheCreationTokens ?? 0) + cacheCreation,
      outputTokens: (previous?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    });
  }
  return { usage: [...byModel.values()], incomplete };
}

export function modelUsageCost(usage: ModelTokenUsage, rate: UsageModelRate): number {
  return (
    usage.uncachedInputTokens * rate.inputCostPerToken +
    usage.cachedInputTokens * rate.cacheReadCostPerToken +
    usage.cacheCreationTokens * rate.cacheCreationCostPerToken +
    usage.outputTokens * rate.outputCostPerToken
  );
}

function totalTokens(usage: ModelTokenUsage): number {
  return (
    usage.uncachedInputTokens +
    usage.cachedInputTokens +
    usage.cacheCreationTokens +
    usage.outputTokens
  );
}

/** Every model a set of threads used, for one rate lookup. */
export function threadCostModels(sources: readonly ThreadCostSource[]): readonly string[] {
  const models = new Set<string>();
  for (const source of sources) {
    if (source.projection === null) continue;
    for (const usage of threadUsageByModel(source.projection).usage) models.add(usage.model);
  }
  return [...models].toSorted();
}

/**
 * One row per thread and model. A missing rate excludes that usage from the
 * total and marks the estimate partial instead of guessing a price.
 */
export function estimateThreadCost(
  sources: readonly ThreadCostSource[],
  rates: ReadonlyMap<string, UsageModelRate | null>,
): ThreadCostEstimate {
  const rows: ThreadCostRow[] = [];
  const parent = { usd: 0, partial: false };
  const subagents = { usd: 0, partial: false };
  const seenThreads = new Set<string>();
  const seenTurns = new Set<string>();
  for (const source of sources) {
    if (seenThreads.has(source.threadId)) continue;
    seenThreads.add(source.threadId);
    const section = source.depth === 0 ? parent : subagents;
    const base = { threadId: source.threadId, title: source.title, depth: source.depth };
    if (source.projection === null) {
      section.partial = true;
      rows.push({ ...base, model: null, totalTokens: 0, costUsd: null, incompleteUsage: true });
      continue;
    }
    // Native subagents can be mirrored in more than one projection.
    // Count each provider turn only once across the entire descendant tree.
    const providerTurns = source.projection.providerTurns.filter((turn) => {
      if (seenTurns.has(turn.id)) return false;
      seenTurns.add(turn.id);
      return true;
    });
    const { usage, incomplete } = threadUsageByModel({
      ...source.projection,
      providerTurns,
    });
    if (incomplete) section.partial = true;
    if (usage.length === 0) {
      rows.push({
        ...base,
        model: null,
        totalTokens: 0,
        costUsd: incomplete ? null : 0,
        incompleteUsage: incomplete,
      });
      continue;
    }
    for (const entry of usage) {
      const rate = rates.get(entry.model) ?? null;
      const costUsd = rate === null ? null : modelUsageCost(entry, rate);
      if (costUsd === null) section.partial = true;
      else section.usd += costUsd;
      rows.push({
        ...base,
        model: entry.model,
        totalTokens: totalTokens(entry),
        costUsd,
        incompleteUsage: incomplete,
      });
    }
  }
  return {
    totalUsd: parent.usd + subagents.usd,
    partial: parent.partial || subagents.partial,
    parent,
    subagents,
    rows,
  };
}
