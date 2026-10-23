import { act, fakeTimers, render as mount, type Screen } from "../../../test/render";
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
import { describe, expect, it, vi } from "vite-plus/test";
import { TokenRateLabel } from "./TokenRateLabel";
let root: Screen;
let container: HTMLElement;
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
async function setup() {
  await using stack = new AsyncDisposableStack();
  stack.defer(() => {
    vi.unstubAllGlobals();
  });
  root = stack.use(await mount(null, { router: false }));
  container = root.container;
  return stack.move();
}

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
  await root.rerender(<TokenRateLabel projection={projection} />);
}
async function render(providerTurn: OrchestrationV2ProviderTurn | null) {
  await renderProjection(projectionFor(providerTurn));
}
describe("TokenRateLabel", () => {
  it.each(["pre-token", "tool-only", "unexposed reasoning", "reconnect"])(
    "does not claim zero or idle for %s without observed text growth",
    async (scenario) => {
      await using _fixture = await setup();
      using _timers = fakeTimers();
      vi.setSystemTime(0);
      const baseline = streaming(scenario === "reconnect" ? "x".repeat(226) : "");
      const projection: Projection = {
        ...baseline,
        turnItems:
          scenario === "tool-only"
            ? [
                {
                  ...baseline.turnItems[0]!,
                  type: "command_execution",
                  text: "tool",
                } as unknown as OrchestrationV2TurnItem,
              ]
            : baseline.turnItems,
        providerTurns:
          scenario === "unexposed reasoning"
            ? [
                {
                  ...completed,
                  status: "running",
                  completedAt: null,
                  tokenUsage: {
                    usedTokens: 10000,
                    outputTokens: 670,
                    reasoningOutputTokens: 133,
                    updatedAt: "2026-10-23T00:00:00Z",
                  },
                },
              ]
            : baseline.providerTurns,
      };
      await renderProjection(projection);
      expect(container.textContent).toBe("Measuring…");
      await act(() => vi.advanceTimersByTime(5000));
      expect(container.textContent).toBe("No recent visible output");
      expect(container.querySelector("span")?.getAttribute("aria-label")).toBe(
        "No recent visible output",
      );
      expect(container.querySelector("span")?.getAttribute("aria-description")).toContain(
        "does not mean the provider is idle",
      );
    },
  );
  it("suppresses a sparse burst, measures subsequent growth, then uses actual completed totals", async () => {
    await using _fixture = await setup();
    using _timers = fakeTimers();
    vi.setSystemTime(0);
    await renderProjection(streaming("x".repeat(226)));
    await act(() => vi.advanceTimersByTime(276617));
    await renderProjection(streaming("x".repeat(548)));
    expect(container.textContent).toBe("Measuring…");
    vi.setSystemTime(278617);
    await renderProjection(streaming("x".repeat(552)));
    expect(container.textContent).toBe("~<1 tok/s");
    await render({
      ...completed,
      completedAt: DateTime.makeUnsafe(463407),
      turnTokenUsage: { ...completed.turnTokenUsage!, outputTokens: 19210, reasoningTokens: 9370 },
    });
    expect(container.textContent).toBe("41 tok/s (turn avg)");
  });
  it.each([0, 0.49])("preserves completed measured rate %s", async (rate) => {
    await using _fixture = await setup();
    await render({
      ...completed,
      completedAt: DateTime.makeUnsafe(100000),
      turnTokenUsage: { ...completed.turnTokenUsage!, outputTokens: rate * 100 },
    });
    expect(container.textContent).toBe(`${rate === 0 ? "0" : "<1"} tok/s (turn avg)`);
  });
  it("marks missing completed timing unavailable", async () => {
    await using _fixture = await setup();
    await render({ ...completed, startedAt: null });
    expect(container.textContent).toBe("tok/s N/A");
  });
  it("settles a live projection with real timers across parent rerenders", async () => {
    await using _fixture = await setup();
    const projection = streaming("live output");
    await root.rerender(<TokenRateLabel projection={projection} />);
    expect(container.textContent).toBe("Measuring…");
    await root.rerender(<TokenRateLabel projection={projection} className="ml-1" />);
    expect(container.querySelector("span")?.classList.contains("ml-1")).toBe(true);
    await render(completed);
    expect(container.textContent).toBe("100 tok/s (turn avg)");
  });
  it("measures live assistant and reasoning item nodes beneath the root, then shows the turn average", async () => {
    await using _fixture = await setup();
    {
      using _timers = fakeTimers();
      vi.setSystemTime(0);
      await renderProjection(streaming(""));
      expect(container.textContent).toBe("Measuring…");
      expect(container.querySelector("span")?.getAttribute("aria-label")).toBe("Measuring…");
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
    }
  });
  it("keeps one refresh timer across samples and releases it when streaming stops", async () => {
    await using _fixture = await setup();
    using _timers = fakeTimers();
    using interval = vi.spyOn(globalThis, "setInterval");
    using clear = vi.spyOn(globalThis, "clearInterval");
    vi.setSystemTime(0);
    await renderProjection(streaming(""));
    expect(interval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1000);
    vi.setSystemTime(2000);
    await renderProjection(streaming("x".repeat(400)));
    expect(container.textContent).toBe("~50 tok/s");
    for (let index = 0; index < 10; index += 1) await renderProjection(streaming("x".repeat(400)));
    expect(interval).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTime(2000));
    expect(container.textContent).toBe("~25 tok/s");
    await render(completed);
    expect(clear).toHaveBeenCalledExactlyOnceWith(interval.mock.results[0]!.value);
    await root.unmount();
    expect(clear).toHaveBeenCalledOnce();
  });
  it("aggregates unique live descendant rates while the parent waits or has completed", async () => {
    await using _fixture = await setup();
    {
      using _timers = fakeTimers();
      vi.setSystemTime(0);
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

      await root.rerender(<TokenRateLabel sources={sources("")} />);
      vi.setSystemTime(2000);
      await root.rerender(<TokenRateLabel sources={sources("x".repeat(400), "x".repeat(200))} />);
      expect(container.textContent).toBe("~75 tok/s");

      const completedParent = projectionFor(completed)!;
      await root.rerender(
        <TokenRateLabel
          sources={[
            { key: "thread:parent", projection: completedParent },
            ...sources("x".repeat(400)).slice(1),
            ...sources("x".repeat(400)).slice(1),
          ]}
        />,
      );
      expect(container.textContent).toBe("~50 tok/s");
    }
  });
  it("hides unsupported telemetry without claiming context growth as speed", async () => {
    await using _fixture = await setup();
    await render({
      ...completed,
      turnTokenUsage: undefined,
      tokenUsage: { usedTokens: 10100, outputTokens: 100, updatedAt: "2026-10-03T10:00:00Z" },
    });
    expect(container.textContent).toBe("tok/s N/A");
  });
  it("makes unavailable explanations keyboard-accessible", async () => {
    await using _fixture = await setup();
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
    await using _fixture = await setup();
    await render(completed);
    expect(container.textContent).toBe("100 tok/s (turn avg)");
    expect(container.querySelector("span")?.getAttribute("aria-label")).toContain("completed turn");
    expect(container.querySelector("span")?.getAttribute("aria-description")).toContain(
      "not live generation speed",
    );
  });
  it("resets immediately for a new turn, missing data, or thread switch", async () => {
    await using _fixture = await setup();
    await render(completed);
    await render({
      ...completed,
      id: "turn:two" as never,
      status: "pending",
      turnTokenUsage: undefined,
    });
    expect(container.textContent).toBe("tok/s N/A");
    await render(completed);
    await render(null);
    expect(container.textContent).toBe("tok/s N/A");
    await render({
      ...completed,
      id: "turn:three" as never,
      completedAt: DateTime.makeUnsafe(2000),
    });
    expect(container.textContent).toBe("200 tok/s (turn avg)");
  });
});
