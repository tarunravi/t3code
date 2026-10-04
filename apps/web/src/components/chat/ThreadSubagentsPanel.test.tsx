import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updateSettings: vi.fn(),
  navigate: vi.fn(),
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
  TooltipPopup: () => null,
}));
// Radio items route clicks through the group's onValueChange, like Base UI does.
vi.mock("../ui/menu", async () => {
  const { createContext, useContext } = await import("react");
  const RadioGroupContext = createContext<{
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
      onValueChange,
      children,
    }: {
      onValueChange: (value: string) => void;
      children?: ReactNode;
    }) => (
      <RadioGroupContext.Provider value={{ onValueChange }}>{children}</RadioGroupContext.Provider>
    ),
    MenuRadioItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const group = useContext(RadioGroupContext);
      return <button value={value} onClick={() => group?.onValueChange?.(value)} />;
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
    { selection: OPUS_SELECTION, role: "hard" as const },
    { selection: GLM_SELECTION },
  ],
};
const PANEL = () => <ThreadSubagentsPanel environmentId={ENVIRONMENT} threadId={THREAD} />;
// react-test-renderer's act requires this to update state outside React events.
declare global {
  // eslint-disable-next-line no-var
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
  });

  function renderPanel() {
    act(() => {
      renderer = create(PANEL());
    });
    return renderer!;
  }

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
            { selection: OPUS_SELECTION, role: "hard" },
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
    applyPreset(root, "manual");

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
