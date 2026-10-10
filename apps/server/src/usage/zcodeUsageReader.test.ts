// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { UsageAggregator } from "./usageAggregation.ts";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import { readZCodeUsage } from "./zcodeUsageReader.ts";

const START = Date.parse("2026-08-01T10:00:00Z");
const MODEL = "route/Custom-Model";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zcode-usage-"));
  directories.push(dir);
  const path = NodePath.join(dir, "db.sqlite");
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT, model_id TEXT, started_at INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
      provider_total_tokens INTEGER, computed_total_tokens INTEGER,
      logical_request_id TEXT, attempt_index INTEGER, query_source TEXT, status TEXT
    );
    CREATE TABLE turn_usage (input_tokens INTEGER, output_tokens INTEGER);
    CREATE TABLE message (data TEXT);
  `);
  const insert = (id: string, overrides: Record<string, string | number | null> = {}) => {
    const row = {
      id,
      session_id: "parent",
      model_id: MODEL,
      started_at: START,
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 60,
      provider_total_tokens: 120,
      computed_total_tokens: 120,
      logical_request_id: "request",
      attempt_index: 0,
      query_source: "main_turn",
      status: "completed",
      ...overrides,
    };
    db.prepare(`INSERT OR REPLACE INTO model_usage (${Object.keys(row).join(",")})
      VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`).run(...Object.values(row));
  };
  return { path, db, insert };
}

describe("readZCodeUsage", () => {
  it("counts request attempts and subagents once, excluding rollups and message copies", async () => {
    const { path, db, insert } = await fixture();
    try {
      insert("parent");
      insert("child", { session_id: "child", query_source: "subagent" });
      insert("retry", { attempt_index: 1, status: "error" });
      insert("cancelled", { status: "cancelled" });
      insert("parent"); // The native writer upserts the same attempt.
      insert("old", { started_at: START - 1 });
      insert("empty", {
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
      db.exec("INSERT INTO turn_usage VALUES (400, 80)");
      db.prepare("INSERT INTO message VALUES (?)").run(
        JSON.stringify({ tokens: { input: 400, output: 80 } }),
      );
      const result = await readZCodeUsage(path, START);
      expect(result).toMatchObject({ error: false, missing: false });
      const records = result.files.flatMap((file) => file.records);
      expect(records).toHaveLength(4);
      expect(new Set(records.map((record) => record.dedupeKey)).size).toBe(4);
      expect(records.find((record) => record.sessionId === "child")?.model).toBe(MODEL);
      expect(records[0]).toMatchObject({
        provider: "zcode",
        model: MODEL,
        reportedCostUsd: null,
        totals: {
          uncachedInputTokens: 30,
          cachedInputTokens: 60,
          cacheCreationTokens: 10,
          outputTokens: 20,
          reasoningTokens: 5,
        },
      });
      expect(records.reduce((sum, record) => sum + totalTokens(record.totals), 0)).toBe(480);
      const aggregator = new UsageAggregator({
        timeZone: "UTC",
        sinceDay: "2026-08-01",
        untilDay: "2026-08-01",
        rates: new Map(),
      });
      for (const record of [...records, ...records]) aggregator.add(record);
      const summary = aggregator.finish();
      expect(summary.duplicatesDropped).toBe(4);
      expect(summary.buckets[0]).toMatchObject({ records: 4, sessions: 2, unpricedRecords: 4 });
    } finally {
      db.close();
    }
  });

  it("reads WAL updates instead of reusing stale tokens or adding an upsert twice", async () => {
    const { path, db, insert } = await fixture();
    try {
      insert("same");
      const before = await readZCodeUsage(path, START);
      insert("same", { output_tokens: 40, provider_total_tokens: 140 });
      insert("new", { model_id: "another-model" });
      const after = await readZCodeUsage(path, START);
      expect(before.files[0]?.records[0]?.totals.outputTokens).toBe(20);
      expect(after.files[0]?.records).toHaveLength(2);
      expect(
        after.files[0]?.records.find((record) => record.dedupeKey === "zcode:same")?.totals
          .outputTokens,
      ).toBe(40);
      expect(
        after.files[0]?.records.find((record) => record.model === "another-model"),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("matches native accounting for legacy exclusive input and cache-only usage", async () => {
    const { path, db, insert } = await fixture();
    try {
      insert("inclusive");
      insert("exclusive", { input_tokens: 30 });
      insert("computed-total", { input_tokens: 30, provider_total_tokens: null });
      insert("cache-only", { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
      const records = (await readZCodeUsage(path, START)).files[0]!.records;
      expect(records.map((record) => record.totals.uncachedInputTokens)).toEqual([30, 30, 30, 0]);
      expect(records.map((record) => totalTokens(record.totals))).toEqual([120, 120, 120, 70]);
    } finally {
      db.close();
    }
  });

  it("bounds malformed token fields and omits zero usage and unusable identities", async () => {
    const { path, db, insert } = await fixture();
    try {
      insert("invalid", {
        input_tokens: -1,
        cache_read_input_tokens: "invalid",
        cache_creation_input_tokens: -3,
        output_tokens: 7.9,
        reasoning_tokens: 90,
      });
      insert("missing-model", { model_id: " " });
      insert("missing-time", { started_at: "invalid" });
      const records = (await readZCodeUsage(path, 0)).files[0]!.records;
      expect(records).toHaveLength(1);
      expect(records[0]?.totals).toEqual({
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 7,
        reasoningTokens: 7,
      });
    } finally {
      db.close();
    }
  });

  it("distinguishes missing, empty, unsupported and corrupt databases without creating files", async () => {
    const { path, db } = await fixture();
    db.close();
    expect(await readZCodeUsage(`${path}-missing`, 0)).toEqual({
      files: [],
      missing: true,
      error: false,
    });
    await expect(NodeFSP.access(`${path}-missing`)).rejects.toThrow();
    expect(await readZCodeUsage(path, 0)).toMatchObject({
      missing: false,
      error: false,
      files: [{ records: [] }],
    });
    const unsupported = new NodeSqlite.DatabaseSync(path);
    unsupported.exec("DROP TABLE model_usage");
    unsupported.close();
    expect(await readZCodeUsage(path, 0)).toMatchObject({ missing: false, error: true });
    await NodeFSP.writeFile(path, "not sqlite");
    expect(await readZCodeUsage(path, 0)).toMatchObject({ missing: false, error: true });
  });
});
