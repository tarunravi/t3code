/**
 * I/O for request speed: the local OpenCodex management API and Claude Code
 * transcript files. Parsing and aggregation live in `usageSpeed.ts`.
 *
 * @module usageSpeedSources
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { UsageSpeedSourceStatus } from "@t3tools/contracts";

import { listTranscriptFiles } from "./usageTranscriptReader.ts";
import { ClaudeSpeedReader, speedSampleFromOpenCodex, type SpeedSample } from "./usageSpeed.ts";

/** 100 entries per page: up to 100,000 requests, about three busy months. */
const MAX_OPENCODEX_PAGES = 1_000;
const OPENCODEX_TIMEOUT_MS = 5_000;

interface SourceResult {
  readonly samples: readonly SpeedSample[];
  readonly status: UsageSpeedSourceStatus;
}

const unavailable = (source: UsageSpeedSourceStatus["source"], detail: string): SourceResult => ({
  samples: [],
  status: { source, status: "unavailable", detail, requests: 0 },
});

/** The OpenCodex home with a management token: `OPENCODEX_HOME`, then the usual locations. */
async function resolveOpenCodexHome(environment: NodeJS.ProcessEnv): Promise<string | null> {
  const candidates = [
    environment.OPENCODEX_HOME?.trim(),
    NodePath.join(NodeOS.homedir(), ".opencodex-work"),
    NodePath.join(NodeOS.homedir(), ".opencodex"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const home of candidates) {
    try {
      await NodeFSP.access(NodePath.join(home, "admin-api-token"), NodeFS.constants.R_OK);
      return home;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

async function readOpenCodexPort(home: string): Promise<number> {
  try {
    const config = JSON.parse(await NodeFSP.readFile(NodePath.join(home, "config.json"), "utf8"));
    const port = (config as { port?: unknown }).port;
    return typeof port === "number" && Number.isInteger(port) ? port : 10100;
  } catch {
    return 10100;
  }
}

const TIMESTAMP_PATTERN = /"timestamp":(\d{10,})/u;

/**
 * OpenCodex appends every request to `usage.jsonl`, the same records its
 * history API pages through 100 at a time. Streaming the file is seconds
 * where paging a busy month takes minutes.
 */
async function readOpenCodexLog(
  path: string,
  sinceMs: number,
  untilMs: number,
): Promise<readonly SpeedSample[]> {
  const samples: SpeedSample[] = [];
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    // Most of the log is outside a short window; skip it without parsing.
    const timestamp = Number(TIMESTAMP_PATTERN.exec(line)?.[1]);
    if (!Number.isFinite(timestamp) || timestamp < sinceMs || timestamp >= untilMs) continue;
    try {
      const sample = speedSampleFromOpenCodex(JSON.parse(line));
      if (sample !== null) samples.push(sample);
    } catch {
      // A partially written final line is picked up on the next read.
    }
  }
  return samples;
}

export async function readOpenCodexSpeed(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly sinceMs: number;
  readonly untilMs: number;
}): Promise<SourceResult> {
  const home = await resolveOpenCodexHome(input.environment);
  if (home === null) return unavailable("opencodex", "OpenCodex is not set up on this machine.");
  const logPath = NodePath.join(home, "usage.jsonl");
  try {
    await NodeFSP.access(logPath, NodeFS.constants.R_OK);
    const samples = await readOpenCodexLog(logPath, input.sinceMs, input.untilMs);
    return {
      samples,
      status: { source: "opencodex", status: "ok", detail: null, requests: samples.length },
    };
  } catch {
    // Fall back to the management API below.
  }
  const token = (await NodeFSP.readFile(NodePath.join(home, "admin-api-token"), "utf8")).trim();
  const port = await readOpenCodexPort(home);
  const samples: SpeedSample[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_OPENCODEX_PAGES; page++) {
      const query = new URLSearchParams({
        limit: "100",
        from: String(input.sinceMs),
        to: String(input.untilMs),
      });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await fetch(`http://127.0.0.1:${port}/api/request-history?${query}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(OPENCODEX_TIMEOUT_MS),
      });
      if (!response.ok) {
        return unavailable("opencodex", `OpenCodex request history returned ${response.status}.`);
      }
      const body = (await response.json()) as {
        entries?: unknown;
        hasMore?: unknown;
        nextCursor?: unknown;
      };
      if (!Array.isArray(body.entries)) {
        return unavailable("opencodex", "OpenCodex returned an unexpected history format.");
      }
      for (const entry of body.entries) {
        const sample = speedSampleFromOpenCodex(entry);
        if (sample !== null) samples.push(sample);
      }
      const next = typeof body.nextCursor === "string" ? body.nextCursor : null;
      if (body.hasMore !== true || next === null || next === cursor) {
        return {
          samples,
          status: { source: "opencodex", status: "ok", detail: null, requests: samples.length },
        };
      }
      cursor = next;
    }
  } catch {
    return unavailable("opencodex", `OpenCodex is not reachable on port ${port}.`);
  }
  return {
    samples,
    status: {
      source: "opencodex",
      status: "ok",
      detail: `Only the latest ${samples.length} requests were read.`,
      requests: samples.length,
    },
  };
}

async function readClaudeFile(path: string): Promise<readonly SpeedSample[]> {
  const reader = new ClaudeSpeedReader();
  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) reader.push(line);
  return reader.samples();
}

export async function readClaudeSpeed(input: {
  readonly directories: readonly string[];
  readonly sinceMs: number;
  readonly untilMs: number;
}): Promise<SourceResult> {
  if (input.directories.length === 0) {
    return unavailable("claude-transcripts", "No Claude Code transcripts are configured.");
  }
  const samples: SpeedSample[] = [];
  for (const directory of input.directories) {
    for (const file of await listTranscriptFiles(directory, input.sinceMs)) {
      try {
        for (const sample of await readClaudeFile(file.path)) {
          if (sample.timestampMs >= input.sinceMs && sample.timestampMs < input.untilMs) {
            samples.push(sample);
          }
        }
      } catch {
        // A transcript removed mid-scan contributes nothing.
      }
    }
  }
  return {
    samples,
    status: {
      source: "claude-transcripts",
      status: "ok",
      detail: "Estimated from transcript timestamps; time to first token is not recorded.",
      requests: samples.length,
    },
  };
}
