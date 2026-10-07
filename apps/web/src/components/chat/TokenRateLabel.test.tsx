// @vitest-environment jsdom
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
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
type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "attempts" | "providerTurns" | "turnItems"
>;
const completedRun = {
  id: "run:one",
  ordinal: 1,
  status: "completed",
  rootNodeId: "root:one",
  providerThreadId: "provider-thread:one",
  activeAttemptId: null,
} as unknown as OrchestrationV2Run;
function projectionFor(providerTurn: OrchestrationV2ProviderTurn | null): Projection | null {
  if (providerTurn === null) return null;
  return {
    runs: [completedRun],
    attempts: [],
    providerTurns: [
      {
        ...providerTurn,
        nodeId: completedRun.rootNodeId!,
        providerThreadId: completedRun.providerThreadId!,
        runAttemptId: null,
        ordinal: 1,
      },
    ],
    turnItems: [],
  };
}
function streaming(text: string): Projection {
  return {
    runs: [{ ...completedRun, status: "running" }],
    attempts: [],
    providerTurns: [],
    turnItems: [
      {
        type: "assistant_message",
        runId: completedRun.id,
        nodeId: completedRun.rootNodeId,
        text,
      } as unknown as OrchestrationV2TurnItem,
    ],
  };
}
async function renderProjection(projection: Projection | null) {
  await act(async () => root.render(<TokenRateLabel projection={projection} />));
}
async function render(providerTurn: OrchestrationV2ProviderTurn | null) {
  await renderProjection(projectionFor(providerTurn));
}
describe("TokenRateLabel", () => {
  it("updates a live estimate every second while text streams, then shows the turn average", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await renderProjection(streaming(""));
      expect(container.textContent).toBe("tok/s —");
      expect(container.querySelector("span")?.getAttribute("aria-label")).toBe(
        "Output token rate unavailable",
      );
      vi.setSystemTime(2000);
      await renderProjection(streaming("x".repeat(400)));
      expect(container.textContent).toBe("~50 tok/s");
      expect(container.querySelector("span")?.getAttribute("aria-description")).toContain(
        "estimated from streamed text",
      );
      await act(async () => vi.advanceTimersByTime(2000));
      expect(container.textContent).toBe("~25 tok/s");
      await render(completed);
      expect(container.textContent).toBe("100 tok/s (turn avg)");
    } finally {
      vi.useRealTimers();
    }
  });
  it("aggregates unique live descendant rates while the parent waits or has completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const parent = streaming("");
      const child = streaming("");
      const sources = (
        childText: string,
        parentText = "",
        parentStatus: "running" | "completed" = "running",
      ) => [
        {
          key: "thread:parent",
          projection: {
            ...parent,
            runs: [{ ...parent.runs[0]!, status: parentStatus }],
            turnItems: [
              {
                ...parent.turnItems[0]!,
                text: parentText,
              },
            ],
          },
        },
        {
          key: "thread:child",
          projection: {
            ...child,
            turnItems: [
              {
                ...child.turnItems[0]!,
                text: childText,
              },
            ],
          },
        },
      ];

      await act(async () => root.render(<TokenRateLabel sources={sources("")} />));
      vi.setSystemTime(2000);
      await act(async () =>
        root.render(<TokenRateLabel sources={sources("x".repeat(400), "x".repeat(200))} />),
      );
      expect(container.textContent).toBe("~75 tok/s");

      const completedParent = projectionFor(completed)!;
      await act(async () =>
        root.render(
          <TokenRateLabel
            sources={[
              { key: "thread:parent", projection: completedParent },
              ...sources("x".repeat(400)).slice(1),
              ...sources("x".repeat(400)).slice(1),
            ]}
          />,
        ),
      );
      expect(container.textContent).toBe("~50 tok/s");
    } finally {
      vi.useRealTimers();
    }
  });
  it("hides unsupported telemetry without claiming context growth as speed", async () => {
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
