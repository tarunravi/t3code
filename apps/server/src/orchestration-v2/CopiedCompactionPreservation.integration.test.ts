import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const occurredAt = "2026-09-03T00:00:00.000Z";
const maintenanceLayer = ProjectionMaintenance.layer.pipe(
  Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(Sqlite.layerMemory),
);

const insertEvent = Effect.fn(function* (
  ordinal: number,
  type: string,
  payload: unknown,
  version = 2,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, actor_kind, payload_json, metadata_json, application_event_version
    ) VALUES (
      ${`synthetic:${ordinal}`}, 'thread', 'synthetic:thread', ${ordinal}, ${type},
      ${occurredAt}, 'server', ${JSON.stringify(payload)}, '{}', ${version}
    )
  `;
});

it.effect.each([
  {
    type: "message.updated",
    owner: { attachments: [{ id: "historical-attachment", type: "file" }] },
  },
  { type: "message.updated", owner: { attachments: { futureOwner: "historical-attachment" } } },
  {
    type: "node.updated",
    owner: { checkpointScopeId: "scope:historical", nativeItemRef: { ref: "ref:historical" } },
  },
  { type: "node.updated", owner: { futureRefOwner: { ref: "refs/checkpoints/historical" } } },
] as const)("retains historical or unknown owner rows: %j", ({ type, owner }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* insertEvent(1, type, { id: "entity", text: "first" });
    yield* insertEvent(2, type, { id: "entity", text: "middle", ...owner });
    yield* insertEvent(3, type, { id: "entity", text: "latest" });
    const before = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
    const result = yield* maintenance.compactEventStore;
    assert.equal(result.deletedEventCount, 0);
    assert.deepEqual(yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`, before);
  }).pipe(Effect.provide(Layer.fresh(maintenanceLayer))),
);

it.effect.each([
  { version: 3, type: "thread.visited" },
  { version: 2, type: "thread.future-reference-owner" },
] as const)("refuses unknown history before deleting newer pages: %j", ({ version, type }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* insertEvent(1, type, { futureOwner: "refs/synthetic/history" }, version);
    for (let ordinal = 2; ordinal <= 122; ordinal++) {
      yield* insertEvent(ordinal, "thread.visited", { id: "synthetic:thread" });
    }
    const before = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(maintenance.compactEventStore)));
    assert.deepEqual(yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`, before);
  }).pipe(Effect.provide(Layer.fresh(maintenanceLayer))),
);

it.effect.each([false, null, "future"])(
  "retains explicit or unknown preservation marker values: %s",
  (preservationOnly) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* insertEvent(1, "thread.created", { id: "synthetic:thread" });
      yield* insertEvent(2, "thread.metadata-updated", {
        id: "synthetic:thread",
        preservationOnly,
      });
      yield* insertEvent(3, "thread.metadata-updated", { id: "synthetic:thread" });
      const before = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 0);
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`, before);
    }).pipe(Effect.provide(Layer.fresh(maintenanceLayer))),
);

const semanticRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    events: yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
    runs: yield* sql`SELECT * FROM orchestration_v2_projection_runs ORDER BY run_id`,
    messages: yield* sql`SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id`,
    turns: yield* sql`SELECT * FROM orchestration_v2_projection_turn_items ORDER BY ordinal`,
    scopes:
      yield* sql`SELECT * FROM orchestration_v2_projection_checkpoint_scopes ORDER BY scope_id`,
    checkpoints:
      yield* sql`SELECT * FROM orchestration_v2_projection_checkpoints ORDER BY checkpoint_id`,
    effects: yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
    receipts: yield* sql`SELECT * FROM orchestration_command_receipts ORDER BY command_id`,
    owners: yield* sql`SELECT * FROM synthetic_future_owners ORDER BY id`,
  };
});

