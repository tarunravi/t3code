// @vitest-environment jsdom
import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { UsagePriceTarget } from "../usage/usagePriceTargets";
import type { EnvironmentUsageStatus } from "../../state/usage";

const state = vi.hoisted(() => ({
  targets: [] as UsagePriceTarget[],
  useUsage: vi.fn(),
  write: vi.fn(async () => ({ _tag: "Success" as const })),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "config" ? null : state.targets),
}));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config" },
}));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../state/session", () => ({
  environmentSession: {},
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.write }));
vi.mock("../../state/usage", () => ({ useUsage: state.useUsage }));
vi.mock("../../hooks/useSettings", () => ({ useUpdateEnvironmentSettings: () => vi.fn() }));
vi.mock("./AddUsageLimitSourceDialog", () => ({ AddUsageLimitSourceDialog: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      {title}
      {description}
      {control}
    </div>
  ),
}));

import { UsageProviderSettings } from "./UsageProviderSettings";

const environmentId = EnvironmentId.make("zcode-device");
const otherId = EnvironmentId.make("other-device");
const model = "z-ai/glm-5";
const usage = [
  {
    environmentId,
    label: "ZCode device",
    error: null,
    isPending: false,
    canReadDiagnostics: true,
    needsCursorKeychainAccess: false,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-09-29T12:00:00.000Z",
      sinceDay: UsageDay.make("2026-09-01"),
      untilDay: UsageDay.make("2026-09-29"),
      timeZone: "UTC",
      buckets: [
        {
          day: UsageDay.make("2026-09-29"),
          provider: "codex",
          model,
          unpricedRecords: 1,
          records: 1,
          sessions: 1,
          costUsd: 0,
          cacheSavingsUsd: 0,
          costSource: "unpriced",
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 20,
            cacheCreationTokens: 0,
            outputTokens: 50,
            reasoningTokens: 0,
          },
        },
      ],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 0 },
      scanDurationMs: 1,
    },
  },
] satisfies EnvironmentUsageStatus[];
let renderer: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.write.mockClear();
  state.useUsage.mockReset();
  state.useUsage.mockReturnValue({ environments: usage });
  state.targets = [environmentId, otherId].map((id) => ({
    environmentId: id,
    label: id === environmentId ? "ZCode device" : "Other device",
    prices: {},
    aliases: null,
    unavailable: null,
  }));
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
});
afterEach(async () => {
  await act(() => renderer.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(readOnly = false) {
  await act(() =>
    renderer.render(
      <UsageProviderSettings
        environmentId={environmentId}
        environmentLabel="ZCode device"
        sources={{}}
        cursorKeychainUsageEnabled={false}
        readOnly={readOnly}
      />,
    ),
  );
}

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function priceInput(field: string) {
  return document.querySelector<HTMLInputElement>(
    `input[aria-label="${field} price for ${model}"]`,
  )!;
}

async function enterPrice(field: string, value: string) {
  const input = priceInput(field);
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("opens the shared editor on the selected device and saves observed model rates", async () => {
  await render();
  expect(state.useUsage).not.toHaveBeenCalled();
  await act(() => button("Edit model prices").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Custom model prices");
  expect(document.body.textContent).toContain("USD / million tokens");
  expect(document.body.textContent).toContain(model);
  const input = document.querySelector<HTMLInputElement>(
    `input[aria-label="Input price for ${model}"]`,
  )!;
  expect(input.value).toBe("");
  expect(input.placeholder).toBe("Unpriced");
  await enterPrice("Input", "1.5");
  expect(button("Save changes").disabled).toBe(true);
  expect(state.write).not.toHaveBeenCalled();
  await enterPrice("Output", "3");
  await enterPrice("Cache read", "0");
  await enterPrice("Cache write", "2");
  await act(() => button("Save changes").click());
  expect(state.write).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      patch: {
        usagePriceOverrides: {
          [model]: {
            inputCostPerMillionTokens: 1.5,
            outputCostPerMillionTokens: 3,
            cacheReadCostPerMillionTokens: 0,
            cacheWriteCostPerMillionTokens: 2,
          },
        },
      },
    },
  });
});

it("allows opening before usage arrives and lists real models when it arrives", async () => {
  state.useUsage.mockReturnValue({ environments: [{ ...usage[0], summary: null }] });
  await render();
  await act(() => button("Edit model prices").click());
  expect(document.body.textContent).toContain("No custom prices");
  state.useUsage.mockReturnValue({ environments: usage });
  await render();
  expect(document.body.textContent).toContain(model);
  expect(state.write).not.toHaveBeenCalled();
});

it.each(["Input", "Output"])("requires %s before saving an unpriced model", async (missing) => {
  await render();
  await act(() => button("Edit model prices").click());
  await enterPrice(missing === "Input" ? "Output" : "Input", "2");
  await enterPrice("Cache read", "0.5");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(`${missing} is required`);
  expect(button("Save changes").disabled).toBe(true);
  await act(() => button("Save changes").click());
  expect(state.write).not.toHaveBeenCalled();
  expect(priceInput(missing).value).toBe("");
});

it("leaves blank cache rates unset so they fall back to the input rate", async () => {
  await render();
  await act(() => button("Edit model prices").click());
  await enterPrice("Input", "1.5");
  await enterPrice("Output", "3");
  for (const field of ["Cache read", "Cache write"]) {
    expect(priceInput(field).value).toBe("");
    expect(priceInput(field).placeholder).toBe("Input rate");
  }
  await act(() => button("Save changes").click());
  expect(state.write).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: {
      patch: {
        usagePriceOverrides: {
          [model]: {
            inputCostPerMillionTokens: 1.5,
            outputCostPerMillionTokens: 3,
          },
        },
      },
    },
  });
});

it("can undo or save a reset, leaving the observed model unpriced with no override", async () => {
  state.targets[0] = {
    ...state.targets[0]!,
    prices: {
      [model]: {
        inputCostPerMillionTokens: 1.5,
        outputCostPerMillionTokens: 3,
      },
    },
  };
  await render();
  await act(() => button("Edit model prices").click());
  const resetLabel = `Reset price for ${model} to automatic`;
  await act(() => button(resetLabel).click());
  expect(document.body.textContent).toContain("Automatic pricing after saving");
  await act(() => button(`Undo reset for ${model}`).click());
  expect(priceInput("Input").value).toBe("1.5");
  expect(button("Save changes").disabled).toBe(true);
  await act(() => button(resetLabel).click());
  await act(() => button("Save changes").click());
  expect(state.write).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { patch: { usagePriceOverrides: { [model]: null } } },
  });
  state.targets = state.targets.map((target) => ({ ...target, prices: {} }));
  state.useUsage.mockReturnValue({ environments: [...usage] });
  await render();
  for (const field of ["Input", "Output", "Cache read", "Cache write"])
    expect(priceInput(field).value).toBe("");
  expect(priceInput("Input").placeholder).toBe("Unpriced");
  expect(button(resetLabel).disabled).toBe(true);
  expect(button("Save changes").disabled).toBe(true);
  expect(state.write).toHaveBeenCalledOnce();
});

it("keeps pricing unavailable to read-only settings sessions", async () => {
  await render(true);
  expect(button("Edit model prices").disabled).toBe(true);
  await act(() => button("Edit model prices").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(state.useUsage).not.toHaveBeenCalled();
  expect(state.write).not.toHaveBeenCalled();
});
