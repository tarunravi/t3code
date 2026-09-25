import { describe, expect, it } from "vite-plus/test";

import {
  cursorSessionCookie,
  cursorUsageRecord,
  cursorUserIdFromAccessToken,
  parseCursorUsagePage,
  resolveCursorStateDbPath,
} from "./usageCursor.ts";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

const event = (overrides: Record<string, unknown> = {}) => ({
  timestamp: "1790000000000",
  model: "claude-4.5-sonnet-thinking",
  kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
  isHeadless: false,
  conversationId: "conversation-1",
  isTokenBasedCall: true,
  tokenUsage: {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 4_000,
    cacheWriteTokens: 500,
    totalCents: 12.5,
  },
  ...overrides,
});

describe("cursor session", () => {
  it("takes the account id after the last '|' of the JWT subject", () => {
    expect(cursorUserIdFromAccessToken(jwt({ sub: "google-oauth2|user_01ABC" }))).toBe(
      "user_01ABC",
    );
    expect(cursorUserIdFromAccessToken(jwt({ sub: "user_plain" }))).toBe("user_plain");
    expect(cursorUserIdFromAccessToken(jwt({ email: "a@b.c" }))).toBeNull();
    expect(cursorUserIdFromAccessToken("not-a-jwt")).toBeNull();
  });

  it("builds the dashboard cookie with an escaped separator", () => {
    expect(cursorSessionCookie("user_1", " token ")).toBe(
      "WorkosCursorSessionToken=user_1%3A%3Atoken",
    );
  });

  it("finds the state database per platform", () => {
    expect(
      resolveCursorStateDbPath({ platform: "darwin", homeDir: "/Users/me", environment: {} }),
    ).toBe("/Users/me/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    expect(
      resolveCursorStateDbPath({ platform: "linux", homeDir: "/home/me", environment: {} }),
    ).toBe("/home/me/.config/Cursor/User/globalStorage/state.vscdb");
    expect(
      resolveCursorStateDbPath({
        platform: "linux",
        homeDir: "/home/me",
        environment: { XDG_CONFIG_HOME: "/xdg" },
      }),
    ).toBe("/xdg/Cursor/User/globalStorage/state.vscdb");
  });
});

describe("cursorUsageRecord", () => {
  it("maps token fields and takes Cursor's reported cost", () => {
    expect(cursorUsageRecord(event())).toMatchObject({
      provider: "cursor",
      timestampMs: 1_790_000_000_000,
      model: "claude-4.5-sonnet-thinking",
      sessionId: "conversation-1",
      totals: {
        uncachedInputTokens: 120,
        cachedInputTokens: 4_000,
        cacheCreationTokens: 500,
        outputTokens: 30,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.125,
    });
  });

  it("leaves cost to the rate table when Cursor reports none", () => {
    const record = cursorUsageRecord(
      event({ tokenUsage: { inputTokens: 10, outputTokens: 5 }, conversationId: undefined }),
    );
    expect(record?.reportedCostUsd).toBeNull();
    expect(record?.totals.cacheCreationTokens).toBe(0);
    expect(record?.sessionId).toBe("");
  });

  it("skips events without a model, a timestamp, or anything to count", () => {
    expect(cursorUsageRecord(event({ model: "" }))).toBeNull();
    expect(cursorUsageRecord(event({ timestamp: "soon" }))).toBeNull();
    expect(cursorUsageRecord(event({ tokenUsage: undefined }))).toBeNull();
  });

  it("gives identical rows the same dedupe key", () => {
    expect(cursorUsageRecord(event())?.dedupeKey).toBe(cursorUsageRecord(event())?.dedupeKey);
    expect(cursorUsageRecord(event())?.dedupeKey).not.toBe(
      cursorUsageRecord(event({ timestamp: "1790000000001" }))?.dedupeKey,
    );
  });
});

describe("parseCursorUsagePage", () => {
  it("accepts event pages and empty windows, and rejects error envelopes", () => {
    expect(parseCursorUsagePage({ totalUsageEventsCount: 2, usageEventsDisplay: [1, 2] })).toEqual({
      totalCount: 2,
      events: [1, 2],
    });
    expect(parseCursorUsagePage({})).toEqual({ totalCount: 0, events: [] });
    expect(parseCursorUsagePage({ error: "not_authenticated" })).toBeNull();
    expect(parseCursorUsagePage("nope")).toBeNull();
  });
});
