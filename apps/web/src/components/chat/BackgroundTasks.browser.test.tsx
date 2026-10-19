import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("BackgroundTaskList", () => {
  it("selects an inspectable row and gives only those rows actions", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onSelect = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(
        <BackgroundTaskList
          entries={entries}
          selectedTaskId="b1"
          onSelect={onSelect}
          renderActions={(entry) =>
            entry.inspectable ? <span data-action>stop {entry.task.taskId}</span> : null
          }
        />,
      ),
    );
    const rows = [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
    expect(rows.map((row) => row.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(rows[2]!.disabled).toBe(true);

    await act(async () => rows[1]!.click());
    expect(onSelect).toHaveBeenCalledWith("b2");

    const actions = [...container.querySelectorAll("[data-action]")];
    expect(actions.map((action) => action.textContent)).toEqual(["stop b1", "stop b2"]);
  });
});
