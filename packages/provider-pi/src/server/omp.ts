/**
 * oh-my-pi (`omp`) is a Pi fork whose RPC mode (`omp --mode rpc`) keeps Pi's
 * commands and session events but differs in a few records. This flavor maps
 * those records onto the Pi protocol PiAdapterV2 speaks, and enables omp's
 * native `/goal` loop where the running omp supports it.
 *
 * @module provider-pi/server/omp
 */
import {
  ProviderDriverKind,
  type OrchestrationV2ProviderGoal,
  type OrchestrationV2ProviderGoalStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { PiProviderCapabilitiesV2, type PiRpcFlavor } from "./adapter.ts";
import {
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");

const OMP_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);

// omp's goal loop continues on its own only in modes listed here; the
// default lists just the TUI. Older omp builds ignore the setting.
const OMP_GOAL_OVERLAY_FILENAME = "t3-omp-rpc-goals.yml";
const OMP_GOAL_OVERLAY = "goal:\n  continuationModes:\n    - rpc\n";

const materializeOmpGoalOverlay = Effect.fn("materializeOmpGoalOverlay")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = `${cacheDir.replace(/\\/g, "/")}/${OMP_GOAL_OVERLAY_FILENAME}`;
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== OMP_GOAL_OVERLAY) yield* fs.writeFileString(dest, OMP_GOAL_OVERLAY);
  return ["--config", dest] as const;
});

const OMP_GOAL_STATUSES: Readonly<Record<string, OrchestrationV2ProviderGoalStatus>> = {
  active: "active",
  paused: "paused",
  "budget-limited": "budget_limited",
  complete: "complete",
};

function nonNegativeInt(value: unknown, key: string): number | undefined {
  const number = recordNumber(value, key);
  return number === undefined ? undefined : Math.max(0, Math.trunc(number));
}

/** omp's goal record; a dropped or missing goal is no goal. */
export function ompGoalFromNative(goal: unknown): OrchestrationV2ProviderGoal | null {
  const objective = recordString(goal, "objective")?.trim();
  const status = OMP_GOAL_STATUSES[recordString(goal, "status") ?? ""];
  if (objective === undefined || objective.length === 0 || status === undefined) return null;
  const tokensUsed = nonNegativeInt(goal, "tokensUsed");
  const tokenBudget = nonNegativeInt(goal, "tokenBudget");
  const timeUsedSeconds = nonNegativeInt(goal, "timeUsedSeconds");
  return {
    objective,
    status,
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    tokenBudget: tokenBudget ?? null,
    ...(timeUsedSeconds === undefined ? {} : { timeUsedSeconds }),
  };
}

/**
 * Translates one omp RPC connection's records into Pi's protocol:
 *
 * - `session_settled` is omp's `agent_settled`: nothing is running, queued,
 *   or left in the background to wake the session.
 * - Automatic compaction is `auto_compaction_*` rather than `compaction_*`.
 * - omp acks an id-less `prompt` before running it and reports the outcome
 *   later in `prompt_result`; Pi's single ack carries the outcome. The early
 *   ack is held back and `prompt_result` becomes the ack. A rejection arrives
 *   as an error response followed by a failed `prompt_result`, so the error
 *   response is the ack and its result is dropped.
 */
export function makeOmpRecordNormalizer(): (record: PiRpcRecord) => PiRpcRecord | undefined {
  let awaitingResults = 0;
  let rejectedResults = 0;
  return (record) => {
    switch (record["type"]) {
      case "session_settled":
        return { type: "agent_settled" };
      case "auto_compaction_start":
        return { ...record, type: "compaction_start" };
      case "auto_compaction_end":
        return { ...record, type: "compaction_end" };
      case "response": {
        if (record["command"] !== "prompt" || record["id"] !== undefined) return record;
        if (record["success"] === true) {
          // A slash command that completed locally gets no prompt_result.
          if (recordField(record["data"], "agentInvoked") === false) return record;
          awaitingResults += 1;
          return undefined;
        }
        if (awaitingResults > 0) {
          awaitingResults -= 1;
          rejectedResults += 1;
        }
        return record;
      }
      case "prompt_result": {
        if (record["status"] === "error" && rejectedResults > 0) {
          rejectedResults -= 1;
          return undefined;
        }
        if (awaitingResults === 0) return undefined;
        awaitingResults -= 1;
        return record["status"] === "error" && record["agentInvoked"] === false
          ? {
              type: "response",
              command: "prompt",
              success: false,
              error: recordString(record["error"], "message") ?? "omp rejected the prompt.",
            }
          : { type: "response", command: "prompt", success: true };
      }
      default:
        return record;
    }
  };
}

const slashed = (path: string) => path.replace(/\\/g, "/");
const dirName = (path: string) => slashed(path).replace(/\/[^/]*$/, "");
const baseName = (path: string) => slashed(path).replace(/^.*\//, "");

/**
 * omp names session files `<sessions root>/<cwd bucket>/<timestamp>_<id>.jsonl`.
 * `switch_session` opens its argument as a path, so a bare id would become a
 * new, empty session file relative to the project. Threads started on omp's
 * ACP transport stored that bare id, and a resume before this fix stored the
 * resulting `<cwd>/<id>` path. Both resolve back to the id's real file,
 * searching the current session's bucket first, then the others under the same
 * root, which follows omp's profile and session-dir settings.
 */
export const resolveOmpSessionFile = Effect.fn("resolveOmpSessionFile")(function* (
  resumeId: string,
  currentSessionFile: string | undefined,
) {
  if (resumeId.endsWith(".jsonl")) return resumeId;
  const sessionId = baseName(resumeId);
  if (sessionId.length === 0 || currentSessionFile === undefined) return null;
  const fs = yield* FileSystem.FileSystem;
  const suffix = `_${sessionId}.jsonl`;
  const findIn = (dir: string) =>
    fs.readDirectory(dir).pipe(
      Effect.map((names) => names.find((name) => name.endsWith(suffix))),
      Effect.map((name) => (name === undefined ? null : `${dir}/${name}`)),
      Effect.orElseSucceed(() => null),
    );
  const currentBucket = dirName(currentSessionFile);
  const local = yield* findIn(currentBucket);
  if (local !== null) return local;
  const root = dirName(currentBucket);
  const buckets = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
  for (const bucket of buckets) {
    const dir = `${root}/${bucket}`;
    if (dir === currentBucket) continue;
    const match = yield* findIn(dir);
    if (match !== null) return match;
  }
  return null;
});

export const OMP_RPC_FLAVOR: PiRpcFlavor = {
  driver: OMP_PROVIDER,
  defaultBinary: "omp",
  capabilities: {
    ...PiProviderCapabilitiesV2,
    // omp's RPC mode has no `fork` command or `--fork` flag; its `branch`
    // rewinds in place, which is not the session copy rollback needs.
    threads: {
      ...PiProviderCapabilitiesV2.threads,
      canRollbackThread: false,
      canForkThread: false,
      canForkFromTurn: false,
    },
    checkpointing: {
      ...PiProviderCapabilitiesV2.checkpointing,
      providerCanRollbackConversation: false,
      providerRollbackReturnsSnapshot: false,
    },
  },
  thinkingLevels: OMP_THINKING_LEVELS,
  makeRecordNormalizer: makeOmpRecordNormalizer,
  launchArgs: materializeOmpGoalOverlay,
  resolveSessionFile: resolveOmpSessionFile,
  goals: { fromNative: ompGoalFromNative },
};
