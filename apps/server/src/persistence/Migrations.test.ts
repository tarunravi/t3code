import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
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

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("migrates a fresh database through the whole manifest", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
