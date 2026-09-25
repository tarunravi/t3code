// @effect-diagnostics nodeBuiltinImport:off - fixtures are real SQLite files on disk.
// @effect-diagnostics preferSchemaOverJson:off - fixtures seed projection payload JSON.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  CURSOR_USAGE_TTL_MS,
  CursorUsageError,
  makeCursorUsageReader,
  readCursorStateValue,
  readCursorTurnSpeed,
  type CursorUsageDependencies,
  type CursorUsageQuery,
} from "./usageCursorSource.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `${encode({ alg: "HS256" })}.${encode({ sub: "auth0|user_1" })}.signature`;
const HOUR_MS = 60 * 60 * 1000;

const event = (timestampMs: number, outputTokens = 10) => ({
  timestamp: String(timestampMs),
  model: "gpt-5",
  conversationId: `conversation-${timestampMs}`,
  tokenUsage: { inputTokens: 1, outputTokens },
});

/** A fake dashboard that serves `events` newest first in pages of 1,000. */
function fakeDashboard(input: {
  events: () => readonly ReturnType<typeof event>[];
  token?: () => string | null;
  fail?: () => boolean;
}) {
  const queries: { cookie: string; query: CursorUsageQuery }[] = [];
  const dependencies: CursorUsageDependencies = {
    readAccessToken: Effect.sync(() => (input.token ? input.token() : TOKEN)),
    fetchPage: (cookie, query) =>
      Effect.suspend(() => {
        queries.push({ cookie, query });
        if (input.fail?.()) {
          return Effect.fail(new CursorUsageError({ message: "cursor.com could not be reached." }));
        }
        const matching = input
          .events()
          .filter(
            (entry) =>
              Number(entry.timestamp) >= Number(query.startDate) &&
              Number(entry.timestamp) <= Number(query.endDate),
          )
          .toSorted((left, right) => Number(right.timestamp) - Number(left.timestamp));
        const start = (query.page - 1) * query.pageSize;
        return Effect.succeed({
          totalUsageEventsCount: matching.length,
          usageEventsDisplay: matching.slice(start, start + query.pageSize),
        });
      }),
  };
  return { dependencies, queries };
}

describe("makeCursorUsageReader", () => {
  it.effect("pages until a short page and sends the session cookie", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10 * HOUR_MS);
      const events = Array.from({ length: 2_500 }, (_, index) => event(HOUR_MS + index));
      const dashboard = fakeDashboard({ events: () => events });
      const reader = yield* makeCursorUsageReader(dashboard.dependencies);

      const read = yield* reader.read(0);

      assert.strictEqual(read.status, "ok");
      assert.strictEqual(read.status === "missing" ? 0 : read.records.length, 2_500);
      assert.deepStrictEqual(
        dashboard.queries.map(({ query }) => query.page),
        [1, 2, 3],
      );
      assert.strictEqual(
        dashboard.queries[0]!.cookie,
        `WorkosCursorSessionToken=user_1%3A%3A${TOKEN}`,
      );
      assert.deepStrictEqual(dashboard.queries[0]!.query, {
        page: 1,
        pageSize: 1000,
        startDate: "0",
        endDate: String(10 * HOUR_MS),
      });
    }),
  );

  it.effect("reuses events inside the TTL and refetches only the recent tail after it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10 * HOUR_MS);
      const events = [event(HOUR_MS), event(9 * HOUR_MS)];
      const dashboard = fakeDashboard({ events: () => events });
      const reader = yield* makeCursorUsageReader(dashboard.dependencies);

      yield* reader.read(0);
      yield* reader.read(2 * HOUR_MS);
      assert.strictEqual(dashboard.queries.length, 1);

      events.push(event(10 * HOUR_MS + 1_000));
      yield* TestClock.adjust(CURSOR_USAGE_TTL_MS);
      const read = yield* reader.read(0);

      assert.strictEqual(dashboard.queries.length, 2);
      // One hour of overlap before the previous fetch.
      assert.strictEqual(dashboard.queries[1]!.query.startDate, String(9 * HOUR_MS));
      assert.deepStrictEqual(
        read.status === "missing"
          ? []
          : read.records
              .map((record) => record.timestampMs)
              .toSorted((left, right) => left - right),
        [HOUR_MS, 9 * HOUR_MS, 10 * HOUR_MS + 1_000],
      );
    }),
  );

  it.effect("refetches the whole window when it reaches before the cached range", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10 * HOUR_MS);
      const dashboard = fakeDashboard({ events: () => [event(HOUR_MS)] });
      const reader = yield* makeCursorUsageReader(dashboard.dependencies);

      yield* reader.read(5 * HOUR_MS);
      const read = yield* reader.read(0);

      assert.strictEqual(dashboard.queries.at(-1)!.query.startDate, "0");
      assert.strictEqual(read.status === "missing" ? 0 : read.records.length, 1);
    }),
  );

  it.effect("reports Cursor as missing without a stored session", () =>
    Effect.gen(function* () {
      const dashboard = fakeDashboard({ events: () => [], token: () => null });
      const reader = yield* makeCursorUsageReader(dashboard.dependencies);
      assert.deepStrictEqual(yield* reader.read(0), { status: "missing" });
      assert.strictEqual(dashboard.queries.length, 0);
    }),
  );

  it.effect("fails without records, throttles retries, and serves stale events later", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10 * HOUR_MS);
      let failing = true;
      const dashboard = fakeDashboard({ events: () => [event(HOUR_MS)], fail: () => failing });
      const reader = yield* makeCursorUsageReader(dashboard.dependencies);

      assert.deepStrictEqual(yield* reader.read(0), {
        status: "failed",
        userId: null,
        records: [],
        message: "cursor.com could not be reached.",
      });
      yield* reader.read(0);
      assert.strictEqual(dashboard.queries.length, 1);

      failing = false;
      yield* TestClock.adjust(CURSOR_USAGE_TTL_MS);
      assert.strictEqual((yield* reader.read(0)).status, "ok");

      failing = true;
      yield* TestClock.adjust(CURSOR_USAGE_TTL_MS);
      const stale = yield* reader.read(0);
      assert.strictEqual(stale.status, "partial");
      assert.strictEqual(stale.status === "missing" ? 0 : stale.records.length, 1);
    }),
  );

  it.effect("rejects a session whose token names no account", () =>
    Effect.gen(function* () {
      const dashboard = fakeDashboard({ events: () => [], token: () => "opaque" });
      const reader = yield* makeCursorUsageReader(dashboard.dependencies);
      const read = yield* reader.read(0);
      assert.strictEqual(read.status, "failed");
      assert.strictEqual(dashboard.queries.length, 0);
    }),
  );
});

