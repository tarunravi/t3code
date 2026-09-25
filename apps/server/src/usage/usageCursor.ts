/**
 * Pure helpers for Cursor usage: session identity from the desktop app's JWT,
 * and the dashboard API's usage events shaped into {@link UsageRecord}s.
 *
 * Cursor writes no token data to disk. The only complete source is the
 * cursor.com dashboard API, which the desktop app itself calls with a
 * `WorkosCursorSessionToken` cookie built from its stored access token.
 * Network and SQLite access live in `usageCursorSource.ts`.
 *
 * @module usageCursor
 */
import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

export const CURSOR_USAGE_EVENTS_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";
export const CURSOR_USAGE_ORIGIN = "https://cursor.com";

/** The page size the dashboard itself requests; pagination stops on a shorter page. */
export const CURSOR_USAGE_PAGE_SIZE = 1000;

/**
 * The account id is the part of the JWT subject after the last `|`
 * (`auth0|user_123` becomes `user_123`). Null when the token is not a JWT
 * with a string subject; expiry is not checked, the API answers that.
 */
export function cursorUserIdFromAccessToken(accessToken: string): string | null {
  const segments = accessToken.trim().split(".");
  if (segments.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as unknown;
    if (typeof payload !== "object" || payload === null) return null;
    const subject = (payload as Record<string, unknown>)["sub"];
    if (typeof subject !== "string") return null;
    const userId = subject.slice(subject.lastIndexOf("|") + 1).trim();
    return userId.length > 0 ? userId : null;
  } catch {
    return null;
  }
}

/** The cookie the dashboard expects: `<userId>%3A%3A<jwt>` (an escaped `::`). */
export function cursorSessionCookie(userId: string, accessToken: string): string {
  return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken.trim()}`;
}

/**
 * Where the desktop app keeps its state database. macOS uses Application
 * Support; other platforms follow the XDG config home.
 */
export function resolveCursorStateDbPath(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly environment: NodeJS.ProcessEnv;
}): string {
  const suffix = ["Cursor", "User", "globalStorage", "state.vscdb"];
  if (input.platform === "darwin") {
    return [input.homeDir, "Library", "Application Support", ...suffix].join("/");
  }
  if (input.platform === "win32") {
    const appData = input.environment.APPDATA?.trim();
    return [appData || `${input.homeDir}\\AppData\\Roaming`, ...suffix].join("\\");
  }
  const configHome = input.environment.XDG_CONFIG_HOME?.trim();
  return [configHome || `${input.homeDir}/.config`, ...suffix].join("/");
}

export interface CursorUsagePage {
  /** Events matching the query across all pages, when the API reports it. */
  readonly totalCount: number | null;
  readonly events: readonly unknown[];
}

/**
 * Narrows one dashboard response. An empty object is a confirmed empty
 * window; anything else without an event array is an error envelope.
 */
export function parseCursorUsagePage(body: unknown): CursorUsagePage | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const total = record["totalUsageEventsCount"];
  const totalCount =
    typeof total === "number" && Number.isFinite(total) && total >= 0 ? Math.trunc(total) : null;
  const events = record["usageEventsDisplay"];
  if (Array.isArray(events)) return { totalCount, events };
  if (Object.keys(record).length === 0 || (totalCount !== null && events === undefined)) {
    return { totalCount: totalCount ?? 0, events: [] };
  }
  return null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function epochMs(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * One usage event as a record. Token fields follow ccusage's mapping:
 * `cacheWriteTokens` is cache creation, `cacheReadTokens` is cached input.
 * `totalCents` is Cursor's own token cost and wins over the rate table when
 * present. Events without a model or timestamp (plan fees, refunds) and
 * events with neither tokens nor cost (errored, not charged) are skipped. The
 * API exposes no event id, so `dedupeKey` is derived from the fields that
 * make a row repeated at a page boundary identical.
 */
export function cursorUsageRecord(event: unknown): UsageRecord | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  const timestampMs = epochMs(record["timestamp"]);
  const model = typeof record["model"] === "string" ? record["model"].trim() : "";
  if (timestampMs === null || model.length === 0) return null;

  const usage =
    typeof record["tokenUsage"] === "object" && record["tokenUsage"] !== null
      ? (record["tokenUsage"] as Record<string, unknown>)
      : {};
  const totals: UsageTokenTotals = {
    uncachedInputTokens: count(usage["inputTokens"]),
    cachedInputTokens: count(usage["cacheReadTokens"]),
    cacheCreationTokens: count(usage["cacheWriteTokens"]),
    outputTokens: count(usage["outputTokens"]),
    reasoningTokens: 0,
  };
  const totalCents = usage["totalCents"];
  const reportedCostUsd =
    typeof totalCents === "number" && Number.isFinite(totalCents) && totalCents >= 0
      ? totalCents / 100
      : null;
  if (reportedCostUsd === null && totalTokens(totals) === 0) return null;
  const conversationId =
    typeof record["conversationId"] === "string" ? record["conversationId"].trim() : "";

  return {
    provider: "cursor",
    timestampMs,
    model,
    sessionId: conversationId,
    totals,
    reportedCostUsd,
    dedupeKey: JSON.stringify([
      "cursor",
      timestampMs,
      model,
      conversationId,
      totals.uncachedInputTokens,
      totals.cachedInputTokens,
      totals.cacheCreationTokens,
      totals.outputTokens,
      reportedCostUsd,
    ]),
  };
}
