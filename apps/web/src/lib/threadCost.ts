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
  /** Null when the model has no known price. */
  readonly costUsd: number | null;
  /** Some ended turns lacked complete usage, or the thread has not loaded. */
  readonly incompleteUsage: boolean;
}

export interface ThreadCostEstimate {
  readonly totalUsd: number;
  /** True when any usage is unpriced or unmeasured, so `totalUsd` is a lower bound. */
  readonly partial: boolean;
  readonly rows: readonly ThreadCostRow[];
}

/**
 * Sums each ended provider turn's normalized usage by the model that served it.
 * The provider-reported model wins over the requested one (ZCode reports `default`
 * as its selection). In-flight turns are skipped until their totals arrive.
 */
export function threadUsageByModel(projection: ThreadCostProjection): {
  readonly usage: readonly ModelTokenUsage[];
  readonly incomplete: boolean;
} {
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));
  const attemptRunIds = new Map(projection.attempts.map((attempt) => [attempt.id, attempt.runId]));
  const reportedModels = new Map(
    projection.providerThreads.flatMap((thread) => {
      const model = thread.nativeMetadata?.modelSelection?.model;
      return model ? [[thread.id, model] as const] : [];
    }),
  );
  const byModel = new Map<string, ModelTokenUsage>();
  let incomplete = false;
  for (const turn of projection.providerTurns) {
    if (turn.status === "pending" || turn.status === "running") continue;
    const usage = turn.turnTokenUsage;
    if (usage === undefined || usage.usageStatus === "unavailable") {
      // A turn cancelled before it started never consumed tokens.
      if (turn.startedAt !== null) incomplete = true;
      continue;
    }
    if (usage.usageStatus === "partial") incomplete = true;
    const runId = turn.runAttemptId === null ? undefined : attemptRunIds.get(turn.runAttemptId);
    const run =
      (runId === undefined ? undefined : runsById.get(runId)) ??
      projection.runs.find(
        (candidate) =>
          candidate.rootNodeId === turn.nodeId &&
          candidate.providerThreadId === turn.providerThreadId,
      );
    const model = reportedModels.get(turn.providerThreadId) ?? run?.modelSelection.model;
    if (model === undefined) {
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
  let totalUsd = 0;
  let partial = false;
  for (const source of sources) {
    const base = { threadId: source.threadId, title: source.title, depth: source.depth };
    if (source.projection === null) {
      partial = true;
      rows.push({ ...base, model: null, totalTokens: 0, costUsd: null, incompleteUsage: true });
      continue;
    }
    const { usage, incomplete } = threadUsageByModel(source.projection);
    if (incomplete) partial = true;
    if (usage.length === 0) {
      rows.push({ ...base, model: null, totalTokens: 0, costUsd: 0, incompleteUsage: incomplete });
      continue;
    }
    for (const entry of usage) {
      const rate = rates.get(entry.model) ?? null;
      const costUsd = rate === null ? null : modelUsageCost(entry, rate);
      if (costUsd === null) partial = true;
      else totalUsd += costUsd;
      rows.push({
        ...base,
        model: entry.model,
        totalTokens: totalTokens(entry),
        costUsd,
        incompleteUsage: incomplete,
      });
    }
  }
  return { totalUsd, partial, rows };
}