describe("readCursorStateValue", () => {
  it.effect("reads text and UTF-16 blob values and tolerates a missing database", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-state-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
      );
      const dbPath = NodePath.join(dir, "state.vscdb");
      const database = new NodeSqlite.DatabaseSync(dbPath);
      database.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
      const insert = database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
      insert.run("cursorAuth/accessToken", TOKEN);
      insert.run("utf16", Buffer.from("token-16", "utf16le"));
      database.close();

      assert.strictEqual(readCursorStateValue(dbPath, "cursorAuth/accessToken"), TOKEN);
      assert.strictEqual(readCursorStateValue(dbPath, "utf16"), "token-16");
      assert.strictEqual(readCursorStateValue(dbPath, "absent"), null);
      assert.strictEqual(readCursorStateValue(NodePath.join(dir, "none.vscdb"), "key"), null);
    }).pipe(Effect.scoped),
  );
});

describe("readCursorTurnSpeed", () => {
  it.effect("times Cursor turns from projections and ignores other drivers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const seedTurn = (input: {
        id: string;
        driver: string;
        status: string;
        startedAt: string;
        completedAt: string;
        firstItemAt: string;
      }) =>
        Effect.gen(function* () {
          const run = JSON.stringify({
            modelSelection: {
              model: "grok-4.7",
              options: [
                { id: "reasoning_effort", value: "high" },
                { id: "fastMode", value: true },
              ],
            },
          });
          yield* sql`INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
            VALUES (${`run-${input.id}`}, ${`thread-${input.id}`}, 1, ${input.driver}, ${input.driver}, 'completed', ${input.startedAt}, ${run})`;
          yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
            (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
            VALUES (${`attempt-${input.id}`}, 'thread', ${`run-${input.id}`}, 1, 'node', ${input.driver}, ${`pthread-${input.id}`}, 'completed', '{}')`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
            (provider_thread_id, provider, status, updated_at, payload_json)
            VALUES (${`pthread-${input.id}`}, ${input.driver}, 'idle', ${input.startedAt}, ${JSON.stringify({ driver: input.driver })})`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
            (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json)
            VALUES (${`turn-${input.id}`}, 'thread', ${`pthread-${input.id}`}, 'node', ${`attempt-${input.id}`}, 1, ${input.status}, ${input.startedAt}, ${input.completedAt}, '{}')`;
          for (const [suffix, type, startedAt] of [
            ["a", "reasoning", input.firstItemAt],
            ["b", "assistant_message", input.completedAt],
            ["c", "error", input.startedAt],
          ] as const) {
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items
              (turn_item_id, thread_id, provider_turn_id, ordinal, type, status, updated_at, payload_json)
              VALUES (${`item-${input.id}-${suffix}`}, 'thread', ${`turn-${input.id}`}, 1, ${type}, 'completed', ${startedAt}, ${JSON.stringify({ startedAt })})`;
          }
        });

      yield* seedTurn({
        id: "cursor",
        driver: "cursor",
        status: "completed",
        startedAt: "2026-09-22T15:39:32.000Z",
        completedAt: "2026-09-22T15:39:47.000Z",
        firstItemAt: "2026-09-22T15:39:35.500Z",
      });
      yield* seedTurn({
        id: "claude",
        driver: "claudeAgent",
        status: "completed",
        startedAt: "2026-09-22T15:40:00.000Z",
        completedAt: "2026-09-22T15:40:10.000Z",
        firstItemAt: "2026-09-22T15:40:01.000Z",
      });
      yield* seedTurn({
        id: "cursor-old",
        driver: "cursor",
        status: "completed",
        startedAt: "2026-09-01T00:00:00.000Z",
        completedAt: "2026-09-01T00:00:10.000Z",
        firstItemAt: "2026-09-01T00:00:01.000Z",
      });

      const samples = yield* readCursorTurnSpeed(
        Date.parse("2026-09-22T00:00:00.000Z"),
        Date.parse("2026-09-23T00:00:00.000Z"),
      );

      assert.deepStrictEqual(samples, [
        {
          harness: "cursor",
          upstream: null,
          model: "grok-4.7",
          effort: "high",
          speedTier: "fast",
          source: "cursor-turns",
          timestampMs: Date.parse("2026-09-22T15:39:47.000Z"),
          ok: true,
          outputTokens: 0,
          reasoningTokens: 0,
          durationMs: 15_000,
          ttftMs: 3_500,
        },
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
