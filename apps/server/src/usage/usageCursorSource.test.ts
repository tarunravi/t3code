// @effect-diagnostics preferSchemaOverJson:off - fixtures seed projection payload JSON.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import { readCursorTurnSpeed } from "./usageCursorSource.ts";

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
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  );
});
