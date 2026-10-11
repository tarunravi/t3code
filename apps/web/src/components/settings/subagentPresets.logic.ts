import type {
  ServerSettingsPatch,
  ThreadId,
  SubagentPreset,
  SubagentPresetEntry,
  SubagentRosterEntry,
} from "@t3tools/contracts";

import { rosterEntryKey } from "../chat/threadSubagentRoster.logic";

/** Presets and persisted rosters share selections and descriptions. */
export function presetEntryAsRosterEntry(entry: SubagentPresetEntry): SubagentRosterEntry {
  return entry.description === undefined
    ? { selection: entry.selection }
    : { selection: entry.selection, description: entry.description };
}

/** Re-attaches descriptions to entries the shared roster helpers returned. */
export function mergePresetDescriptions(
  entries: ReadonlyArray<SubagentPresetEntry>,
  next: ReadonlyArray<SubagentRosterEntry>,
): SubagentPresetEntry[] {
  const descriptions = new Map<string, (string | undefined)[]>();
  for (const entry of entries) {
    const key = rosterEntryKey(presetEntryAsRosterEntry(entry));
    const matches = descriptions.get(key) ?? [];
    matches.push(entry.description);
    descriptions.set(key, matches);
  }
  return next.map((entry) => {
    const matches = descriptions.get(rosterEntryKey(entry));
    if (matches === undefined || matches.length === 0)
      return withSubagentDescription(entry, entry.description ?? "");
    const [previousDescription] = matches.splice(0, 1);
    return withSubagentDescription(entry, entry.description ?? previousDescription ?? "");
  });
}

export function createPreset(presets: ReadonlyArray<SubagentPreset>, id: string): SubagentPreset[] {
  const taken = new Set(presets.map((preset) => preset.name));
  let name = "New preset";
  for (let suffix = 2; taken.has(name); suffix += 1) {
    name = `New preset ${suffix}`;
  }
  return [...presets, { id, name, entries: [] }];
}

export function renamePreset(
  presets: ReadonlyArray<SubagentPreset>,
  id: string,
  name: string,
): SubagentPreset[] {
  const trimmed = name.trim();
  if (trimmed === "") return [...presets];
  return presets.map((preset) => (preset.id === id ? { ...preset, name: trimmed } : preset));
}

export function removePreset(presets: ReadonlyArray<SubagentPreset>, id: string): SubagentPreset[] {
  return presets.filter((preset) => preset.id !== id);
}

/** Copies a preset into a thread roster: selection and description. */
export function applyPresetToRoster(preset: SubagentPreset): SubagentRosterEntry[] {
  return preset.entries.map(presetEntryAsRosterEntry);
}

/** The preset whose entries exactly match a roster in order, for labeling the compact panel. */
export function findPresetForRoster(
  presets: ReadonlyArray<SubagentPreset>,
  entries: ReadonlyArray<SubagentRosterEntry>,
): SubagentPreset | null {
  const keys = entries.map((entry) => `${rosterEntryKey(entry)}\u0000${entry.description ?? ""}`);
  return (
    presets.find(
      (preset) =>
        preset.entries.length === keys.length &&
        preset.entries.every(
          (entry, index) =>
            `${rosterEntryKey(presetEntryAsRosterEntry(entry))}\u0000${entry.description ?? ""}` ===
            keys[index],
        ),
    ) ?? null
  );
}

export function applyPresetEntryDescription(
  preset: SubagentPreset,
  index: number,
  description: string,
): SubagentPreset {
  return {
    ...preset,
    entries: preset.entries.map((entry, entryIndex) => {
      const rosterEntry = presetEntryAsRosterEntry(entry);
      if (entryIndex !== index) return rosterEntry;
      return withSubagentDescription(rosterEntry, description);
    }),
  };
}

/** Drafts carry intent locally; save it under the real destination ids before starting turns. */
export function draftSubagentRosterPatch(
  entries: ReadonlyArray<SubagentRosterEntry> | null | undefined,
  threadIds: ReadonlyArray<ThreadId>,
): ServerSettingsPatch | null {
  if (entries === undefined) return null;
  return {
    threadSubagentRosters: Object.fromEntries(
      threadIds.map((threadId) => [
        threadId,
        entries === null
          ? null
          : {
              entries: entries.map((entry) =>
                withSubagentDescription(entry, entry.description ?? ""),
              ),
            },
      ]),
    ),
  };
}

/** Editing notes preserves model options on saved entries. */
export function withSubagentDescription(
  entry: SubagentRosterEntry,
  description: string,
): SubagentRosterEntry {
  const trimmed = description.trim();
  return trimmed === ""
    ? { selection: entry.selection }
    : { selection: entry.selection, description: trimmed };
}
