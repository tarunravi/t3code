import type {
  SubagentPreset,
  SubagentPresetEntry,
  SubagentRole,
  SubagentRosterEntry,
} from "@t3tools/contracts";

import { rosterEntryKey } from "../chat/threadSubagentRoster.logic";

/** Drops a preset entry's description so it can ride the shared roster helpers. */
export function presetEntryAsRosterEntry(entry: SubagentPresetEntry): SubagentRosterEntry {
  const { description: _description, ...rest } = entry;
  return rest;
}

/** Re-attaches descriptions to entries the shared roster helpers returned. */
export function mergePresetDescriptions(
  entries: ReadonlyArray<SubagentPresetEntry>,
  next: ReadonlyArray<SubagentRosterEntry>,
): SubagentPresetEntry[] {
  const descriptions = new Map(
    entries.map((entry) => [rosterEntryKey(presetEntryAsRosterEntry(entry)), entry.description]),
  );
  return next.map((entry) => {
    const description = descriptions.get(rosterEntryKey(entry));
    return description === undefined ? entry : { ...entry, description };
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

/** A role names one entry at a time within a preset, so assigning it clears it elsewhere. */
export function applyPresetEntryRole(
  preset: SubagentPreset,
  index: number,
  role: SubagentRole | null,
): SubagentPreset {
  return {
    ...preset,
    entries: preset.entries.map((entry, entryIndex) => {
      if (entryIndex === index) {
        const { role: _previous, ...rest } = entry;
        return role === null ? rest : { ...rest, role };
      }
      if (role !== null && entry.role === role) {
        const { role: _cleared, ...rest } = entry;
        return rest;
      }
      return entry;
    }),
  };
}

export function applyPresetEntryDescription(
  preset: SubagentPreset,
  index: number,
  description: string,
): SubagentPreset {
  const trimmed = description.trim();
  return {
    ...preset,
    entries: preset.entries.map((entry, entryIndex) => {
      if (entryIndex !== index) return entry;
      const { description: _previous, ...rest } = entry;
      return trimmed === "" ? rest : { ...rest, description: trimmed };
    }),
  };
}
