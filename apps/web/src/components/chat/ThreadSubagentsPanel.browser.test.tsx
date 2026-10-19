import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updateSettings: vi.fn(),
  navigate: vi.fn(),
  draftEntries: undefined as unknown,
  setDraftThreadContext: vi.fn(),
}));

vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      getDraftThread: () => ({ subagentRoster: testState.draftEntries }),
      setDraftThreadContext: testState.setDraftThreadContext,
    }),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ environment: { capabilities: { threadSubagentRosters: true } } }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config" },
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => testState.settings,
  useUpdateEnvironmentSettings: () => testState.updateSettings,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));
vi.mock("./SubagentRosterList", () => ({
  SubagentRosterList: () => <div data-testid="roster-list" />,
  SubagentRosterAddControls: () => <div data-testid="roster-add" />,
  useSubagentInstances: () => ({
    instances: [],
    pickerInstances: [],
    modelOptionsByInstance: new Map(),
  }),
}));
vi.mock("../ui/switch", () => ({
  Switch: (props: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    "aria-label"?: string;
  }) => (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props["aria-label"]}
      onClick={() => props.onCheckedChange(!props.checked)}
    />
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/preview-card", () => ({
  PreviewCard: ({ children }: { children?: ReactNode }) => children,
  PreviewCardTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  PreviewCardPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
// Radio items route clicks through the group's onValueChange, like Base UI does.
vi.mock("../ui/menu", async () => {
  const { createContext, useContext } = await import("react");
  const RadioGroupContext = createContext<{
    value: string;
    onValueChange?: (value: string) => void;
  } | null>(null);
  return {
    Menu: ({ children }: { children?: ReactNode }) => children,
    MenuTrigger: ({ render, children }: { render?: ReactElement; children?: ReactNode }) => (
      <>
        {render}
        {children}
      </>
    ),
    MenuPopup: ({ children }: { children?: ReactNode }) => children,
    MenuRadioGroup: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children?: ReactNode;
    }) => (
      <RadioGroupContext.Provider value={{ value, onValueChange }}>
        {children}
      </RadioGroupContext.Provider>
    ),
    MenuRadioItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const group = useContext(RadioGroupContext);
      return (
        <button
          role="menuitemradio"
          aria-checked={group?.value === value}
          value={value}
          onClick={() => group?.onValueChange?.(value)}
        />
      );
    },
    MenuRadioItemIndicator: () => null,
    MenuSeparator: () => null,
  };
});

import { ThreadSubagentsPanel } from "./ThreadSubagentsPanel";

const ENVIRONMENT = "environment:subagents-panel" as EnvironmentId;
const THREAD = "thread:subagents-panel" as ThreadId;
const OPUS_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};
const GLM_SELECTION = { instanceId: ProviderInstanceId.make("zcode"), model: "default" };
const PRESET = {
  id: "hard",
  name: "Hard work",
  entries: [
    { selection: OPUS_SELECTION, role: "hard" as const, description: "Tricky bugs." },
    { selection: GLM_SELECTION },
  ],
};
import type { DraftId } from "../../composerDraftStore";
const DRAFT = "draft:subagents-panel" as DraftId;
const PANEL = () => <ThreadSubagentsPanel environmentId={ENVIRONMENT} threadId={THREAD} />;

interface Rendered {
  readonly container: HTMLElement;
  readonly update: (element: ReactElement) => Promise<void>;
}

function settingsWith(overrides: Record<string, unknown>) {
  return { threadSubagentRosters: {}, subagentHotlist: [], subagentPresets: [], ...overrides };
}

function button(root: Rendered, predicate: (element: HTMLButtonElement) => boolean) {
  const found = [...root.container.querySelectorAll("button")].filter(predicate);
  expect(found).toHaveLength(1);
  return found[0]!;
}

const byValue = (value: string) => (element: HTMLButtonElement) =>
  element.getAttribute("value") === value;
const isSwitch = (element: HTMLButtonElement) => element.getAttribute("role") === "switch";

function hasText(root: Rendered, text: string) {
  return (root.container.textContent ?? "").includes(text);
}

function testIds(root: Rendered, id: string) {
  return root.container.querySelectorAll(`[data-testid="${id}"]`);
}

async function applyPreset(root: Rendered, presetId: string) {
  const item = button(root, byValue(presetId));
  await act(async () => item.click());
}

const roots: Root[] = [];

async function render(element: ReactElement): Promise<Rendered> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, update: (next) => act(async () => root.render(next)) };
}

