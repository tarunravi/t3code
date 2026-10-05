import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
// react-test-renderer's act requires this to update state outside React events.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function settingsWith(overrides: Record<string, unknown>) {
  return { threadSubagentRosters: {}, subagentHotlist: [], subagentPresets: [], ...overrides };
}

function button(root: ReactTestRenderer, predicate: (props: Record<string, unknown>) => boolean) {
  const found = root.root.findAll(
    (node) => node.type === "button" && predicate(node.props as Record<string, unknown>),
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

function hasText(root: ReactTestRenderer, text: string) {
  return texts(root).some((node) => node.includes(text));
}

function texts(root: ReactTestRenderer): string[] {
  const collected: string[] = [];
  root.root.findAll((node) => {
    if (typeof node.type === "string" && typeof node.children[0] === "string") {
      collected.push(node.children[0]);
    }
    return false;
  });
  return collected;
}

function applyPreset(root: ReactTestRenderer, presetId: string) {
  const item = button(root, (props) => props.value === presetId);
  act(() => item.props.onClick?.());
}

describe("ThreadSubagentsPanel compact preset mode", () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    testState.updateSettings.mockReset();
    testState.navigate.mockReset();
    testState.setDraftThreadContext.mockReset();
    testState.draftEntries = undefined;
  });

  function renderPanel() {
    act(() => {
      renderer = create(PANEL());
    });
    return renderer!;
  }

  it("lets a draft choose and disable a preset locally, before it has a server thread", () => {
    testState.settings = settingsWith({ subagentPresets: [PRESET] });
    act(() => {
      renderer = create(
        <ThreadSubagentsPanel environmentId={ENVIRONMENT} threadId={THREAD} draftId={DRAFT} />,
      );
    });
    applyPreset(renderer!, "hard");
    expect(testState.setDraftThreadContext).toHaveBeenCalledWith(DRAFT, {
      subagentRoster: PRESET.entries,
    });
    expect(testState.updateSettings).not.toHaveBeenCalled();

    testState.draftEntries = PRESET.entries;
    act(() =>
      renderer!.update(
        <ThreadSubagentsPanel environmentId={ENVIRONMENT} threadId={THREAD} draftId={DRAFT} />,
      ),
    );
    expect(hasText(renderer!, "Hard work")).toBe(true);
    expect(hasText(renderer!, "Tricky bugs.")).toBe(true);
    act(() => button(renderer!, (props) => props.role === "switch").props.onClick());
    expect(testState.setDraftThreadContext).toHaveBeenLastCalledWith(DRAFT, {
      subagentRoster: null,
    });
  });

  it("starts a new draft on the default preset, and still lets it switch or opt out", () => {
    const other = { id: "bulk", name: "Bulk work", entries: [{ selection: GLM_SELECTION }] };
    testState.settings = settingsWith({
      subagentPresets: [PRESET, other],
      defaultSubagentPresetId: "hard",
    });
    const draftPanel = () => (
      <ThreadSubagentsPanel environmentId={ENVIRONMENT} threadId={THREAD} draftId={DRAFT} />
    );
    act(() => {
      renderer = create(draftPanel());
    });
    expect(hasText(renderer!, "Hard work")).toBe(true);
    expect(button(renderer!, (props) => props.value === "hard").props["aria-checked"]).toBe(true);
    expect(button(renderer!, (props) => props.role === "switch").props["aria-checked"]).toBe(true);

    applyPreset(renderer!, "bulk");
    expect(testState.setDraftThreadContext).toHaveBeenLastCalledWith(DRAFT, {
      subagentRoster: other.entries,
    });

    // Turning the roster off is an explicit choice the default must not override.
    testState.draftEntries = null;
    act(() => renderer!.update(draftPanel()));
    expect(button(renderer!, (props) => props.role === "switch").props["aria-checked"]).toBe(false);
  });

  it("keeps an existing server thread's environment subagents despite a default preset", () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      defaultSubagentPresetId: "hard",
    });
    const root = renderPanel();
    expect(button(root, (props) => props.role === "switch").props["aria-checked"]).toBe(false);
  });

  it("previews the saved thread entries, not an edited preset or its old notes", () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: {
        [THREAD]: {
          entries: [{ selection: GLM_SELECTION, description: "Actual override notes." }],
        },
      },
    });
    const root = renderPanel();
    const preview = root.root.findByProps({ "aria-label": "Current subagent roster" });
    expect(preview.findAllByType("li")).toHaveLength(1);
    expect(hasText(root, "default")).toBe(true);
    expect(hasText(root, "zcode")).toBe(true);
    expect(hasText(root, "Actual override notes.")).toBe(true);
    expect(hasText(root, "Tricky bugs.")).toBe(false);
    expect(hasText(root, "claude-opus-5-5")).toBe(false);
  });

  it("renders today's editor when the environment has no presets", () => {
    testState.settings = settingsWith({
      threadSubagentRosters: { [THREAD]: { entries: [{ selection: OPUS_SELECTION }] } },
    });
    const root = renderPanel();
    expect(root.root.findByProps({ "data-testid": "roster-list" })).toBeDefined();
  });

  it("keeps the editor for rosters no preset matches", () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: [{ selection: GLM_SELECTION }] } },
    });
    const root = renderPanel();
    expect(root.root.findByProps({ "data-testid": "roster-list" })).toBeDefined();
  });

  it("keeps the environment row visible when the roster is off, even with presets", () => {
    testState.settings = settingsWith({ subagentPresets: [PRESET] });
    const root = renderPanel();
    // Only the environment row renders the allowed-model count.
    expect(hasText(root, "0 allowed models")).toBe(true);
    expect(root.root.findAllByProps({ "data-testid": "roster-list" })).toHaveLength(0);
  });

  it("collapses a matching roster to the preset name and entry count", () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: PRESET.entries } },
    });
    const root = renderPanel();
    expect(hasText(root, "Hard work")).toBe(true);
    expect(hasText(root, "2 entries")).toBe(true);
    expect(hasText(root, "0 allowed models")).toBe(false);
    expect(root.root.findAllByProps({ "data-testid": "roster-list" })).toHaveLength(0);
  });

  it("copies a chosen preset's entries into the thread roster", () => {
    testState.settings = settingsWith({ subagentPresets: [PRESET] });
    const root = renderPanel();
    applyPreset(root, "hard");

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
    act(() => root.update(PANEL()));
    expect(root.root.findAllByProps({ "data-testid": "roster-list" })).toHaveLength(0);
  });

  it("expands the editor again when Manual is chosen", () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: PRESET.entries } },
    });
    const root = renderPanel();
    expect(button(root, (props) => props.value === "hard").props["aria-checked"]).toBe(true);
    applyPreset(root, "manual");
    expect(button(root, (props) => props.value === "manual").props["aria-checked"]).toBe(true);
    expect(button(root, (props) => props.value === "hard").props["aria-checked"]).toBe(false);

    expect(testState.updateSettings).not.toHaveBeenCalled();
    expect(root.root.findByProps({ "data-testid": "roster-list" })).toBeDefined();
  });

  it("reveals the environment row when the switch turns a collapsed roster off", () => {
    testState.settings = settingsWith({
      subagentPresets: [PRESET],
      threadSubagentRosters: { [THREAD]: { entries: PRESET.entries } },
    });
    const root = renderPanel();
    const toggle = button(root, (props) => props.role === "switch");
    act(() => toggle.props.onClick?.());

    expect(testState.updateSettings).toHaveBeenCalledWith({
      threadSubagentRosters: { [THREAD]: null },
    });

    testState.settings = settingsWith({ subagentPresets: [PRESET] });
    act(() => root.update(PANEL()));
    expect(hasText(root, "0 allowed models")).toBe(true);
  });
});
