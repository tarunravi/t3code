import { describe, expect, it } from "@effect/vitest";
import { UsageDay } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as UsageProjectionSource from "./UsageProjectionSource.ts";

const window = {
  sinceDay: UsageDay.make("2026-10-27"),
  untilDay: UsageDay.make("2026-10-27"),
  timeZone: "UTC",
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const layer = UsageProjectionSource.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

describe("UsageProjectionSource", () => {
  it.effect(
    "reads native and delegated turns with their served models, disjoint cache counts and local zero cost",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT)`;
        yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, payload_json TEXT)`;
        yield* sql`CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT, thread_id TEXT, provider_thread_id TEXT, started_at TEXT, completed_at TEXT, payload_json TEXT)`;
        for (const [id, driver, isSubagent] of [
          ["parent", "claudeAgent", false],
          ["child", "omp", true],
        ] as const) {
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${encode({ title: id, lineage: { relationshipToParent: isSubagent ? "subagent" : null } })})`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES (${id}, ${encode({ driver, providerInstanceId: driver, nativeThreadRef: { nativeId: `native-${id}` } })})`;
          yield* sql`INSERT INTO orchestration_v2_projection_provider_turns VALUES (${id}, ${id}, ${id}, ${"2026-10-27T10:00:00Z"}, ${"2026-10-27T10:00:03Z"}, ${encode({ servedModel: isSubagent ? "sparksdirect/GLM-5.3-Flash" : "claude-opus-5-5", reportedCostUsd: isSubagent ? 0 : null, turnTokenUsage: { usageScope: "main_agent", hasSubagents: false, usageStatus: "complete", inputTokens: 100, cachedInputTokens: 20, cacheCreationTokens: 10, outputTokens: 50, reasoningTokens: 5 } })})`;
        }
        const source = yield* UsageProjectionSource.UsageProjectionSource;
        const result = yield* source.read(window);
        expect(result.records).toHaveLength(2);
        expect(result.records.find(({ provider }) => provider === "omp")).toMatchObject({
          reportedCostUsd: 0,
          thread: { threadId: "child", isSubagent: true },
          totals: { uncachedInputTokens: 70, cachedInputTokens: 20, cacheCreationTokens: 10 },
        });
        expect(
          UsageProjectionSource.usageOwners(result.records).get('["claude","native-parent"]'),
        ).toMatchObject({ threadId: "parent" });
        expect(
          UsageProjectionSource.usageOwners([
            ...result.records,
            { ...result.records[0]!, thread: result.threads[1]! },
          ]).get('["claude","native-parent"]'),
        ).toBeNull();
      }).pipe(Effect.provide(layer)),
  );
});
