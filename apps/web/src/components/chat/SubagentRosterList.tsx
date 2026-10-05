import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, SubagentRosterEntry } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkPlusIcon,
  EllipsisIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo } from "react";

import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";
import { withSubagentDescription } from "../settings/subagentPresets.logic";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  appendRosterEntries,
  effortDescriptor,
  moveRosterEntry,
  resolvePreset,
  resolveRosterEntry,
  rosterEntryKey,
  rosterEntrySummary,
  sameRosterEntry,
  selectedEffort,
  SUBAGENT_PRESETS,
  withEffort,
} from "./threadSubagentRoster.logic";

const DEFAULT_EFFORT = "default";

/**
 * Provider instances as subagent pickers see them: every configured instance
 * for resolving saved entries, and the environment's subagent allowlist for
 * offering new ones.
 */
export function useSubagentInstances(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  return useMemo(() => {
    const instances = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    );
    const pickerInstances = instances.filter(isProviderInstancePickerVisible);
    const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>(
      pickerInstances.map((instance) => {
        const hidden = new Set(
          settings.subagentModelPreferences[instance.instanceId]?.hiddenModels ?? [],
        );
        return [instance.instanceId, instance.models.filter((model) => !hidden.has(model.slug))];
      }),
    );
    return { instances, pickerInstances, modelOptionsByInstance };
  }, [providers, settings]);
}

/**
 * A subagent's "when to use" note. Wraps and grows with its text so long notes
 * stay readable; Enter still commits like the single-line field it replaced.
 */
export function SubagentNoteField(props: {
  value: string;
  modelLabel: string;
  onCommit: (description: string) => void;
}) {
  const draft = useCommitOnBlur(props.value, props.onCommit);
  return (
    <Textarea
      size="sm"
      rows={1}
      className="[&_textarea]:min-h-0 [&_textarea]:resize-none"
      placeholder="Notes: when should an agent pick this model?"
      aria-label={`Notes for ${props.modelLabel}`}
      {...draft}
    />
  );
}

