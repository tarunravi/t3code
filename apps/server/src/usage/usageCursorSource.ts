/**
 * CursorUsage - Cursor's usage and speed, which no transcript on disk records.
 *
 * Tokens and cost come from the cursor.com dashboard API, authenticated with
 * the desktop app's own stored session. The token is read from Cursor's state
 * database on each fetch and never cached or persisted. Speed comes from the
 * Cursor turns T3 Code ran itself, whose timing is already in its projections.
 *
 * Fetched events are held in memory per account and reused for
 * {@link CURSOR_USAGE_TTL_MS}, so reopening or refreshing the page does not
 * call cursor.com each time. A stale cache refetches only its recent tail.
 *
 * @module usageCursorSource
 */
// @effect-diagnostics nodeBuiltinImport:off - Cursor's state database is read
// with node:sqlite, which has no Effect wrapper.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CURSOR_USAGE_EVENTS_URL,
  CURSOR_USAGE_ORIGIN,
  CURSOR_USAGE_PAGE_SIZE,
  cursorSessionCookie,
  cursorUsageRecord,
  cursorUserIdFromAccessToken,
  parseCursorUsagePage,
  resolveCursorStateDbPath,
} from "./usageCursor.ts";
import { speedSampleFromCursorTurn, type CursorTurnRow, type SpeedSample } from "./usageSpeed.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

/** How long fetched events, or a failure, are reused before cursor.com is asked again. */
export const CURSOR_USAGE_TTL_MS = 2 * 60 * 1000;

/** A refresh refetches this much before the last fetch, so late-settling events update. */
const REFETCH_OVERLAP_MS = 60 * 60 * 1000;

/** 1,000 events per page: up to 100,000 events, far beyond a 90-day window. */
const MAX_PAGES = 100;

const REQUEST_TIMEOUT_MS = 15_000;

export type CursorUsageRead =
  | { readonly status: "missing" }
  | {
      readonly status: "ok" | "partial" | "failed";
      /** The account the records belong to; null when the session could not be read. */
      readonly userId: string | null;
      readonly records: readonly UsageRecord[];
      readonly message: string | null;
    };

export interface CursorUsageQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly startDate: string;
  readonly endDate: string;
}

/** A bounded, user-presentable failure. It never carries the token. */
export class CursorUsageError extends Data.TaggedError("CursorUsageError")<{
  readonly message: string;
}> {}

export interface CursorUsageDependencies {
  /** Cursor's stored access token, or null when Cursor is not installed or signed in. */
  readonly readAccessToken: Effect.Effect<string | null, CursorUsageError>;
  readonly fetchPage: (
    cookie: string,
    query: CursorUsageQuery,
  ) => Effect.Effect<unknown, CursorUsageError>;
}

interface CachedEvents {
  readonly userId: string;
  /** Earliest instant the records cover. */
  readonly sinceMs: number;
  readonly fetchedAtMs: number;
  readonly records: readonly UsageRecord[];
  readonly message: string | null;
}

/**
 * Pages through every event in `[startMs, endMs]`. The dashboard reports a
 * total, but repeats rows at page boundaries while events arrive, so only a
 * short page proves the end. Repeated rows share a `dedupeKey` and the
 * aggregator drops them.
 */
const fetchEvents = Effect.fn("CursorUsage.fetchEvents")(function* (
  dependencies: CursorUsageDependencies,
  cookie: string,
  startMs: number,
  endMs: number,
) {
  const records: UsageRecord[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = yield* dependencies.fetchPage(cookie, {
      page,
      pageSize: CURSOR_USAGE_PAGE_SIZE,
      startDate: String(startMs),
      endDate: String(endMs),
    });
    const parsed = parseCursorUsagePage(body);
    if (parsed === null) {
      return yield* new CursorUsageError({
        message: "Cursor returned an unexpected usage response.",
      });
    }
    for (const event of parsed.events) {
      const record = cursorUsageRecord(event);
      if (record !== null) records.push(record);
    }
    if (parsed.events.length < CURSOR_USAGE_PAGE_SIZE) return { records, complete: true };
  }
  return { records, complete: false };
});

/**
 * The cached reader behind {@link CursorUsage}. `read` takes the earliest
 * instant the caller needs; events always run up to now.
 */
