import { act, render as mount } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { BackgroundTaskList } from "./BackgroundTasks";

const entries = [
  { task: { kind: "command" as const, taskId: "b1", command: "npm run dev" }, inspectable: true },
  {
    task: { kind: "command" as const, taskId: "b2", command: "python3 -m http.server 8765" },
    inspectable: true,
  },
  {
    task: { kind: "command" as const, taskId: "item", description: "Watching tests" },
    inspectable: false,
  },
];

describe("BackgroundTaskList", () => {
  it("selects an inspectable row and gives only those rows actions", async () => {
    const onSelect = vi.fn();
    await using screen = await mount(
      <BackgroundTaskList
        entries={entries}
        selectedTaskId="b1"
        onSelect={onSelect}
        renderActions={(entry) =>
          entry.inspectable ? <span data-action>stop {entry.task.taskId}</span> : null
        }
      />,
      { router: false },
    );
    const { container } = screen;
    const rows = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    expect(rows.map((row) => row.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(rows[2]!.disabled).toBe(true);

    await act(async () => rows[1]!.click());
    expect(onSelect).toHaveBeenCalledWith("b2");

    const actions = [...container.querySelectorAll("[data-action]")];
    expect(actions.map((action) => action.textContent)).toEqual(["stop b1", "stop b2"]);
  });
});