function RosterEntryRow(props: {
  entry: SubagentRosterEntry;
  index: number;
  count: number;
  instances: ReadonlyArray<ProviderInstanceEntry>;
  saved: boolean | null;
  onReplace: (entry: SubagentRosterEntry) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
  onSave: (() => void) | null;
}) {
  const resolved = resolveRosterEntry(props.entry, props.instances);
  const descriptor = effortDescriptor(resolved.model);
  const effort = selectedEffort(props.entry.selection, descriptor);
  const defaultEffort = descriptor?.options.find((choice) => choice.isDefault)?.id;
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
    <li
      className="flex min-w-0 flex-wrap items-center gap-2.5 rounded-lg py-1.5 ps-2.5 pe-1"
      data-subagent-roster-entry={rosterEntryKey(props.entry)}
    >
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
          className={cn(
            "block truncate text-sm font-medium",
            resolved.unavailableReason === null ? "text-foreground/85" : "text-muted-foreground",
          )}
        >
          {resolved.modelLabel}
        </span>
        <p className="truncate text-2xs text-muted-foreground">
          {rosterEntrySummary(providerName, resolved)}
        </p>
      </div>
      <Menu>
        <MenuTrigger
          render={
            <ThreadDetailsControl part="icon" aria-label={`Options for ${resolved.modelLabel}`} />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          {descriptor === undefined ? null : (
            <>
              <MenuGroup>
                <MenuGroupLabel>{descriptor.label}</MenuGroupLabel>
                <MenuRadioGroup
                  value={effort ?? defaultEffort ?? DEFAULT_EFFORT}
                  onValueChange={(value) =>
                    props.onReplace({
                      ...props.entry,
                      // Always explicit: an unset effort inherits the parent's when the
                      // child runs the parent's model, which is rarely what was picked.
                      selection: withEffort(props.entry.selection, descriptor.id, value as string),
                    })
                  }
                >
                  {descriptor.options.map((choice) => (
                    <MenuRadioItem key={choice.id} value={choice.id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1">{choice.label}</span>
                        <MenuRadioItemIndicator />
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </>
          )}
          <MenuSeparator />
          <MenuItem disabled={props.index === 0} onClick={() => props.onMove(-1)}>
            <ArrowUpIcon />
            Move up
          </MenuItem>
          <MenuItem disabled={props.index === props.count - 1} onClick={() => props.onMove(1)}>
            <ArrowDownIcon />
            Move down
          </MenuItem>
          {props.onSave === null ? null : (
            <MenuItem disabled={props.saved === true} onClick={props.onSave}>
              <BookmarkPlusIcon />
              {props.saved === true ? "In hotlist" : "Save to hotlist"}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={props.onRemove}>
            <Trash2Icon />
            Remove
          </MenuItem>
        </MenuPopup>
      </Menu>
      <SubagentNoteField
        value={props.entry.description ?? ""}
        modelLabel={resolved.modelLabel}
        onCommit={(description) =>
          props.onReplace(withSubagentDescription(props.entry, description))
        }
      />
    </li>
  );
}

/** An editable, ordered list of subagents with notes and reasoning effort. */
export function SubagentRosterList(props: {
  entries: ReadonlyArray<SubagentRosterEntry>;
  instances: ReadonlyArray<ProviderInstanceEntry>;
  onChange: (entries: SubagentRosterEntry[]) => void;
  /** Offer "Save to hotlist" when set; entries already in it read as saved. */
  hotlist?: {
    readonly entries: ReadonlyArray<SubagentRosterEntry>;
    readonly onSave: (entry: SubagentRosterEntry) => void;
  };
}) {
  const { entries, onChange } = props;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="Subagents">
      {entries.map((entry, index) => (
        <RosterEntryRow
          key={rosterEntryKey(entry)}
          entry={entry}
          index={index}
          count={entries.length}
          instances={props.instances}
          saved={
            props.hotlist === undefined
              ? null
              : props.hotlist.entries.some((saved) => sameRosterEntry(saved, entry))
          }
          onReplace={(next) =>
            onChange(
              entries.map((current, currentIndex) => (currentIndex === index ? next : current)),
            )
          }
          onMove={(offset) => onChange(moveRosterEntry(entries, index, offset))}
          onRemove={() => onChange(entries.filter((_, currentIndex) => currentIndex !== index))}
          onSave={props.hotlist === undefined ? null : () => props.hotlist?.onSave(entry)}
        />
      ))}
    </ul>
  );
}

/** "Add" controls shared by the thread panel and the hotlist setting. */
export function SubagentRosterAddControls(props: {
  entries: ReadonlyArray<SubagentRosterEntry>;
  instances: ReadonlyArray<ProviderInstanceEntry>;
  pickerInstances: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  hotlist: ReadonlyArray<SubagentRosterEntry>;
  onChange: (entries: SubagentRosterEntry[]) => void;
  /** Presets replace the list instead of extending it. */
  presetsReplace: boolean;
  className?: string;
}) {
  const { entries, onChange } = props;
  const presets = SUBAGENT_PRESETS.map((preset) => ({
    preset,
    entries: resolvePreset(preset, props.instances),
  }));
  const anchor = entries[0]?.selection ?? props.hotlist[0]?.selection;
  const fallbackInstance = props.pickerInstances[0];
  const activeInstanceId = anchor?.instanceId ?? fallbackInstance?.instanceId;
  const hotlistToAdd = props.hotlist.filter(
    (saved) => !entries.some((entry) => sameRosterEntry(entry, saved)),
  );

  return (
    <div className={cn("flex min-w-0 items-center gap-1 px-1 pt-1", props.className)}>
      <Menu>
        <MenuTrigger render={<ThreadDetailsControl part="row" tone="muted" className="flex-1" />}>
          <PlusIcon className="size-4" />
          Add subagents
        </MenuTrigger>
        <MenuPopup align="start">
          {props.hotlist.length === 0 ? null : (
            <MenuGroup>
              <MenuGroupLabel>Hotlist</MenuGroupLabel>
              {props.hotlist.map((saved) => {
                const resolved = resolveRosterEntry(saved, props.instances);
                const present = entries.some((entry) => sameRosterEntry(entry, saved));
                return (
                  <MenuItem
                    key={rosterEntryKey(saved)}
                    disabled={present}
                    onClick={() => onChange(appendRosterEntries(entries, [saved]))}
                  >
                    {resolved.instance ? (
                      <ProviderInstanceIcon
                        driverKind={resolved.instance.driverKind}
                        displayName={resolved.instance.displayName}
                        accentColor={resolved.instance.accentColor}
                        className="size-4"
                        iconClassName="size-4"
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {rosterEntrySummary(resolved.modelLabel, resolved)}
                    </span>
                  </MenuItem>
                );
              })}
              {hotlistToAdd.length > 1 ? (
                <MenuItem onClick={() => onChange(appendRosterEntries(entries, hotlistToAdd))}>
                  <PlusIcon />
                  Add all from hotlist
                </MenuItem>
              ) : null}
            </MenuGroup>
          )}
          {props.hotlist.length === 0 ? null : <MenuSeparator />}
          <MenuGroup>
            <MenuGroupLabel>Recommended</MenuGroupLabel>
            {presets.map(({ preset, entries: presetEntries }) => (
              <MenuItem
                key={preset.id}
                disabled={presetEntries.length === 0}
                onClick={() =>
                  onChange(
                    props.presetsReplace
                      ? presetEntries
                      : appendRosterEntries(entries, presetEntries),
                  )
                }
              >
                <SparklesIcon />
                <span className="min-w-0 flex-1">
                  <span className="block">{preset.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {presetEntries.length === 0
                      ? "None of these providers are available"
                      : preset.description}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {presetEntries.length}/{preset.slots.length}
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {activeInstanceId === undefined ? null : (
        <ProviderModelPicker
          activeInstanceId={activeInstanceId}
          model={anchor?.model ?? fallbackInstance?.models[0]?.slug ?? ""}
          selectedModels={entries.map((entry) => entry.selection)}
          lockedProvider={null}
          instanceEntries={props.pickerInstances}
          modelOptionsByInstance={props.modelOptionsByInstance}
          size="sm"
          compact
          triggerLabel="Any model"
          triggerAriaLabel="Add a model as a subagent"
          onToggleModel={(instanceId, model) => {
            const existing = entries.findIndex(
              (entry) =>
                entry.selection.instanceId === instanceId && entry.selection.model === model,
            );
            onChange(
              existing === -1
                ? appendRosterEntries(entries, [{ selection: { instanceId, model } }])
                : entries.filter((_, index) => index !== existing),
            );
          }}
          onInstanceModelChange={(instanceId, model) =>
            onChange(appendRosterEntries(entries, [{ selection: { instanceId, model } }]))
          }
        />
      )}
    </div>
  );
}
