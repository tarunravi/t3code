import { ProviderThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { backgroundTaskLabel, selectThreadBackgroundTasks } from "./backgroundTasks.logic";

const providerThread = (id: string, taskIds: ReadonlyArray<string>) => ({
  id: ProviderThreadId.make(id),
  pendingBackgroundTasks: taskIds.map((taskId) => ({ taskId })),
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
