import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  navigate: vi.fn(),
  canGoBack: true,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => testState.navigate) as never,
  useCanGoBack: () => testState.canGoBack,
}));
vi.mock(import("../../state/usage"), async (original) => ({
  ...(await original()),
  useUsage: testState.useUsage,
}));
vi.mock("./usagePagePreferences", () => ({
  readUsagePagePreferences: () => ({ metric: "cost", windowDays: 30 }),
  saveUsagePagePreferences: vi.fn(),
}));

import { UsagePage } from "./UsagePage";
const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    isConnected: true,
    canReadDiagnostics: true,
    error: null,
    needsCursorKeychainAccess: false,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
] satisfies readonly EnvironmentUsageStatus[];

beforeEach(() => {
  testState.useUsage.mockReturnValue({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments,
    selectedEnvironments: environments,
    isPending: false,
    isConnected: true,
    shown: null,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage", () => {
  let renderer: Root;
  let container: HTMLDivElement;
  let back: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    testState.navigate.mockClear();
    testState.canGoBack = true;
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    await act(() => {
      renderer.render(<UsagePage />);
    });
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    back.mockRestore();
  });

  // Playwright cannot press a repeating or composing key, so those cases dispatch the event.
  function escape(properties: { repeat?: boolean; isComposing?: boolean } = {}) {
    return new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      ...properties,
    });
  }

  it("returns to the previous page on Escape", async () => {
    await userEvent.keyboard("{Escape}");
    expect(back).toHaveBeenCalledOnce();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("returns home when there is no previous app page", async () => {
    testState.canGoBack = false;
    await act(() => renderer.render(<UsagePage />));

    await userEvent.keyboard("{Escape}");
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(back).not.toHaveBeenCalled();
  });

  it("closes the environment menu before Escape navigates back", async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!;
    await userEvent.click(trigger);
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(back).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(back).toHaveBeenCalledOnce();
  });

  it.each([{ repeat: true }, { isComposing: true }])("ignores Escape with %j", (properties) => {
    document.body.dispatchEvent(escape(properties));
    expect(back).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("renders while summaries are missing and after a failed environment recovers", async () => {
    for (const status of [
      { summary: null, error: null, isPending: true },
      { summary: null, error: "Unavailable", isPending: false },
      { summary: environments[0]!.summary, error: null, isPending: false },
    ]) {
      const next = [{ ...environments[0]!, ...status }];
      testState.useUsage.mockReturnValue({
        merged: mergeUsage(
          next.flatMap((environment) =>
            environment.summary === null ? [] : [{ ...environment, summary: environment.summary }],
          ),
          USAGE_CONTRACT_VERSION,
        ),
        environments: next,
        selectedEnvironments: next,
        isPending: status.isPending,
        isPartial: false,
        shown: null,
        refresh: vi.fn(),
      });
      await act(() => renderer.render(<UsagePage />));
      expect(container.textContent).toContain("All environments");
      expect(
        container.querySelector('[aria-label="Some environments could not report usage"]') !== null,
      ).toBe(status.error !== null);
    }
  });
});