it.effect.each([false, true])(
  "physically compacts a synthetic copy with durable preservation intent: %s",
  (preservationOnly) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "synthetic-copied-compaction-",
      });
      const original = path.join(directory, "original.sqlite");
      const copy = path.join(directory, "copy.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const modelSelection = { instanceId: "synthetic-provider", model: "never-invoked" };
        const initialThread = {
          id: "synthetic:thread",
          projectId: "synthetic:project",
          title: "Synthetic copy",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: "synthetic-provider",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: "synthetic:thread",
          },
          forkedFrom: null,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        yield* insertEvent(1, "thread.created", initialThread);
        yield* insertEvent(2, "run.created", {
          id: "run:active",
          threadId: "synthetic:thread",
          ordinal: 1,
          providerInstanceId: "synthetic-provider",
          modelSelection,
          providerThreadId: null,
          userMessageId: "message:1",
          rootNodeId: null,
          activeAttemptId: null,
          status: "running",
          requestedAt: occurredAt,
          startedAt: occurredAt,
          completedAt: null,
          checkpointId: "checkpoint:1",
          contextHandoffId: null,
        });
        yield* insertEvent(3, "message.updated", {
          id: "message:1",
          threadId: "synthetic:thread",
          runId: "run:active",
          nodeId: null,
          createdBy: "user",
          creationSource: "web",
          role: "user",
          text: "Keep attachment",
          attachments: [
            {
              type: "file",
              id: "attachment_1",
              name: "fixture.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
          streaming: false,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        });
        yield* insertEvent(4, "turn-item.updated", {
          id: "turn:1",
          threadId: "synthetic:thread",
          runId: "run:active",
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 7,
          status: "completed",
          title: null,
          startedAt: occurredAt,
          completedAt: occurredAt,
          updatedAt: occurredAt,
          type: "assistant_message",
          messageId: "message:1",
          text: "Retained turn",
          streaming: false,
        });
        yield* insertEvent(5, "checkpoint-scope.created", {
          id: "scope:1",
          threadId: "synthetic:thread",
          runId: "run:active",
          nodeId: "node:1",
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: directory,
          createdAt: occurredAt,
        });
        for (const ordinal of [0, 1]) {
          yield* insertEvent(6 + ordinal, "checkpoint.captured", {
            id: `checkpoint:${ordinal}`,
            threadId: "synthetic:thread",
            scopeId: "scope:1",
            runId: "run:active",
            nodeId: "node:1",
            parentCheckpointId: ordinal === 0 ? null : "checkpoint:0",
            ordinalWithinScope: ordinal,
            appRunOrdinal: 1,
            ref: `refs/synthetic/checkpoints/${ordinal}`,
            status: "ready",
            files: [],
            capturedAt: occurredAt,
          });
        }
        yield* insertEvent(8, "thread.message-appended", { legacy: "not yet imported" }, 1);
        yield* sql`INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
      ) VALUES ('command:pending', 'thread', 'synthetic:thread', ${occurredAt}, 8, 'accepted', 'legacy')`;
        for (const status of ["pending", "running"]) {
          yield* sql`INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ${`effect:${status}`}, 'command:pending', 'synthetic:thread', 'checkpoint.capture',
          ${JSON.stringify({ type: "checkpoint.capture", runId: "run:active", scopeId: "scope:1" })},
          ${status}, 0, ${occurredAt}, ${occurredAt}, ${occurredAt}
        )`;
        }
        if (preservationOnly) {
          yield* insertEvent(9, "thread.metadata-updated", {
            ...initialThread,
            preservationOnly: true,
          });
          yield* insertEvent(10, "thread.metadata-updated", {
            ...initialThread,
            title: "Late pre-freeze snapshot",
          });
        }
        assert.isTrue((yield* maintenance.rebuild).valid);
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projection = yield* projections.getThreadProjection(
          ThreadId.make("synthetic:thread"),
        );
        if (preservationOnly) assert.isTrue(projection.thread.preservationOnly);
        assert.equal(projection.runs[0]?.status, "running");
        assert.equal(projection.turnItems[0]?.ordinal, 7);
        assert.equal(projection.checkpoints[1]?.parentCheckpointId, "checkpoint:0");
        yield* sql`CREATE TABLE synthetic_future_owners (id TEXT PRIMARY KEY, payload BLOB)`;
        yield* sql`INSERT INTO synthetic_future_owners VALUES (
        'owner:1', ${JSON.stringify({
          threadId: "synthetic:thread",
          runId: "run:active",
          turnId: "turn:1",
          effectId: "effect:pending",
          attachment: "attachment:1",
          checkpointId: "checkpoint:1",
          parentCheckpointId: "checkpoint:0",
          ref: "refs/synthetic/checkpoints/1",
          occurredAt,
        })}
      )`;
        yield* sql`CREATE TABLE synthetic_free_pages (payload BLOB)`;
        yield* sql`INSERT INTO synthetic_free_pages VALUES (zeroblob(4194304))`;
        yield* sql`DROP TABLE synthetic_free_pages`;
      }).pipe(
        Effect.provide(
          ProjectionMaintenance.layer.pipe(
            Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
            Layer.provideMerge(Sqlite.layerFromPath(original)),
          ),
        ),
      );
      // Connections are closed before making the copy; no live database or capture is read.
      yield* fs.copyFile(original, copy);
      const originalBytes = yield* fs.readFile(original);
      const readRows = (filename: string) =>
        semanticRows.pipe(Effect.provide(NodeSqliteClient.layer({ filename, readonly: true })));
      const before = yield* readRows(copy);
      assert.deepEqual(
        Object.fromEntries(Object.entries(before).map(([key, rows]) => [key, rows.length])),
        {
          events: preservationOnly ? 10 : 8,
          runs: 1,
          messages: 1,
          turns: 1,
          scopes: 1,
          checkpoints: 2,
          effects: 2,
          receipts: 1,
          owners: 1,
        },
      );
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const result = yield* maintenance.compact(copy);
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        assert.isTrue((yield* projections.rebuild).valid);
        const sql = yield* SqlClient.SqlClient;
        const threadRows = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'synthetic:thread'
        `;
        if (preservationOnly)
          assert.isTrue(JSON.parse(threadRows[0]!.payload_json).preservationOnly);
        assert.deepEqual(yield* semanticRows, before);
      }).pipe(
        Effect.provide(
          ProjectionMaintenance.layer.pipe(
            Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
            Layer.provideMerge(NodeSqliteClient.layer({ filename: copy })),
          ),
        ),
      );
      assert.equal(result.deletedEventCount, 0);
      assert.equal(result.deletedReceiptCount, 0);
      assert.deepEqual(yield* readRows(copy), before);
      assert.deepEqual(yield* fs.readFile(original), originalBytes);
      assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
      yield* Effect.logInfo("SYNTHETIC_COPY_EVIDENCE", {
        beforeBytes: result.beforeBytes,
        afterBytes: result.afterBytes,
        retainedEventCount: before.events.length,
        retainedEffectCount: before.effects.length,
        retainedCheckpointCount: before.checkpoints.length,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