export const makeCursorUsageReader = Effect.fn("makeCursorUsageReader")(function* (
  dependencies: CursorUsageDependencies,
) {
  // One fetch at a time: concurrent scans wait and then reuse its result.
  const lock = yield* Semaphore.make(1);
  let cache: CachedEvents | null = null;
  let lastFailure: { readonly atMs: number; readonly read: CursorUsageRead } | null = null;

  const fromCache = (cached: CachedEvents): CursorUsageRead => ({
    status: cached.message === null ? "ok" : "partial",
    userId: cached.userId,
    records: cached.records,
    message: cached.message,
  });

  const refresh = Effect.fn("CursorUsage.refresh")(function* (
    windowStartMs: number,
    nowMs: number,
  ) {
    const token = yield* dependencies.readAccessToken;
    if (token === null) {
      cache = null;
      return { status: "missing" } as const;
    }
    const userId = cursorUserIdFromAccessToken(token);
    if (userId === null) {
      return yield* new CursorUsageError({ message: "Cursor's saved session is not readable." });
    }
    const reusable =
      cache !== null && cache.userId === userId && windowStartMs >= cache.sinceMs ? cache : null;
    const fetchFromMs =
      reusable === null
        ? windowStartMs
        : Math.max(reusable.sinceMs, reusable.fetchedAtMs - REFETCH_OVERLAP_MS);
    const fetched = yield* fetchEvents(
      dependencies,
      cursorSessionCookie(userId, token),
      fetchFromMs,
      nowMs,
    );
    const next: CachedEvents = {
      userId,
      sinceMs: reusable?.sinceMs ?? windowStartMs,
      fetchedAtMs: nowMs,
      records: [
        ...(reusable?.records.filter((record) => record.timestampMs < fetchFromMs) ?? []),
        ...fetched.records,
      ],
      message: fetched.complete
        ? null
        : `Only the latest ${fetched.records.length} Cursor usage events were read.`,
    };
    // An incomplete read covers less than it claims; do not extend it later.
    cache = fetched.complete ? next : null;
    return fromCache(next);
  });

  const read = (windowStartMs: number): Effect.Effect<CursorUsageRead> =>
    lock.withPermit(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        if (
          cache !== null &&
          windowStartMs >= cache.sinceMs &&
          nowMs - cache.fetchedAtMs < CURSOR_USAGE_TTL_MS
        ) {
          return fromCache(cache);
        }
        if (lastFailure !== null && nowMs - lastFailure.atMs < CURSOR_USAGE_TTL_MS) {
          return lastFailure.read;
        }
        return yield* refresh(windowStartMs, nowMs).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              lastFailure = null;
            }),
          ),
          Effect.catchTag("CursorUsageError", (error) =>
            Effect.sync(() => {
              // Older events are still right; only the newest are missing.
              const stale = cache !== null && windowStartMs >= cache.sinceMs ? cache : null;
              const failed: CursorUsageRead =
                stale === null
                  ? { status: "failed", userId: null, records: [], message: error.message }
                  : {
                      status: "partial",
                      userId: stale.userId,
                      records: stale.records,
                      message: error.message,
                    };
              lastFailure = { atMs: nowMs, read: failed };
              return failed;
            }),
          ),
        );
      }),
    );

  return { read } as const;
});

/**
 * Reads one key from Cursor's `ItemTable` without writing to the database.
 * VS Code stores values as text, but some builds write UTF-16LE blobs.
 */
export function readCursorStateValue(dbPath: string, key: string): string | null {
  if (!NodeFS.existsSync(dbPath)) return null;
  const database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1").get(key) as
      | { readonly value: unknown }
      | undefined;
    const value = row?.value;
    if (typeof value === "string") return value.trim() || null;
    if (value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      const utf16 = bytes.length % 2 === 0 && bytes.length > 1 && bytes[1] === 0;
      return bytes.toString(utf16 ? "utf16le" : "utf8").trim() || null;
    }
    return null;
  } finally {
    database.close();
  }
}

