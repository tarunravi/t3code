// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, assert, describe, it } from "vite-plus/test";

import {
  BACKGROUND_TASK_OUTPUT_MAX_BYTES,
  BACKGROUND_TASK_OUTPUT_MAX_LINES,
  findBackgroundTaskOutputFile,
  readBackgroundTaskOutput,
} from "./backgroundTaskOutputQuery.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bg-task-output-"));
const write = (name: string, contents: string) => {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, contents);
  return path;
};

afterAll(() => {
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

const failureReason = (exit: Exit.Exit<unknown, { readonly reason: string }>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.reason
    : null;

describe("readBackgroundTaskOutput", () => {
  effectIt.effect("returns the whole file when it fits, without ANSI styling", () =>
    Effect.gen(function* () {
      const outputFile = write("b1.output", "\u001b[32mready\u001b[0m on :8765\nGET / 200\n");
      const result = yield* readBackgroundTaskOutput({ taskId: "b1", outputFile });
      assert.deepEqual(result, {
        taskId: "b1",
        text: "ready on :8765\nGET / 200",
        truncated: false,
      });
    }),
  );

  effectIt.effect("keeps only the last lines", () =>
    Effect.gen(function* () {
      const lines = Array.from(
        { length: BACKGROUND_TASK_OUTPUT_MAX_LINES + 50 },
        (_, i) => `l${i}`,
      );
      const outputFile = write("b2.output", `${lines.join("\n")}\n`);
      const result = yield* readBackgroundTaskOutput({ taskId: "b2", outputFile });
      const tail = result.text.split("\n");
      assert.lengthOf(tail, BACKGROUND_TASK_OUTPUT_MAX_LINES);
      assert.equal(tail.at(-1), lines.at(-1));
      assert.isTrue(result.truncated);
    }),
  );

  effectIt.effect("reads at most the byte cap and drops the partial first line", () =>
    Effect.gen(function* () {
      const line = `${"x".repeat(1023)}\n`;
      const outputFile = write("b3.output", `START\n${line.repeat(100)}`);
      const result = yield* readBackgroundTaskOutput({ taskId: "b3", outputFile });
      assert.isAtMost(result.text.length, BACKGROUND_TASK_OUTPUT_MAX_BYTES);
      assert.notInclude(result.text, "START");
      assert.isTrue(result.text.split("\n").every((entry) => entry.length === 1023));
      assert.isTrue(result.truncated);
    }),
  );

  effectIt.effect("treats a not-yet-created file as empty output", () =>
    Effect.gen(function* () {
      const outputFile = NodePath.join(dir, "b4.output");
      const result = yield* readBackgroundTaskOutput({ taskId: "b4", outputFile });
      assert.deepEqual(result, { taskId: "b4", text: "", truncated: false });
    }),
  );

  effectIt.effect("only reads the task's own absolute .output file", () =>
    Effect.gen(function* () {
      const other = write("secret.txt", "do not serve\n");
      for (const outputFile of [undefined, "b5.output", other, write("b6.output", "x\n")]) {
        const exit = yield* Effect.exit(readBackgroundTaskOutput({ taskId: "b5", outputFile }));
        assert.equal(failureReason(exit), "output-unavailable", String(outputFile));
      }
    }),
  );
});

describe("findBackgroundTaskOutputFile", () => {
  it("resolves a path only for a task on the thread's roster", () => {
    const providerThreads = [
      { pendingBackgroundTasks: [{ taskId: "b1" }] },
      { pendingBackgroundTasks: [{ taskId: "b2", outputFile: "/tmp/tasks/b2.output" }] },
    ];
    assert.equal(findBackgroundTaskOutputFile(providerThreads, "b2"), "/tmp/tasks/b2.output");
    assert.isUndefined(findBackgroundTaskOutputFile(providerThreads, "b1"));
    assert.isUndefined(findBackgroundTaskOutputFile(providerThreads, "unknown"));
  });
});