describe("ThreadSubagentsPanel compact preset mode", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    testState.updateSettings.mockReset();
    testState.navigate.mockReset();
    testState.setDraftThreadContext.mockReset();
    testState.draftEntries = undefined;
  });

  const renderPanel = () => render(PANEL());

  it("lets a draft choose and disable a preset locally, before it has a server thread", async () => {
    testState.settings = settingsWith({ subagentPresets: [PRESET] });
    const draftPanel = () => (
      <ThreadSubagentsPanel environmentId={ENVIRONMENT} threadId={THREAD} draftId={DRAFT} />
    );
    const root = await render(draftPanel());
    await applyPreset(root, "hard");
    expect(testState.setDraftThreadContext).toHaveBeenCalledWith(DRAFT, {
      subagentRoster: PRESET.entries,
    });
    expect(testState.updateSettings).not.toHaveBeenCalled();

    testState.draftEntries = PRESET.entries;
    await root.update(draftPanel());
    expect(hasText(root, "Hard work")).toBe(true);
    expect(hasText(root, "Tricky bugs.")).toBe(true);
    await act(async () => button(root, isSwitch).click());
    expect(testState.setDraftThreadContext).toHaveBeenLastCalledWith(DRAFT, {
      subagentRoster: null,
    });
  });

  it("starts a new draft on the default preset, and still lets it switch or opt out", async () => {
    const other = { id: "bulk", name: "Bulk work", entries: [{ selection: GLM_SELECTION }] };
    testState.settings = settingsWith({
      subagentPresets: [PRESET, other],
      defaultSubagentPresetId: "hard",
    });
    const draftPanel = () => (
      <ThreadSubagentsPanel environmentId={ENVIRONMENT} threadId={THREAD} draftId={DRAFT} />
    );
    const root = await render(draftPanel());
    expect(hasText(root, "Hard work")).toBe(true);
    expect(button(root, byValue("hard")).getAttribute("aria-checked")).toBe("true");
    expect(button(root, isSwitch).getAttribute("aria-checked")).toBe("true");

    await applyPreset(root, "bulk");
    expect(testState.setDraftThreadContext).toHaveBeenLastCalledWith(DRAFT, {
      subagentRoster: other.entries,
    });

    // Turning the roster off is an explicit choice the default must not override.
    testState.draftEntries = null;
    await root.update(draftPanel());
    expect(button(root, isSwitch).getAttribute("aria-checked")).toBe("false");
  });

  it("keeps an existing server thread's environment subagents despite a default preset", async () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      defaultSubagentPresetId: "hard",
    });
    const root = await renderPanel();
    expect(button(root, isSwitch).getAttribute("aria-checked")).toBe("false");
  });

  it("previews the saved thread entries, not an edited preset or its old notes", async () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: {
        [THREAD]: {
          entries: [{ selection: GLM_SELECTION, description: "Actual override notes." }],
        },
      },
    });
    const root = await renderPanel();
    const preview = root.container.querySelector('[aria-label="Current subagent roster"]');
    expect(preview?.querySelectorAll("li")).toHaveLength(1);
    expect(hasText(root, "default")).toBe(true);
    expect(hasText(root, "zcode")).toBe(true);
    expect(hasText(root, "Actual override notes.")).toBe(true);
    expect(hasText(root, "Tricky bugs.")).toBe(false);
    expect(hasText(root, "claude-opus-5-5")).toBe(false);
  });

  it("renders today's editor when the environment has no presets", async () => {
    testState.settings = settingsWith({
      threadSubagentRosters: { [THREAD]: { entries: [{ selection: OPUS_SELECTION }] } },
    });
    const root = await renderPanel();
    expect(testIds(root, "roster-list")).toHaveLength(1);
  });

  it("keeps the editor for rosters no preset matches", async () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: [{ selection: GLM_SELECTION }] } },
    });
    const root = await renderPanel();
    expect(testIds(root, "roster-list")).toHaveLength(1);
  });

  it("keeps the environment row visible when the roster is off, even with presets", async () => {
    testState.settings = settingsWith({ subagentPresets: [PRESET] });
    const root = await renderPanel();
    // Only the environment row renders the allowed-model count.
    expect(hasText(root, "0 allowed models")).toBe(true);
    expect(testIds(root, "roster-list")).toHaveLength(0);
  });

  it("collapses a matching roster to the preset name and entry count", async () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: PRESET.entries } },
    });
    const root = await renderPanel();
    expect(hasText(root, "Hard work")).toBe(true);
    expect(hasText(root, "2 entries")).toBe(true);
    expect(hasText(root, "0 allowed models")).toBe(false);
    expect(testIds(root, "roster-list")).toHaveLength(0);
  });

  it("copies a chosen preset's entries into the thread roster", async () => {
    testState.settings = settingsWith({ subagentPresets: [PRESET] });
    const root = await renderPanel();
    await applyPreset(root, "hard");

    expect(testState.updateSettings).toHaveBeenCalledWith({
      threadSubagentRosters: {
        [THREAD]: {
          entries: [
            { selection: OPUS_SELECTION, role: "hard", description: "Tricky bugs." },
            { selection: GLM_SELECTION },
          ],
        },
      },
    });

    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: PRESET.entries } },
    });
    await root.update(PANEL());
    expect(testIds(root, "roster-list")).toHaveLength(0);
  });

  it("expands the editor again when Manual is chosen", async () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: PRESET.entries } },
    });
    const root = await renderPanel();
    expect(button(root, byValue("hard")).getAttribute("aria-checked")).toBe("true");
    await applyPreset(root, "manual");
    expect(button(root, byValue("manual")).getAttribute("aria-checked")).toBe("true");
    expect(button(root, byValue("hard")).getAttribute("aria-checked")).toBe("false");

    expect(testState.updateSettings).not.toHaveBeenCalled();
    expect(testIds(root, "roster-list")).toHaveLength(1);
  });

  it("reveals the environment row when the switch turns a collapsed roster off", async () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: PRESET.entries } },
    });
    const root = await renderPanel();
    await act(async () => button(root, isSwitch).click());

    expect(testState.updateSettings).toHaveBeenCalledWith({
      threadSubagentRosters: { [THREAD]: null },
    });

    testState.settings = settingsWith({ subagentPresets: [PRESET] });
    await root.update(PANEL());
    expect(hasText(root, "0 allowed models")).toBe(true);
  });
});
