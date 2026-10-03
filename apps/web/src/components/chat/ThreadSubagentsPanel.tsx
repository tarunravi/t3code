import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SubagentRosterEntry, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GlobeIcon, Settings2Icon } from "lucide-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { Switch } from "../ui/switch";
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
import { cn } from "../../lib/utils";

/**
 * Thread details section choosing which subagents this thread's agent may
 * delegate to. Off follows the environment's subagent allowlist; on, the
 * thread keeps its own ordered roster, which the server enforces.
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
  if (!supported) return null;

  const roster = settings.threadSubagentRosters[props.threadId];
  const hotlist = settings.subagentHotlist;
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
      {roster === undefined ? (
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
      )}
    </ThreadDetailsSection>
  );
}
