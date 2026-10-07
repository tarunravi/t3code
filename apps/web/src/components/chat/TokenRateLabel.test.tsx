// @vitest-environment jsdom
import {
  NodeId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
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
  "runs" | "attempts" | "providerTurns" | "turnItems" | "nodes"
>;
const completedRun = {
  id: "run:one",
  threadId: ThreadId.make("thread:one"),
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
    nodes: [],
  };
}
function streaming(text: string, reasoning = ""): Projection {
  const assistantNode: OrchestrationV2ExecutionNode = {
    id: NodeId.make("node:assistant"),
    threadId: completedRun.threadId,
    runId: completedRun.id,
    parentNodeId: completedRun.rootNodeId,
    rootNodeId: completedRun.rootNodeId!,
    kind: "assistant_message",
    status: "running",
    countsForRun: false,
    providerThreadId: completedRun.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: DateTime.makeUnsafe(0),
    completedAt: null,
  };
  const reasoningNode = {
    ...assistantNode,
    id: NodeId.make("node:reasoning"),
    kind: "reasoning" as const,
  };
  return {
    runs: [{ ...completedRun, status: "running" }],
    attempts: [],
    providerTurns: [],
    nodes: [
      assistantNode,
      reasoningNode,
      { ...assistantNode, id: assistantNode.rootNodeId, parentNodeId: null, kind: "root_turn" },
    ],
    turnItems: [
      {
        type: "assistant_message",
        runId: completedRun.id,
        nodeId: assistantNode.id,
        text,
      } as unknown as OrchestrationV2TurnItem,
      {
        type: "reasoning",
        runId: completedRun.id,
        nodeId: reasoningNode.id,
        text: reasoning,
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
  it("measures live assistant and reasoning item nodes beneath the root, then shows the turn average", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await renderProjection(streaming(""));
      expect(container.textContent).toBe("tok/s —");
      expect(container.querySelector("span")?.getAttribute("aria-label")).toBe(
        "Output token rate unavailable",
      );
      vi.setSystemTime(2000);
      await renderProjection(streaming("x".repeat(200), "y".repeat(200)));
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
            nodes: [
              ...parent.nodes,
              {
                ...parent.nodes[0]!,
                id: NodeId.make("node:subagent"),
                kind: "subagent" as const,
              },
              {
                ...parent.nodes[0]!,
                id: NodeId.make("node:child-output"),
                parentNodeId: NodeId.make("node:subagent"),
              },
            ],
            turnItems: [
              {
                ...parent.turnItems[0]!,
                text: parentText,
              },
              {
                ...parent.turnItems[0]!,
                nodeId: NodeId.make("node:child-output"),
                text: childText,
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
