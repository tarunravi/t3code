import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SubagentRosterEntry, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GlobeIcon, Settings2Icon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { Switch } from "../ui/switch";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SubagentRosterAddControls,
  SubagentRosterList,
  useSubagentInstances,
} from "./SubagentRosterList";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { appendRosterEntries, resolvePreset, SUBAGENT_PRESETS } from "./threadSubagentRoster.logic";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";
import {
  applyPresetToRoster,
  findPresetForRoster,
} from "../settings/subagentPresets.logic";
import { cn } from "../../lib/utils";

const MANUAL_PRESET = "manual";

/**
 * Thread details section choosing which subagents this thread's agent may
 * delegate to. Off follows the environment's subagent allowlist; on, the
 * thread keeps its own ordered roster, which the server enforces. When the
 * environment defines subagent presets, a matching roster collapses to the
 * preset's name; "Manual" in the preset menu expands the editor again.
 */
export function ThreadSubagentsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(props.environmentId))?.environment.capabilities
      .threadSubagentRosters === true;
  const settings = useEnvironmentSettings(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const { instances, pickerInstances, modelOptionsByInstance } = useSubagentInstances(
    props.environmentId,
  );
  const navigate = useNavigate();
  const [manualChoice, setManualChoice] = useState<boolean | null>(null);
  if (!supported) return null;

  const roster = settings.threadSubagentRosters[props.threadId];
  const hotlist = settings.subagentHotlist;
  const presets = settings.subagentPresets;
  const saveRoster = (entries: ReadonlyArray<SubagentRosterEntry> | null) =>
    void updateSettings({
      threadSubagentRosters: {
        [props.threadId]: entries === null ? null : { entries: [...entries] },
      },
    });
  const seedEntries = () => {
    if (hotlist.length > 0) return [...hotlist];
    for (const preset of SUBAGENT_PRESETS) {
      const entries = resolvePreset(preset, instances);
      if (entries.length > 0) return entries;
    }
    return [];
  };
  const allowedModelCount = [...modelOptionsByInstance.values()].reduce(
    (total, models) => total + models.length,
    0,
  );

  const activePreset = roster === undefined ? null : findPresetForRoster(presets, roster.entries);
  // Stay expanded whenever nothing on screen is preset-backed: the editor must
  // survive the switch turning off and presets being edited out from under a
  // roster, not just the explicit "Manual" choice.
  const expanded =
    presets.length === 0 ||
    roster === undefined ||
    activePreset === null ||
    manualChoice === true;

  const applyPreset = (presetId: string) => {
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (preset === undefined) return;
    setManualChoice(false);
    saveRoster(applyPresetToRoster(preset));
  };
  const presetSummary =
    activePreset === null
      ? roster === undefined
        ? "Environment subagents"
        : "Custom roster"
      : activePreset.entries.length === 1
        ? "1 entry"
        : `${activePreset.entries.length} entries`;

  return (
    <ThreadDetailsSection
      headingId="thread-details-subagents-heading"
      title="Subagents"
      data-thread-subagents-panel
      actions={
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  part="icon"
                  aria-label="Edit subagent presets"
                  onClick={() =>
                    void navigate({
                      to: "/settings/general",
                      search: { machine: props.environmentId },
                      hash: "subagent-presets",
                    })
                  }
                >
                  <SparklesIcon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Edit presets</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  part="icon"
                  aria-label="Edit subagent hotlist"
                  onClick={() =>
                    void navigate({
                      to: "/settings/general",
                      search: { machine: props.environmentId },
                      hash: "subagent-hotlist",
                    })
                  }
                >
                  <Settings2Icon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Edit hotlist</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Switch
                  checked={roster !== undefined}
                  aria-label="Choose subagents for this thread"
                  onCheckedChange={(checked) => saveRoster(checked ? seedEntries() : null)}
                />
              }
            />
            <TooltipPopup>
              {roster === undefined
                ? "Choose subagents for this thread"
                : "Use the environment's subagents"}
            </TooltipPopup>
          </Tooltip>
        </>
      }
    >
      {presets.length > 0 ? (
        <Menu>
          <MenuTrigger
            render={
              <ThreadDetailsControl
                part="row"
                tone="muted"
                aria-label="Choose a subagent preset"
              />
            }
          >
            <SparklesIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                {activePreset?.name ?? "Subagent presets"}
              </span>
              <p className="truncate text-2xs text-muted-foreground">{presetSummary}</p>
            </span>
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuRadioGroup
              value={activePreset?.id ?? MANUAL_PRESET}
              onValueChange={(value) => {
                if (value === MANUAL_PRESET) {
                  setManualChoice(true);
                  return;
                }
                applyPreset(value);
              }}
            >
              {presets.map((preset) => (
                <MenuRadioItem key={preset.id} value={preset.id}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block">{preset.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {preset.entries.length === 1
                          ? "1 entry"
                          : `${preset.entries.length} entries`}
                      </span>
                    </span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              ))}
              <MenuSeparator />
              <MenuRadioItem value={MANUAL_PRESET}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block">Manual</span>
                    <span className="block text-xs text-muted-foreground">
                      Edit the roster by hand
                    </span>
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
      ) : null}
      {expanded ? (
        roster === undefined ? (
          <div
            className={cn(
              "flex items-center rounded-lg py-1.5",
              THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
            )}
          >
            <GlobeIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                Environment subagents
              </span>
              <p className="truncate text-2xs text-muted-foreground">
                {allowedModelCount === 1 ? "1 allowed model" : `${allowedModelCount} allowed models`}
              </p>
            </div>
          </div>
        ) : (
          <>
            {roster.entries.length === 0 ? (
              <p className="px-2.5 py-1.5 text-2xs text-warning-foreground">
                No subagents: this thread's agent cannot delegate.
              </p>
            ) : (
              <SubagentRosterList
                entries={roster.entries}
                instances={instances}
                onChange={saveRoster}
                hotlist={{
                  entries: hotlist,
                  onSave: (entry) =>
                    void updateSettings({ subagentHotlist: appendRosterEntries(hotlist, [entry]) }),
                }}
              />
            )}
            <SubagentRosterAddControls
              entries={roster.entries}
              instances={instances}
              pickerInstances={pickerInstances}
              modelOptionsByInstance={modelOptionsByInstance}
              hotlist={hotlist}
              onChange={saveRoster}
              presetsReplace
            />
          </>
        )
      ) : null}
    </ThreadDetailsSection>
  );
}
