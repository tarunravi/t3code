// node:sqlite reads the CLI's live database without loading conversation text.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseUsage(row: Record<string, unknown>): UsageRecord | null {
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.session_id !== "string" ||
    !row.session_id ||
    typeof row.model_id !== "string" ||
    !row.model_id.trim() ||
    typeof row.started_at !== "number" ||
    !Number.isFinite(row.started_at)
  )
    return null;

  const input = tokens(row.input_tokens);
  const cachedInputTokens = tokens(row.cache_read_input_tokens);
  const cacheCreationTokens = tokens(row.cache_creation_input_tokens);
  const cache = cachedInputTokens + cacheCreationTokens;
  const outputTokens = tokens(row.output_tokens);
  const total = tokens(row.provider_total_tokens ?? row.computed_total_tokens);
  // ZCode's AI SDK v6 input includes cache. Its own stored-usage reader uses
  // the reported total to recognize older rows whose input excluded cache.
  const excludesCache =
    input > 0 &&
    cache > 0 &&
    total > 0 &&
    Math.abs(total - (input + cache + outputTokens)) < Math.abs(total - (input + outputTokens));
  const totals = {
    uncachedInputTokens: excludesCache ? input : Math.max(0, input - cache),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokens(row.reasoning_tokens)),
  };
  if (totalTokens(totals) === 0) return null;
  return {
    provider: "zcode",
    timestampMs: row.started_at,
    // Preserve the actual model ID, including case and routing prefixes, so
    // custom prices target the same ID the CLI used for this request.
    model: row.model_id.trim(),
    sessionId: row.session_id,
    totals,
    reportedCostUsd: null,
    fast: false,
    dedupeKey: `zcode:${row.id}`,
  };
}

export interface ZCodeUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

/**
 * model_usage is one upserted fact per request attempt, including subagents.
 * turn_usage and message history repeat those facts and must not be summed.
 * Re-query every scan: database mtime alone misses writes still in the WAL.
 */
export async function readZCodeUsage(
  dbPath: string,
  sinceMs: number,
): Promise<ZCodeUsageReadResult> {
  try {
    await NodeFSP.access(dbPath);
  } catch (cause) {
    const missing =
      typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
    return { files: [], missing, error: !missing };
  }

  const records: UsageRecord[] = [];
  let database: NodeSqlite.DatabaseSync | undefined;
  let error = false;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const statement = database.prepare(`
      SELECT id, session_id, model_id, started_at, input_tokens, output_tokens,
        reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        provider_total_tokens, computed_total_tokens
      FROM model_usage WHERE started_at >= ?
    `);
    let count = 0;
    for (const row of statement.iterate(sinceMs)) {
      const record = parseUsage(row);
      if (record !== null) records.push(record);
      if (++count % 256 === 0) await NodeTimersPromises.setImmediate();
    }
  } catch {
    error = true;
  } finally {
    database?.close();
  }
  return { files: [{ path: dbPath, records }], missing: false, error };
}
