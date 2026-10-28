import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Cover usage reads without fetching each turn's potentially large JSON payload from disk.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_provider_turns_usage_idx
    ON orchestration_v2_projection_provider_turns (
      COALESCE(completed_at, started_at),
      thread_id, provider_thread_id, provider_turn_id,
      json_extract(payload_json, '$.servedModel'),
      json_extract(payload_json, '$.turnTokenUsage'),
      json_extract(payload_json, '$.reportedCostUsd')
    )
    WHERE json_type(payload_json, '$.turnTokenUsage') = 'object'
  `;
});
