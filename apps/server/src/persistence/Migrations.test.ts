// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Exit from "effect/Exit";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { migrationManifest, runMigrations, verifyMigrationHistory } from "./Migrations.ts";
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

const seedLegacySentinels = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN running_background_task_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, created_at, updated_at,
       running_background_task_count, settled_override, settled_at)
    VALUES ('legacy-sentinel', 'project-sentinel', 'Preserve me', '{}',
      '2026-09-08', '2026-09-08', 7, 'settled', '2026-09-08T12:00:00Z')
  `;
  yield* sql`
    INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('message-sentinel', 'legacy-sentinel', 'assistant', 'Preserve message sentinel',
      0, '2026-09-08', '2026-09-08')
  `;
});

const legacySentinels = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    threads: yield* sql`SELECT * FROM projection_threads WHERE thread_id = 'legacy-sentinel'`,
    messages:
      yield* sql`SELECT * FROM projection_thread_messages WHERE message_id = 'message-sentinel'`,
  };
});

describe("divergent migration history", () => {
  it.effect("replays only idempotent migrations skipped by a divergent ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedDivergentDatabase;
      yield* seedLegacySentinels;
      const sentinels = yield* legacySentinels;
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
      // Added optional columns are null; every original value stays intact.
      const after = yield* legacySentinels;
      for (const [key, value] of Object.entries(sentinels.threads[0]!))
        assert.deepStrictEqual(after.threads[0]![key], value);
      for (const [key, value] of Object.entries(sentinels.messages[0]!))
        assert.deepStrictEqual(after.messages[0]![key], value);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        ledger,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

describe("migration history safety", () => {
  it.effect("creates and validates a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      yield* verifyMigrationHistory();
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([false, true])(
    "upgrades slot-33-only history ending at 49, missing settlement columns %s",
    (missingSettlement) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 49 });
        yield* seedLegacySentinels;
        if (missingSettlement) {
          yield* sql`ALTER TABLE projection_threads DROP COLUMN settled_override`;
          yield* sql`ALTER TABLE projection_threads DROP COLUMN settled_at`;
        }
        yield* sql`UPDATE effect_sql_migrations SET name = 'ProjectionThreadsRunningBackgroundTaskCount' WHERE migration_id = 33`;
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const sentinels = yield* legacySentinels;
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id >= 50),
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        yield* verifyMigrationHistory();
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 49 ORDER BY migration_id`,
          ledger,
        );
        const after = yield* legacySentinels;
        for (const [key, value] of Object.entries(sentinels.threads[0]!))
          assert.deepStrictEqual(after.threads[0]![key], value);
        for (const [key, value] of Object.entries(sentinels.messages[0]!))
          assert.deepStrictEqual(after.messages[0]![key], value);
        assert.deepStrictEqual(
          yield* sql`SELECT running_background_task_count, settled_override, settled_at FROM projection_threads WHERE thread_id = 'legacy-sentinel'`,
          [
            {
              running_background_task_count: 7,
              settled_override: missingSettlement ? null : "settled",
              settled_at: missingSettlement ? null : "2026-09-08T12:00:00Z",
            },
          ],
        );
        assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([
    "DROP TABLE projection_thread_pull_requests",
    "ALTER TABLE projection_threads DROP COLUMN title_state_json",
    "DROP TABLE orchestration_v2_events",
    "ALTER TABLE orchestration_v2_projection_threads DROP COLUMN provider_instance_id",
    "DROP TABLE orchestration_v2_legacy_imports",
    "DROP TABLE scheduled_tasks",
    "DROP INDEX orchestration_v2_events_instance_sequence_idx",
  ])("rejects incomplete split-V2 schema: %s", (damage) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedDivergentDatabase;
      yield* seedLegacySentinels;
      yield* sql.unsafe(damage);
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
      const sentinels = yield* legacySentinels;
      const error = yield* runMigrations().pipe(Effect.flip);
      assert.strictEqual(error._tag, "MigrationError");
      if (error._tag === "MigrationError") assert.match(error.message, /Incomplete legacy schema/);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        ledger,
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, schema);
      assert.deepStrictEqual(yield* legacySentinels, sentinels);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each(["unknown-name", "unknown-later", "missing-legacy", "missing-main"])(
    "rejects %s before changing schema or ledger",
    (variant) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedDivergentDatabase;
        if (variant === "unknown-name") {
          yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownFork' WHERE migration_id = 33`;
        } else if (variant === "unknown-later") {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (62, 'UnknownFork')`;
        } else {
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${variant === "missing-legacy" ? 61 : 12}`;
        }
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const schema = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
        assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          ledger,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, schema);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// Opt-in private fixture: never check user data into the repository. Each test
// copies an already verified backup and only opens its disposable copy writable.
const backupDir = process.env.T3_MIGRATION_BACKUP_DIR;
describe.skipIf(!backupDir)("private backup compatibility", () => {
  it.effect.each(["state.sqlite", "statev2.sqlite"])(
    "preserves copied backup %s rows and ledger, with the full current schema",
    (name) =>
      Effect.gen(function* () {
        assert.ok(backupDir);
        assert.ok(backupDir.startsWith("/Users/tarun/Backups/"));
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-regression-"));
        const filename = NodePath.join(dir, name);
        try {
          NodeFS.copyFileSync(
            NodePath.join(backupDir, "data/Users/tarun/.t3-pr-2829/userdata", name),
            filename,
          );
          const schema = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const tables = yield* sql<{
              name: string;
            }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
            return yield* Effect.forEach(tables, ({ name }) =>
              Effect.gen(function* () {
                const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info("${name}")`);
                return { name, columns: columns.map((column) => column.name) };
              }),
            );
          });
          const expected = yield* Effect.gen(function* () {
            yield* runMigrations();
            return yield* schema;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const counts = Effect.gen(function* () {
              const tables = yield* sql<{
                name: string;
              }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
              return yield* Effect.forEach(tables, ({ name }) =>
                Effect.gen(function* () {
                  const [row] = yield* sql.unsafe<{ count: number }>(
                    `SELECT count(*) AS count FROM "${name}"`,
                  );
                  return { name, count: row!.count };
                }),
              );
            });
            const before = yield* counts;
            const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
            yield* runMigrations();
            yield* verifyMigrationHistory();
            yield* runMigrations();
            const after = yield* counts;
            for (const row of before)
              assert.deepStrictEqual(
                after.find((entry) => entry.name === row.name),
                row,
              );
            assert.deepStrictEqual(
              yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
              ledger,
            );
            assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
            const actual = yield* schema;
            for (const table of expected) {
              const found = actual.find((entry) => entry.name === table.name);
              assert.ok(found, `Missing current table ${table.name}`);
              for (const column of table.columns)
                assert.ok(found.columns.includes(column), `Missing ${table.name}.${column}`);
            }
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        } finally {
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
  );
});
