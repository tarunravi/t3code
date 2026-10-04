// @vitest-environment jsdom
import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TokenRateLabel } from "./TokenRateLabel";
let root: Root;
let container: HTMLDivElement;
const completed = {
  id: "turn:one",
  status: "completed",
  startedAt: DateTime.makeUnsafe(0),
  completedAt: DateTime.makeUnsafe(4000),
  turnTokenUsage: {
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: 10000,
    outputTokens: 400,
    hasSubagents: false,
  },
} as OrchestrationV2ProviderTurn;
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
async function render(providerTurn: OrchestrationV2ProviderTurn | null) {
  await act(async () => root.render(<TokenRateLabel providerTurn={providerTurn} />));
}
describe("TokenRateLabel", () => {
  it("explains pending and unsupported telemetry without claiming live context speed", async () => {
    await render({ ...completed, status: "running", completedAt: null });
    expect(container.textContent).toBe("tok/s —");
    expect(container.querySelector("span")?.getAttribute("aria-description")).toContain(
      "Awaiting turn completion",
    );
    await render({
      ...completed,
      turnTokenUsage: undefined,
      tokenUsage: { usedTokens: 10100, outputTokens: 100, updatedAt: "2026-10-03T10:00:00Z" },
    });
    expect(container.textContent).toBe("tok/s —");
  });
  it("makes unavailable explanations keyboard-accessible", async () => {
    await render(null);
    const label = container.querySelector("span");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      label?.focus();
    });
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
      "supported output-token totals and timing",
    );
    expect(document.activeElement).toBe(label);
    expect(label?.getAttribute("aria-description")).toContain(
      "supported output-token totals and timing",
    );
    expect(label?.getAttribute("aria-description")).toContain(
      "Input/context usage is not generation speed",
    );
  });
  it("labels a completed-turn average and explains its denominator", async () => {
    await render(completed);
    expect(container.textContent).toBe("100 tok/s (turn avg)");
    expect(container.querySelector("span")?.getAttribute("aria-label")).toContain("completed turn");
    expect(container.querySelector("span")?.getAttribute("aria-description")).toContain(
      "not live generation speed",
    );
  });
  it("resets immediately for a new turn, missing data, or thread switch", async () => {
    await render(completed);
    await render({
      ...completed,
      id: "turn:two" as never,
      status: "pending",
      turnTokenUsage: undefined,
    });
    expect(container.textContent).toBe("tok/s —");
    await render(completed);
    await render(null);
    expect(container.textContent).toBe("tok/s —");
    await render({
      ...completed,
      id: "turn:three" as never,
      completedAt: DateTime.makeUnsafe(2000),
    });
    expect(container.textContent).toBe("200 tok/s (turn avg)");
  });
});
