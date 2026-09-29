import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

// Floating layers need a DOM; the list's own behavior does not.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render: React.ReactElement; children: ReactNode }) => (
    <render.type {...(render.props as object)}>{children}</render.type>
  ),
  TooltipPopup: () => null,
}));

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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  it("selects an inspectable row and gives only those rows actions", () => {
    const onSelect = vi.fn();
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <BackgroundTaskList
          entries={entries}
          selectedTaskId="b1"
          onSelect={onSelect}
          renderActions={(entry) =>
            entry.inspectable ? <span>stop {entry.task.taskId}</span> : null
          }
        />,
      );
    });
    const rows = renderer.root.findAll(
      (node) => node.type === "button" && node.props["aria-pressed"] !== undefined,
    );
    expect(rows.map((row) => row.props["aria-pressed"])).toEqual([true, false, false]);
    expect(rows[2]!.props.disabled).toBe(true);

    act(() => rows[1]!.props.onClick());
    expect(onSelect).toHaveBeenCalledWith("b2");

    const actions = renderer.root.findAll(
      (node) => node.type === "span" && String(node.children[0]).startsWith("stop"),
    );
    expect(actions.map((action) => action.children.join(""))).toEqual(["stop b1", "stop b2"]);
  });
});
