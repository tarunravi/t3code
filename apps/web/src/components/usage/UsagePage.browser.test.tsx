import { render as mount, type Screen } from "../../../test/render";
import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentUsageStatus } from "../../state/usage";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => testState.navigate) as never,
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

describe("UsagePage", () => {
  let renderer: Screen;
  let back: ReturnType<typeof vi.spyOn>;

  async function setup() {
    await using stack = new AsyncDisposableStack();
    stack.defer(() => {
      back.mockRestore();
    });
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

    back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    testState.navigate.mockClear();
    renderer = stack.use(await mount(null, { router: false }));
    await renderer.rerender(<UsagePage />);
    return stack.move();
  }

  // Playwright cannot press a repeating or composing key, so those cases dispatch the event.
  function escape(properties: { repeat?: boolean; isComposing?: boolean } = {}) {
    return new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      ...properties,
    });
  }

  it("returns to the main app on Escape", async () => {
    await using _fixture = await setup();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(testState.navigate).toHaveBeenCalledWith({ href: "/" }));
    expect(back).not.toHaveBeenCalled();
  });

  it("closes the environment menu before Escape navigates back", async () => {
    await using _fixture = await setup();
    const trigger = document.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!;
    await userEvent.click(trigger);
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(back).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(testState.navigate).toHaveBeenCalledWith({ href: "/" }));
  });

  it.each([{ repeat: true }, { isComposing: true }])(
    "ignores Escape with %j",
    async (properties) => {
      await using _fixture = await setup();
      document.body.dispatchEvent(escape(properties));
      expect(back).not.toHaveBeenCalled();
      expect(testState.navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "Scanning…", isConnected: true, isPending: true, error: null },
    {
      label: "Unavailable",
      isConnected: false,
      isPending: false,
      error: "This environment is not connected.",
    },
  ])("shows answered environment amounts alongside $label", async (status) => {
    await using _fixture = await setup();
    const ready = {
      ...environments[0]!,
      summary: {
        ...environments[0]!.summary,
        buckets: [
          {
            day: UsageDay.make("2026-08-11"),
            provider: "codex" as const,
            model: "test-model",
            totals: {
              uncachedInputTokens: 900,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 100,
              reasoningTokens: 0,
            },
            costUsd: 12.5,
            cacheSavingsUsd: 0,
            costSource: "modelPriced" as const,
            records: 3,
            unpricedRecords: 0,
            sessions: 3,
          },
        ],
        sources: [
          {
            fingerprint: {
              hostId: "test",
              provider: "codex" as const,
              resolvedHomePath: "/test",
              volumeId: "1",
            },
            status: "ok" as const,
            scannedFiles: 3,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 3,
            message: null,
          },
        ],
      },
    };
    const next = [
      ready,
      {
        ...environments[0]!,
        environmentId: EnvironmentId.make("slow"),
        label: "Slow environment",
        summary: null,
        isConnected: status.isConnected,
        isPending: status.isPending,
        error: status.error,
      },
    ];
    testState.useUsage.mockImplementation((window) => ({
      merged: mergeUsage([ready], USAGE_CONTRACT_VERSION),
      environments: next,
      selectedEnvironments: next,
      isPending: false,
      isPartial: true,
      shown: { window, merged: mergeUsage([ready], USAGE_CONTRACT_VERSION) },
      refresh: vi.fn(),
    }));
    await renderer.rerender(<UsagePage />);
    await expect.element(page.getByText("$12.50", { exact: true }).first()).toBeVisible();
    expect(document.querySelector(".text-4xl")?.classList.contains("opacity-40")).toBe(false);
    await userEvent.click(document.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!);
    await expect
      .element(
        page.getByRole("menuitemcheckbox", {
          name: /Test environment.*\$12.50.*3 sessions.*Ready/,
        }),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByRole("menuitemcheckbox", {
          name: new RegExp(`Slow environment.*${status.label}`),
        }),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "Totals are partial. Scanning or unavailable environments do not block available numbers.",
        ),
      )
      .toBeVisible();
  });

  it("labels a settled stale source as cached instead of still scanning", async () => {
    await using _fixture = await setup();
    const cached = {
      ...environments[0]!,
      summary: {
        ...environments[0]!.summary,
        sources: [
          {
            fingerprint: {
              hostId: "cursor.com",
              provider: "cursor" as const,
              resolvedHomePath: "account",
              volumeId: "1",
            },
            status: "ok" as const,
            refreshing: true as const,
            scannedFiles: 1,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 1,
            message: null,
          },
        ],
      },
    };
    testState.useUsage.mockReturnValue({
      merged: mergeUsage([cached], USAGE_CONTRACT_VERSION),
      environments: [cached],
      selectedEnvironments: [cached],
      isPending: false,
      isPartial: true,
      shown: null,
      refresh: vi.fn(),
    });
    await renderer.rerender(<UsagePage />);
    await userEvent.click(document.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!);
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: /Test environment.*Cached/ }))
      .toBeVisible();
  });

  it("renders while summaries are missing and after a failed environment recovers", async () => {
    await using _fixture = await setup();
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
      await renderer.rerender(<UsagePage />);
      expect(document.body.textContent).toContain("All environments");
      expect(
        document.querySelector('[aria-label="Some environments could not report usage"]') !== null,
      ).toBe(status.error !== null);
    }
  });
});
