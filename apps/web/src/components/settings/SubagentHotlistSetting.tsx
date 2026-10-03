import type { EnvironmentId, SubagentRosterEntry } from "@t3tools/contracts";

import {
  SubagentRosterAddControls,
  SubagentRosterList,
  useSubagentInstances,
} from "../chat/SubagentRosterList";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function HotlistEditor(props: {
  environmentId: EnvironmentId;
  entries: ReadonlyArray<SubagentRosterEntry>;
  onChange: (entries: SubagentRosterEntry[]) => void;
}) {
  const { instances, pickerInstances, modelOptionsByInstance } = useSubagentInstances(
    props.environmentId,
  );
  return (
    <div className="w-full max-w-md rounded-xl border border-border/65 p-1">
      {props.entries.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">
          Nothing saved yet. Add a recommended set or pick models.
        </p>
      ) : (
        <SubagentRosterList
          entries={props.entries}
          instances={instances}
          onChange={props.onChange}
        />
      )}
      <SubagentRosterAddControls
        entries={props.entries}
        instances={instances}
        pickerInstances={pickerInstances}
        modelOptionsByInstance={modelOptionsByInstance}
        hotlist={[]}
        onChange={props.onChange}
        presetsReplace={false}
      />
    </div>
  );
}

/** Saved subagents a thread's Subagents section offers first. */
export function SubagentHotlistSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["subagentHotlist"]);
  const entries = mixed ? [] : settings.subagentHotlist;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["subagentHotlist"]}
      {...searchableSetting("subagent-hotlist")}
      description="Subagents you use often. Each thread's Subagents section offers these first; its own picks decide what the agent may delegate to."
      resetAction={
        settings.subagentHotlist.length > 0 ? (
          <SettingResetButton
            label="subagent hotlist"
            onClick={() => updateSettings({ subagentHotlist: [] })}
          />
        ) : null
      }
      control={
        connectedEnvironments.length === 0 || environment === null ? (
          <span className="text-sm text-muted-foreground">
            Connect an environment to save subagents.
          </span>
        ) : null
      }
    >
      {connectedEnvironments.length === 0 || environment === null ? null : (
        <HotlistEditor
          environmentId={environment.environmentId}
          entries={entries}
          onChange={(next) => updateSettings({ subagentHotlist: next })}
        />
      )}
    </SettingsRow>
  );
}
