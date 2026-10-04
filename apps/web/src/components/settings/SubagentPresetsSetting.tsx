import type { EnvironmentId, SubagentPreset, SubagentPresetEntry } from "@t3tools/contracts";
import { PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { randomUUID } from "../../lib/utils";
import { SubagentRosterAddControls, useSubagentInstances } from "../chat/SubagentRosterList";
import { resolveRosterEntry, rosterEntryKey } from "../chat/threadSubagentRoster.logic";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  applyPresetEntryDescription,
  createPreset,
  mergePresetDescriptions,
  presetEntryAsRosterEntry,
  removePreset,
} from "./subagentPresets.logic";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function PresetEntryRow(props: {
  entry: SubagentPresetEntry;
  instances: ReadonlyArray<ProviderInstanceEntry>;
  onDescription: (description: string) => void;
  onRemove: () => void;
}) {
  const resolved = resolveRosterEntry(presetEntryAsRosterEntry(props.entry), props.instances);
  const providerName = resolved.instance?.displayName ?? props.entry.selection.instanceId;
  const icon = resolved.instance ? (
    <ProviderInstanceIcon
      driverKind={resolved.instance.driverKind}
      displayName={resolved.instance.displayName}
      accentColor={resolved.instance.accentColor}
      acpRegistryAgentId={resolved.instance.acpRegistryAgentId}
      acpRegistryIconUrl={resolved.instance.acpRegistryIconUrl}
      className="size-4"
      iconClassName="size-4"
      {...(resolved.unavailableReason === null ? {} : { statusDotClassName: "bg-warning" })}
    />
  ) : (
    <SparklesIcon className="size-4 text-muted-foreground" aria-hidden />
  );

  return (
    <li className="flex flex-col gap-0.5 rounded-lg py-1.5 ps-2.5 pe-1">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/72 ring-1 ring-border/60">
          {resolved.unavailableReason === null ? (
            icon
          ) : (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>{icon}</TooltipTrigger>
              <TooltipPopup>{resolved.unavailableReason}</TooltipPopup>
            </Tooltip>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <span
            className={
              resolved.unavailableReason === null
                ? "block truncate text-sm font-medium text-foreground/85"
                : "block truncate text-sm font-medium text-muted-foreground"
            }
          >
            {resolved.modelLabel}
          </span>
          <p className="truncate text-2xs text-muted-foreground">
            {resolved.effortLabel === null
              ? providerName
              : `${providerName} · ${resolved.effortLabel}`}
          </p>
        </div>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={`Remove ${resolved.modelLabel} from preset`}
          onClick={props.onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      <DraftInput
        size="sm"
        className="w-full"
        value={props.entry.description ?? ""}
        onCommit={props.onDescription}
        placeholder="Notes: when should an agent pick this model?"
        aria-label={`When to use ${resolved.modelLabel}`}
      />
    </li>
  );
}

function PresetEditor(props: {
  environmentId: EnvironmentId;
  preset: SubagentPreset;
  onChange: (next: SubagentPreset) => void;
  onRemove: () => void;
}) {
  const { instances, pickerInstances, modelOptionsByInstance } = useSubagentInstances(
    props.environmentId,
  );
  const rosterEntries = props.preset.entries.map(presetEntryAsRosterEntry);

  return (
    <div className="w-full max-w-md rounded-xl border border-border/65 p-1">
      <div className="flex items-center gap-1 px-1.5 pt-1">
        <DraftInput
          size="sm"
          className="flex-1"
          value={props.preset.name}
          aria-label="Preset name"
          onCommit={(name) => props.onChange({ ...props.preset, name })}
        />
        <Button
          variant="ghost-destructive"
          size="icon-xs"
          aria-label={`Delete preset ${props.preset.name}`}
          onClick={props.onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      {props.preset.entries.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">
          No subagents yet. Add models below.
        </p>
      ) : (
        <ul
          className="m-0 flex list-none flex-col gap-0.5 p-0"
          aria-label={`Subagents in ${props.preset.name}`}
        >
          {props.preset.entries.map((entry, index) => (
            <PresetEntryRow
              key={rosterEntryKey(presetEntryAsRosterEntry(entry))}
              entry={entry}
              instances={instances}
              onDescription={(description) =>
                props.onChange(applyPresetEntryDescription(props.preset, index, description))
              }
              onRemove={() =>
                props.onChange({
                  ...props.preset,
                  entries: props.preset.entries.filter((_, entryIndex) => entryIndex !== index),
                })
              }
            />
          ))}
        </ul>
      )}
      <SubagentRosterAddControls
        entries={rosterEntries}
        instances={instances}
        pickerInstances={pickerInstances}
        modelOptionsByInstance={modelOptionsByInstance}
        hotlist={[]}
        onChange={(next) =>
          props.onChange({
            ...props.preset,
            entries: mergePresetDescriptions(props.preset.entries, next),
          })
        }
        presetsReplace={false}
      />
    </div>
  );
}

/** Named subagent sets offered when composing a thread's roster. */
export function SubagentPresetsSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["subagentPresets"]);
  const presets = mixed ? [] : settings.subagentPresets;

  return (
    <SettingsRow
      serverScoped
      settingKeys={["subagentPresets"]}
      {...searchableSetting("subagent-presets")}
      description="Named subagent sets to apply when composing a roster. Each entry can note when an agent should pick it."
      resetAction={
        presets.length > 0 ? (
          <SettingResetButton
            label="subagent presets"
            onClick={() => updateSettings({ subagentPresets: [] })}
          />
        ) : null
      }
      control={
        connectedEnvironments.length === 0 || environment === null ? (
          <span className="text-sm text-muted-foreground">
            Connect an environment to save subagent presets.
          </span>
        ) : null
      }
    >
      {connectedEnvironments.length === 0 || environment === null ? null : (
        <div className="flex w-full max-w-md flex-col gap-2">
          {presets.map((preset) => (
            <PresetEditor
              key={preset.id}
              environmentId={environment.environmentId}
              preset={preset}
              onChange={(next) =>
                updateSettings({
                  subagentPresets: presets.map((current) =>
                    current.id === preset.id ? next : current,
                  ),
                })
              }
              onRemove={() => updateSettings({ subagentPresets: removePreset(presets, preset.id) })}
            />
          ))}
          <Button
            variant="ghost-muted"
            size="sm"
            className="self-start"
            onClick={() => updateSettings({ subagentPresets: createPreset(presets, randomUUID()) })}
          >
            <PlusIcon />
            Add preset
          </Button>
        </div>
      )}
    </SettingsRow>
  );
}
