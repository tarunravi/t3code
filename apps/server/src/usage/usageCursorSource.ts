/**
 * CursorUsage - speed rows for Cursor turns run through T3 Code.
 *
 * Cursor keeps no timing on disk, but T3 Code's own projections record when
 * each Cursor turn started, first produced output, and finished. Tokens and
 * cost come from cursor.com through `cursorUsageReader.ts`.
 *
 * @module usageCursorSource
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { speedSampleFromCursorTurn, type CursorTurnRow, type SpeedSample } from "./usageSpeed.ts";

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
    const sql = yield* SqlClient.SqlClient;
    return CursorUsage.of({
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
      readTurnSpeed: () => Effect.succeed([]),
      ...implementation,
    }),
  );
