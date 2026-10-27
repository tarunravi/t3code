import {
  UsageProviderKind,
  TurnTokenUsage,
  type UsageSummaryInput,
  type UsageThread,
} from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class UsageProjectionReadError extends Schema.TaggedError<UsageProjectionReadError>()(
  "UsageProjectionReadError",
  { cause: Schema.Defect() },
) {}

export interface ProjectionUsage {
  readonly records: readonly UsageRecord[];
  readonly threads: readonly UsageThread[];
}

export class UsageProjectionSource extends Context.Service<
  UsageProjectionSource,
  {
    readonly read: (
      input: UsageSummaryInput,
    ) => Effect.Effect<ProjectionUsage, UsageProjectionReadError>;
  }
>()("t3/usage/UsageProjectionSource") {}

const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));
const isProvider = Schema.is(UsageProviderKind);
interface UsageRow {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly nativeSessionId: string | null;
  readonly model: string | null;
  readonly usage: string;
  readonly cost: number | null;
  readonly isSubagent: number;
  readonly occurredAt: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return UsageProjectionSource.of({
    read: Effect.fn("UsageProjectionSource.read")(
      function* (input) {
        // Day filters use the requested IANA zone in the aggregator; the broad UTC bounds
        // cover every zone (including DST) without loading out-of-window history text.
        const since = DateTime.formatIso(
          DateTime.subtract(DateTime.makeUnsafe(input.sinceTime ?? `${input.sinceDay}T00:00:00Z`), {
            days: 1,
          }),
        );
        const until = DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(input.untilTime ?? `${input.untilDay}T23:59:59.999Z`), {
            days: 1,
          }),
        );
        const rows = yield* sql<UsageRow>`
        SELECT turn.provider_turn_id AS id, thread.thread_id AS threadId,
          json_extract(thread.payload_json, '$.title') AS title,
          json_extract(native.payload_json, '$.providerInstanceId') AS providerInstanceId,
          json_extract(native.payload_json, '$.driver') AS driver,
          json_extract(native.payload_json, '$.nativeThreadRef.nativeId') AS nativeSessionId,
          json_extract(turn.payload_json, '$.servedModel') AS model,
          json_extract(turn.payload_json, '$.turnTokenUsage') AS usage,
          json_extract(turn.payload_json, '$.reportedCostUsd') AS cost,
          json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent' AS isSubagent,
          COALESCE(turn.completed_at, turn.started_at) AS occurredAt
        FROM orchestration_v2_projection_provider_turns turn
        JOIN orchestration_v2_projection_provider_threads native ON native.provider_thread_id = turn.provider_thread_id
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = turn.thread_id
        WHERE COALESCE(turn.completed_at, turn.started_at) >= ${since}
          AND COALESCE(turn.completed_at, turn.started_at) < ${until}
          AND json_type(turn.payload_json, '$.turnTokenUsage') = 'object'
      `.pipe(NodeSqliteClient.readOnly);
        const threads = new Map<string, UsageThread>();
        const records: UsageRecord[] = [];
        for (const row of rows) {
          const provider = row.driver === "claudeAgent" ? "claude" : row.driver;
          if (!isProvider(provider)) continue;
          const usage = decodeUsage(row.usage);
          if (usage._tag === "None" || usage.value.usageStatus === "unavailable") continue;
          const value = usage.value;
          const thread = {
            threadId: row.threadId,
            title: row.title ?? "Untitled thread",
            providerInstanceId: row.providerInstanceId,
            isSubagent: row.isSubagent === 1,
          };
          threads.set(`${thread.providerInstanceId}:${thread.threadId}`, thread);
          const cachedInputTokens = value.cachedInputTokens ?? 0;
          const cacheCreationTokens = value.cacheCreationTokens ?? 0;
          records.push({
            provider,
            thread,
            timestampMs: DateTime.toEpochMillis(DateTime.makeUnsafe(row.occurredAt)),
            model: row.model ?? "Unattested model",
            sessionId: row.nativeSessionId ?? `t3:${row.id}`,
            totals: {
              uncachedInputTokens: Math.max(
                0,
                (value.inputTokens ?? 0) - cachedInputTokens - cacheCreationTokens,
              ),
              cachedInputTokens,
              cacheCreationTokens,
              outputTokens: value.outputTokens ?? 0,
              reasoningTokens: value.reasoningTokens ?? 0,
            },
            reportedCostUsd: row.cost,
            speed: "standard",
            dedupeKey: `t3-turn:${row.id}`,
          });
        }
        return { records, threads: [...threads.values()] };
      },
      Effect.mapError((cause) => new UsageProjectionReadError({ cause })),
    ),
  });
});

export const layer = Layer.effect(UsageProjectionSource, make);
export const layerEmpty = Layer.succeed(UsageProjectionSource, {
  read: Effect.fn("UsageProjectionSource.read")(function () {
    return Effect.succeed({ records: [], threads: [] });
  }),
});

/** Shared native sessions cannot be assigned to a thread without per-response provenance. */
export function usageOwners(
  records: readonly UsageRecord[],
): ReadonlyMap<string, UsageThread | null> {
  const owners = new Map<string, UsageThread | null>();
  for (const record of records) {
    if (record.thread === undefined) continue;
    const key = JSON.stringify([record.provider, record.sessionId]);
    const previous = owners.get(key);
    owners.set(
      key,
      previous === undefined ||
        (previous?.threadId === record.thread.threadId &&
          previous.providerInstanceId === record.thread.providerInstanceId)
        ? record.thread
        : null,
    );
  }
  return owners;
}
