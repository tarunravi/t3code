/**
 * Usage reporting contract.
 *
 * Each environment scans the provider CLIs' own on-disk session transcripts
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/sessions/**\/*.jsonl`,
 * `~/.grok/sessions/**\/updates.jsonl`) rather than relying on T3 Code's own
 * orchestration projections, so usage stays complete even for turns that were
 * never driven through T3 Code. This mirrors the approach `ccusage` takes.
 * Cursor keeps no token data on disk, so its usage comes from the cursor.com
 * dashboard API using the desktop app's own session.
 *
 * Environments return pre-aggregated `(day, hourStart?, provider, model)`
 * buckets. Raw transcript records never cross the wire.
 *
 * @module usage
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly. The
 * client renders partial coverage when an environment reports an older version
 * rather than failing the whole page.
 */
export const USAGE_CONTRACT_VERSION = 6 as const;

/**
 * Oldest {@link UsageSummary} version a current client will still merge.
 *
 * v5 and v6 only add `grok` and `cursor` to {@link UsageProviderKind}; v4
 * Claude/Codex buckets remain valid, so mixed-version environments keep those
 * totals instead of treating every older server as stale.
 */
export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals(["claude", "codex", "grok", "cursor"]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

/**
 * A calendar day in the reporting time zone, formatted `YYYY-MM-DD`.
 *
 * Days are bucketed server-side so that a turn always lands on the day the user
 * experienced it, not the UTC day.
 */
const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

/**
 * Why a bucket's cost is what it is.
 *
 * - `providerReported` - the transcript carried an explicit cost figure.
 * - `modelPriced` - we used a custom price override or the LiteLLM rate table.
 * - `unpriced` - tokens are known, rates are not. Counted in totals, excluded
 *   from cost.
 */
export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * Token counts for a bucket.
 *
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, and Anthropic
 * folds thinking into output), so it must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

/**
 * One `(day, hourStart?, provider, model)` cell. `hourStart` is the UTC start
 * instant of a rolling bucket and is present only for hourly requests.
 *
 * `costUsd` is the raw API-equivalent cost of these tokens. It is not money
 * spent: subscription plans bill separately. `unpricedRecords` counts records
 * whose tokens are included in the token totals but which contributed nothing
 * to `costUsd`.
 */
export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /**
   * What the cached input would have cost at full input rates minus what it
   * actually cost. Requires the rate table, so it is computed alongside cost
   * rather than derived on the client.
   */
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Distinct transcript sessions that contributed to this cell. */
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

/**
 * Identifies the physical transcript directory a source read from.
 *
 * Two environments on the same machine (worktree servers, for example) resolve
 * the same provider home and would otherwise double count. The client drops
 * duplicate fingerprints before merging.
 *
 * Cursor usage is account-wide rather than per machine, so its fingerprint
 * carries the account id in `volumeId` and `cursor.com` as host and path,
 * letting every environment signed into the same account collapse to one
 * source.
 */
export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /**
   * Filesystem identity of the transcript directory, as `device:inode`.
   *
   * Hostname and path alone are not enough: every Mac in a fleet resolves
   * `/Users/<user>/.claude`, so two machines that happen to share a hostname
   * would look like one source and have their usage silently dropped. The
   * device/inode pair is stable for two servers reading the same directory and
   * effectively never collides across machines. Empty when it cannot be read.
   */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  /** Records that parsed but carried no recognisable usage payload. */
  malformedRecords: NonNegativeInt,
  /**
   * Distinct transcript sessions seen under this directory. Buckets also carry
   * per-bucket session counts, but a session spans days and models, so summing
   * those overcounts; this is the figure clients should total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

/**
 * Provenance for the rate table, so the UI can be honest about how good the
 * cost figures are.
 */
export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a DST boundary.
   */
  timeZone: TrimmedNonEmptyString,
  /** Defaults to daily for older clients. */
  resolution: Schema.optional(UsageResolution),
  /** Inclusive UTC instant for an hourly rolling window. */
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  /** Exclusive UTC instant for an hourly rolling window. */
  untilTime: Schema.optional(TrimmedNonEmptyString),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: Schema.Array(UsageBucket),
  sources: Schema.Array(UsageSource),
  pricing: UsagePricing,
  /** Wall-clock cost of the scan, surfaced in diagnostics. */
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

/** A rolling window for request speed, as UTC instants. */
export const UsageSpeedInput = Schema.Struct({
  /** Inclusive UTC instant. */
  sinceTime: TrimmedNonEmptyString,
  /** Exclusive UTC instant. */
  untilTime: TrimmedNonEmptyString,
});
export type UsageSpeedInput = typeof UsageSpeedInput.Type;

/**
 * Where speed figures come from. OpenCodex measures each request it proxies,
 * including time to first token; Claude Code transcripts only allow an
 * end-to-end estimate from record timestamps; Cursor turns driven through T3
 * Code are timed from T3 Code's own turn history, without token counts.
 */
export const UsageSpeedSourceKind = Schema.Literals([
  "opencodex",
  "claude-transcripts",
  "cursor-turns",
]);
export type UsageSpeedSourceKind = typeof UsageSpeedSourceKind.Type;

const UsageLatencySpread = Schema.Struct({
  medianMs: Schema.Number,
  p90Ms: Schema.Number,
});

/** Speed of one harness/model/effort/tier combination over the window. */
export const UsageSpeedRow = Schema.Struct({
  /** The harness that sent the requests, e.g. `codex` or `claude`. */
  harness: TrimmedNonEmptyString,
  /** Upstream provider when it differs from the harness, e.g. `openai`, `combo`, `cursor`. */
  upstream: Schema.NullOr(Schema.String),
  model: TrimmedNonEmptyString,
  effort: Schema.NullOr(Schema.String),
  /** Requested speed tier, e.g. `fast` or `default`, when the source records it. */
  speedTier: Schema.NullOr(Schema.String),
  source: UsageSpeedSourceKind,
  requests: NonNegativeInt,
  failedRequests: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  /** Null when the source cannot observe the first token. */
  timeToFirstToken: Schema.NullOr(UsageLatencySpread),
  duration: UsageLatencySpread,
  /** Output tokens over total request time. */
  outputTokensPerSecond: Schema.NullOr(Schema.Number),
  /** Output tokens over the time after the first token; null without TTFT. */
  decodeTokensPerSecond: Schema.NullOr(Schema.Number),
});
export type UsageSpeedRow = typeof UsageSpeedRow.Type;

export const UsageSpeedSourceStatus = Schema.Struct({
  source: UsageSpeedSourceKind,
  status: Schema.Literals(["ok", "unavailable"]),
  /** Why the source was skipped, or a note such as a truncated history. */
  detail: Schema.NullOr(Schema.String),
  requests: NonNegativeInt,
});
export type UsageSpeedSourceStatus = typeof UsageSpeedSourceStatus.Type;

export const UsageSpeedSummary = Schema.Struct({
  readAt: Schema.String,
  sinceTime: TrimmedNonEmptyString,
  untilTime: TrimmedNonEmptyString,
  rows: Schema.Array(UsageSpeedRow),
  sources: Schema.Array(UsageSpeedSourceStatus),
});
export type UsageSpeedSummary = typeof UsageSpeedSummary.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