const liveDependencies = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const dbPath = resolveCursorStateDbPath({
    platform,
    homeDir: NodeOS.homedir(),
    environment,
  });

  const readAccessToken = Effect.try({
    try: () => readCursorStateValue(dbPath, "cursorAuth/accessToken"),
    catch: () => new CursorUsageError({ message: "Cursor's local session could not be read." }),
  });

  const fetchPage = (
    cookie: string,
    query: CursorUsageQuery,
  ): Effect.Effect<unknown, CursorUsageError> =>
    Effect.gen(function* () {
      const response = yield* httpClient.execute(
        HttpClientRequest.post(CURSOR_USAGE_EVENTS_URL).pipe(
          HttpClientRequest.setHeaders({ cookie, origin: CURSOR_USAGE_ORIGIN }),
          HttpClientRequest.bodyJsonUnsafe(query),
        ),
      );
      if (response.status === 401 || response.status === 403) {
        return yield* new CursorUsageError({
          message: "Cursor rejected its saved session. Sign in to Cursor again.",
        });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* new CursorUsageError({
          message: `cursor.com returned HTTP ${response.status} for usage events.`,
        });
      }
      return yield* response.json;
    }).pipe(
      Effect.timeout(REQUEST_TIMEOUT_MS),
      Effect.catch((error) =>
        Effect.fail(
          error instanceof CursorUsageError
            ? error
            : new CursorUsageError({ message: "cursor.com could not be reached." }),
        ),
      ),
    );

  return { readAccessToken, fetchPage } satisfies CursorUsageDependencies;
});

/** Cursor turns T3 Code finished in `[sinceMs, untilMs)`, timed from its own projections. */
export const readCursorTurnSpeed = Effect.fn("CursorUsage.readTurnSpeed")(function* (
  sinceMs: number,
  untilMs: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<CursorTurnRow>`
    SELECT turn.status AS status,
      turn.started_at AS "startedAt",
      turn.completed_at AS "completedAt",
      json_extract(run.payload_json, '$.modelSelection.model') AS model,
      json_extract(run.payload_json, '$.modelSelection.options') AS options,
      (
        SELECT MIN(json_extract(item.payload_json, '$.startedAt'))
        FROM orchestration_v2_projection_turn_items AS item
        WHERE item.provider_turn_id = turn.provider_turn_id
          AND item.type IN (
            'reasoning', 'assistant_message', 'command_execution', 'file_change',
            'file_search', 'web_search', 'dynamic_tool'
          )
      ) AS "firstOutputAt"
    FROM orchestration_v2_projection_provider_turns AS turn
    JOIN orchestration_v2_projection_provider_threads AS thread
      ON thread.provider_thread_id = turn.provider_thread_id
    JOIN orchestration_v2_projection_run_attempts AS attempt
      ON attempt.attempt_id = turn.run_attempt_id
    JOIN orchestration_v2_projection_runs AS run ON run.run_id = attempt.run_id
    WHERE json_extract(thread.payload_json, '$.driver') = 'cursor'
      AND turn.started_at >= ${DateTime.formatIso(DateTime.makeUnsafe(sinceMs))}
      AND turn.started_at < ${DateTime.formatIso(DateTime.makeUnsafe(untilMs))}
      AND turn.completed_at IS NOT NULL
  `;
  return rows.flatMap((row) => {
    const sample = speedSampleFromCursorTurn(row);
    return sample === null ? [] : [sample];
  });
});

export class CursorUsage extends Context.Service<
  CursorUsage,
  {
    /** Usage events from `windowStartMs` to now; see {@link makeCursorUsageReader}. */
    readonly read: (windowStartMs: number) => Effect.Effect<CursorUsageRead>;
    /** Null when T3 Code's turn history cannot be read. */
    readonly readTurnSpeed: (
      sinceMs: number,
      untilMs: number,
    ) => Effect.Effect<readonly SpeedSample[] | null>;
  }
>()("t3/usage/usageCursorSource/CursorUsage") {}

export const layer = Layer.effect(
  CursorUsage,
  Effect.gen(function* () {
    const reader = yield* makeCursorUsageReader(yield* liveDependencies);
    const sql = yield* SqlClient.SqlClient;
    return CursorUsage.of({
      read: reader.read,
      readTurnSpeed: (sinceMs, untilMs) =>
        readCursorTurnSpeed(sinceMs, untilMs).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catchCause(() => Effect.succeed(null)),
        ),
    });
  }),
);

/** No Cursor install and no Cursor turns, for suites that do not exercise Cursor. */
export const layerTest = (implementation?: Partial<typeof CursorUsage.Service>) =>
  Layer.succeed(
    CursorUsage,
    CursorUsage.of({
      read: () => Effect.succeed({ status: "missing" }),
      readTurnSpeed: () => Effect.succeed([]),
      ...implementation,
    }),
  );
