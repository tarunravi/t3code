import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import ProjectionThreadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import ProjectionThreadMessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import ProjectionThreadTitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";

// Ledger names recorded by an early orchestration V2 build on 2026-09-08.
const divergentLedger = [
  [33, "ProjectionThreadsRunningBackgroundTaskCount"],
  [50, "OrchestrationV2"],
  [51, "OrchestrationV2Subagents"],
  [52, "OrchestrationV2Foundation"],
  [53, "OrchestrationV2ProviderSessionBindings"],
  [54, "OrchestrationV2ThreadLaunchWorkflows"],
  [55, "ApplicationEventSource"],
  [56, "OrchestrationV2EffectCancellation"],
  [57, "ScheduledTasks"],
  [58, "LegacyV1ImportState"],
  [59, "ApplicationEventSequenceIndexes"],
  [60, "OrchestrationV2RecoveryIndexes"],
  [61, "OrchestrationV2ShellIndexes"],
] as const;

// That build's schema has everything this build's 33 and 50–56 add except
// auto_settle_disabled_at (054) and pull_request_files_viewed (053).
const seedDivergentDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 49 });
  yield* ProjectionThreadPullRequests;
  yield* ProjectionThreadMessageContext;
  yield* ProjectionThreadTitleState;
  yield* OrchestrationV2;
  yield* sql`
    UPDATE effect_sql_migrations SET name = ${divergentLedger[0][1]} WHERE migration_id = 33
  `;
  for (const [id, name] of divergentLedger.slice(1)) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  }
});

describe("divergent migration history", () => {
  it.effect("replays only idempotent migrations skipped by a divergent ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedDivergentDatabase;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const hasSchema = Effect.gen(function* () {
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_files_viewed'
        `;
        return {
          autoSettleDisabledAt: columns.some((column) => column.name === "auto_settle_disabled_at"),
          pullRequestFilesViewed: tables.length === 1,
        };
      });
      assert.deepStrictEqual(yield* hasSchema, {
        autoSettleDisabledAt: false,
        pullRequestFilesViewed: false,
      });

      // Replaying 052 or 055 here would fail on their existing column and indexes.
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* hasSchema, {
        autoSettleDisabledAt: true,
        pullRequestFilesViewed: true,
      });

      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        ledger,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
