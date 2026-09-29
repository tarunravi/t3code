import { ProviderThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  backgroundTaskEntries,
  backgroundTaskLabel,
  backgroundTasksBannerTitle,
  resolveSelectedBackgroundTaskId,
  selectThreadBackgroundTasks,
} from "./backgroundTasks.logic";

const providerThread = (id: string, taskIds: ReadonlyArray<string>) => ({
  id: ProviderThreadId.make(id),
  pendingBackgroundTasks: taskIds.map((taskId) => ({ kind: "command" as const, taskId })),
});

describe("selectThreadBackgroundTasks", () => {
  it("lists the active provider thread's roster only", () => {
    const projection = {
      thread: { activeProviderThreadId: ProviderThreadId.make("pt-2") },
      providerThreads: [providerThread("pt-1", ["old"]), providerThread("pt-2", ["b1", "b2"])],
    };
    expect(selectThreadBackgroundTasks(projection).map((task) => task.taskId)).toEqual([
      "b1",
      "b2",
    ]);
  });

  it("falls back to every provider thread when none is active", () => {
    const projection = {
      thread: { activeProviderThreadId: null },
      providerThreads: [providerThread("pt-1", ["b1"]), providerThread("pt-2", ["b2"])],
    };
    expect(selectThreadBackgroundTasks(projection).map((task) => task.taskId)).toEqual([
      "b1",
      "b2",
    ]);
    expect(selectThreadBackgroundTasks(null)).toEqual([]);
  });
});

describe("backgroundTaskLabel", () => {
  it("prefers the command, then the description, then the id", () => {
    expect(
      backgroundTaskLabel({ taskId: "b1", command: "npm run dev", description: "Dev server" }),
    ).toBe("npm run dev");
    expect(backgroundTaskLabel({ taskId: "b1", description: "Dev server" })).toBe("Dev server");
    expect(backgroundTaskLabel({ taskId: "b1" })).toBe("b1");
  });
});

describe("backgroundTaskEntries", () => {
  it("uses the roster's command and marks only roster tasks inspectable", () => {
    const entries = backgroundTaskEntries(
      [
        { kind: "command" as const, taskId: "b1", description: "Dev server" },
        { kind: "command" as const, taskId: "item-1", description: "npm test" },
      ],
      [
        {
          kind: "command" as const,
          taskId: "b1",
          command: "npm run dev",
          outputFile: "/tmp/tasks/b1.output",
        },
      ],
    );
    expect(entries).toEqual([
      {
        task: {
          kind: "command" as const,
          taskId: "b1",
          command: "npm run dev",
          outputFile: "/tmp/tasks/b1.output",
        },
        inspectable: true,
      },
      {
        task: { kind: "command" as const, taskId: "item-1", description: "npm test" },
        inspectable: false,
      },
    ]);
  });
});

describe("resolveSelectedBackgroundTaskId", () => {
  const one = { task: { kind: "command" as const, taskId: "b1" }, inspectable: true };
  const two = { task: { kind: "command" as const, taskId: "b2" }, inspectable: true };
  const plain = { task: { kind: "command" as const, taskId: "item" }, inspectable: false };

  it("shows the only inspectable task without a choice", () => {
    expect(resolveSelectedBackgroundTaskId([one, plain], null)).toBe("b1");
  });

  it("waits for a choice when several tasks can be inspected", () => {
    expect(resolveSelectedBackgroundTaskId([one, two], null)).toBeNull();
    expect(resolveSelectedBackgroundTaskId([one, two], "b2")).toBe("b2");
  });

  it("drops a choice once that task leaves or cannot be tailed", () => {
    expect(resolveSelectedBackgroundTaskId([one, two], "gone")).toBeNull();
    expect(resolveSelectedBackgroundTaskId([two, plain], "item")).toBe("b2");
  });
});

describe("backgroundTasksBannerTitle", () => {
  it("has a compact form for narrow banners", () => {
    expect(backgroundTasksBannerTitle(1)).toEqual({
      full: "Waiting on background task",
      compact: "Background task",
    });
    expect(backgroundTasksBannerTitle(3)).toEqual({
      full: "Waiting on 3 background tasks",
      compact: "3 background tasks",
    });
  });
});
