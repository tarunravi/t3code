// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only tail of a background task's output for the thread's Background
 * panel.
 *
 * The client names a task, never a path: the file comes from the provider
 * thread roster the adapter recorded, and must be that task's own
 * `<taskId>.output` file. Reads are bounded to the last lines and bytes so a
 * chatty dev server cannot flood the websocket.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  OrchestrationBackgroundTaskError,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const BACKGROUND_TASK_OUTPUT_MAX_LINES = 200;
export const BACKGROUND_TASK_OUTPUT_MAX_BYTES = 64 * 1024;

export function findBackgroundTaskOutputFile(
  providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "pendingBackgroundTasks">>,
  taskId: string,
): string | undefined {
  for (const providerThread of providerThreads) {
    const task = providerThread.pendingBackgroundTasks?.find(
      (candidate) => candidate.taskId === taskId,
    );
    if (task !== undefined) return task.outputFile;
  }
  return undefined;
}

export function tailBackgroundTaskOutput(
  text: string,
  startedMidFile: boolean,
): { readonly text: string; readonly truncated: boolean } {
  // A read that starts mid-file begins with a partial line; drop it.
  const whole = startedMidFile ? text.slice(text.indexOf("\n") + 1) : text;
  const lines = NodeUtil.stripVTControlCharacters(whole).split("\n");
  if (lines.at(-1) === "") lines.pop();
  const kept = lines.slice(-BACKGROUND_TASK_OUTPUT_MAX_LINES);
  return {
    text: kept.join("\n"),
    truncated: startedMidFile || kept.length < lines.length,
  };
}

export const readBackgroundTaskOutput = Effect.fn("orchestration.readBackgroundTaskOutput")(
  function* (input: { readonly taskId: string; readonly outputFile: string | undefined }) {
    const { taskId, outputFile } = input;
    if (
      outputFile === undefined ||
      !NodePath.isAbsolute(outputFile) ||
      NodePath.basename(outputFile) !== `${taskId}.output`
    ) {
      return yield* new OrchestrationBackgroundTaskError({ reason: "output-unavailable", taskId });
    }

    const read = yield* Effect.tryPromise({
      try: async () => {
        let handle: NodeFSP.FileHandle;
        try {
          handle = await NodeFSP.open(outputFile, "r");
        } catch (cause) {
          // The CLI creates the file lazily; no file yet just means no output yet.
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw cause;
        }
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) return "not-a-file" as const;
          const start = Math.max(0, stat.size - BACKGROUND_TASK_OUTPUT_MAX_BYTES);
          const buffer = Buffer.alloc(stat.size - start);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
          return {
            text: buffer.subarray(0, bytesRead).toString("utf8"),
            startedMidFile: start > 0,
          };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new OrchestrationBackgroundTaskError({ reason: "read-failed", taskId, cause }),
    });
    if (read === "not-a-file") {
      return yield* new OrchestrationBackgroundTaskError({ reason: "output-unavailable", taskId });
    }
    if (read === null) {
      return { taskId, text: "", truncated: false };
    }
    return { taskId, ...tailBackgroundTaskOutput(read.text, read.startedMidFile) };
  },
);
