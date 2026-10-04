// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TokenRateLabel } from "./TokenRateLabel";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TokenRateLabel", () => {
  it("renders nothing until a rate has been measured", async () => {
    vi.setSystemTime(0);
    await act(async () => {
      root.render(<TokenRateLabel tokenUsage={{ usedTokens: 100 }} resetKey="t1" />);
    });
    expect(container.textContent).toBe("");
  });

  it("shows the live rate while tokens stream in", async () => {
    vi.setSystemTime(0);
    await act(async () => {
      root.render(<TokenRateLabel tokenUsage={{ usedTokens: 0 }} resetKey="t1" />);
    });
    vi.setSystemTime(4_000);
    await act(async () => {
      root.render(<TokenRateLabel tokenUsage={{ usedTokens: 400 }} resetKey="t1" />);
    });
    expect(container.textContent).toBe("100 tok/s");
  });

  it("keeps the last measured rate dimmed once the window passes", async () => {
    vi.setSystemTime(0);
    await act(async () => {
      root.render(<TokenRateLabel tokenUsage={{ usedTokens: 0 }} resetKey="t1" />);
    });
    vi.setSystemTime(4_000);
    await act(async () => {
      root.render(<TokenRateLabel tokenUsage={{ usedTokens: 400 }} resetKey="t1" />);
    });
    expect(container.textContent).toBe("100 tok/s");
    expect(container.querySelector("span")?.className).toContain("text-secondary-label");
    vi.setSystemTime(20_000);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toBe("100 tok/s");
    expect(container.querySelector("span")?.className).toContain("text-secondary-label/50");
  });

  it("resets when the thread key changes", async () => {
    vi.setSystemTime(0);
    await act(async () => {
      root.render(<TokenRateLabel tokenUsage={{ usedTokens: 0 }} resetKey="t1" />);
    });
    vi.setSystemTime(4_000);
    await act(async () => {
      root.render(<TokenRateLabel tokenUsage={{ usedTokens: 400 }} resetKey="t1" />);
    });
    await act(async () => {
      root.render(<TokenRateLabel tokenUsage={{ usedTokens: 400 }} resetKey="t2" />);
    });
    expect(container.textContent).toBe("");
  });
});
