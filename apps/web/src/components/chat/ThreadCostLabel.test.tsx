// @vitest-environment jsdom

import type { ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadCostEstimate } from "../../lib/threadCost";
import { ThreadCostLabel } from "./ThreadCostLabel";

const estimate = vi.hoisted(() => ({ current: null as ThreadCostEstimate | null }));
vi.mock("../../state/threadCost", () => ({ useThreadCostEstimate: () => estimate.current }));

const THREAD_REF = { environmentId: "env", threadId: "thread" } as unknown as ScopedThreadRef;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const row = (
  threadId: string,
  depth: number,
  model: string,
  costUsd: number | null,
): ThreadCostEstimate["rows"][number] => ({
  threadId,
  title: threadId,
  depth,
  model,
  totalTokens: 1000,
  costUsd,
  incompleteUsage: false,
});

async function renderLabel(value: ThreadCostEstimate) {
  estimate.current = value;
  await act(async () => root.render(<ThreadCostLabel threadRef={THREAD_REF} />));
  const trigger = container.querySelector<HTMLElement>('[data-slot="tooltip-trigger"]');
  if (!trigger) throw new Error("cost label did not render");
  return trigger;
}

const popupText = () => document.querySelector('[data-slot="tooltip-popup"]')?.textContent ?? null;

describe("ThreadCostLabel", () => {
  it("opens on focus with the parent and subagent split", async () => {
    const trigger = await renderLabel({
      totalUsd: 3.6,
      partial: true,
      parent: { usd: 3.15, partial: false },
      subagents: { usd: 0.45, partial: true },
      rows: [
        row("This thread", 0, "parent-model", 3.15),
        row("Worker", 1, "child-model", 0.45),
        row("Nested", 2, "custom-model", null),
      ],
    });
    expect(trigger.textContent).toBe("≥ $3.60");
    expect(popupText()).toBeNull();

    await act(async () => trigger.focus());

    const text = popupText();
    expect(text).toContain("Parent agent$3.15");
    expect(text).toContain("Subagents (2)≥ $0.45");
    expect(text).toContain("Workerchild-model1K tok$0.45");
    expect(text).toContain("Nestedcustom-model1K tokunpriced");
    expect(text).not.toContain("This thread");
  });

  it("opens on hover and reports no subagents for a parent-only thread", async () => {
    vi.useFakeTimers();
    try {
      const trigger = await renderLabel({
        totalUsd: 1,
        partial: false,
        parent: { usd: 1, partial: false },
        subagents: { usd: 0, partial: false },
        rows: [row("This thread", 0, "parent-model", 1)],
      });
      expect(popupText()).toBeNull();
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(popupText()).toContain("Parent agent$1.00");
      expect(popupText()).toContain("Subagentsnone");
    } finally {
      vi.useRealTimers();
    }
  });
});
