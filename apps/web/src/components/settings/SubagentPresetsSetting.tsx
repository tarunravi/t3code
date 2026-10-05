import type { EnvironmentId, SubagentPreset, SubagentPresetEntry } from "@t3tools/contracts";
import { PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { randomUUID } from "../../lib/utils";
import {
  SubagentNoteField,
  SubagentRosterAddControls,
  useSubagentInstances,
} from "../chat/SubagentRosterList";
import {
  resolveRosterEntry,
  rosterEntryKey,
  rosterEntrySummary,
} from "../chat/threadSubagentRoster.logic";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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

const NO_DEFAULT_PRESET = "none";
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

  // Icon, name, and trash share the preset header's columns so every action lines up.
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
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
            {rosterEntrySummary(providerName, resolved)}
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
      <SubagentNoteField
        value={props.entry.description ?? ""}
        modelLabel={resolved.modelLabel}
        onCommit={props.onDescription}
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
    <div className="flex w-full flex-col gap-3 rounded-xl border border-border/65 p-3">
      <div className="flex items-center gap-2">
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
        <p className="text-xs text-muted-foreground">No subagents yet. Add models below.</p>
      ) : (
        <ul
          className="m-0 flex list-none flex-col gap-3 p-0"
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
        // Ghost rows pad their icons; pull them out so "+" sits in the entry icon column.
        className="-mx-1.5 -mb-1 px-0 pt-0"
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

/** The preset a new thread's Subagents panel starts with; each thread can still switch. */
export function DefaultSubagentPresetSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["subagentPresets", "defaultSubagentPresetId"]);
  const presets = mixed ? [] : settings.subagentPresets;
  if (presets.length === 0) return null;
  // A deleted preset leaves a dangling id; new threads then start without a preset.
  const selected = presets.some((preset) => preset.id === settings.defaultSubagentPresetId)
    ? settings.defaultSubagentPresetId!
    : NO_DEFAULT_PRESET;
  const nameById = new Map(presets.map((preset) => [preset.id, preset.name]));

  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultSubagentPresetId"]}
      {...searchableSetting("default-subagent-preset")}
      description="New threads start with this preset selected. Each thread can still switch presets."
      resetAction={
        selected === NO_DEFAULT_PRESET ? null : (
          <SettingResetButton
            label="default subagent preset"
            onClick={() => updateSettings({ defaultSubagentPresetId: null })}
          />
        )
      }
      control={
        <Select
          value={selected}
          onValueChange={(value) =>
            updateSettings({
              defaultSubagentPresetId: value === NO_DEFAULT_PRESET || value === null ? null : value,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Default subagent preset">
            <SelectValue>
              {(value: string | null) =>
                value === null || value === NO_DEFAULT_PRESET
                  ? "None"
                  : (nameById.get(value) ?? "None")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={NO_DEFAULT_PRESET}>None</SelectItem>
            {presets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
