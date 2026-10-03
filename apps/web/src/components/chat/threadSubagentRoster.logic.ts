import {
  ProviderDriverKind,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
  type SubagentRole,
  type SubagentRosterEntry,
} from "@t3tools/contracts";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";

export const SUBAGENT_ROLES: ReadonlyArray<SubagentRole> = ["default", "hard", "bulk", "overnight"];

export const SUBAGENT_ROLE_META: Record<
  SubagentRole,
  {
    readonly label: string;
    readonly description: string;
    readonly badge: "info" | "warning" | "success" | "secondary";
  }
> = {
  default: { label: "Default", description: "Everyday work", badge: "info" },
  hard: { label: "Hardest", description: "Design, polish, tricky bugs", badge: "warning" },
  bulk: { label: "Bulk", description: "Quick mechanical work", badge: "success" },
  overnight: { label: "Overnight", description: "Long unattended runs", badge: "secondary" },
};

interface PresetSlot {
  readonly driverKind: ProviderDriverKind;
  /** Preferred model ids in order; `"*"` accepts the instance's first model. */
  readonly models: ReadonlyArray<string>;
  readonly effort?: string;
  readonly role: SubagentRole;
}

export interface SubagentPreset {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly slots: ReadonlyArray<PresetSlot>;
}

const OPUS_MODELS = ["claude-opus-5-5", "claude-opus-5", "*"];
const GLM_SLOT: PresetSlot = {
  driverKind: ProviderDriverKind.make("zcode"),
  models: ["default", "*"],
  role: "overnight",
};

/** Recommended rosters from the agent model routing policy. */
export const SUBAGENT_PRESETS: ReadonlyArray<SubagentPreset> = [
  {
    id: "work",
    label: "Work",
    description: "Opus 5.5 for everything, GLM overnight",
    slots: [
      {
        driverKind: ProviderDriverKind.make("claudeAgent"),
        models: OPUS_MODELS,
        effort: "medium",
        role: "default",
      },
      GLM_SLOT,
    ],
  },
  {
    id: "personal",
    label: "Personal",
    description: "Codex by default, Opus for the hardest, Gemini Flash for bulk, GLM overnight",
    slots: [
      {
        driverKind: ProviderDriverKind.make("codex"),
        models: ["gpt-6-astra", "*"],
        effort: "medium",
        role: "default",
      },
      {
        driverKind: ProviderDriverKind.make("claudeAgent"),
        models: OPUS_MODELS,
        effort: "medium",
        role: "hard",
      },
      {
        driverKind: ProviderDriverKind.make("antigravity"),
        models: ["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "*"],
        role: "bulk",
      },
      GLM_SLOT,
    ],
  },
];

const EFFORT_OPTION_IDS = ["effort", "reasoningEffort", "reasoning_effort", "variant"];

export function effortDescriptor(
  model: ServerProviderModel | undefined,
): Extract<ProviderOptionDescriptor, { type: "select" }> | undefined {
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  for (const id of EFFORT_OPTION_IDS) {
    const descriptor = descriptors.find((candidate) => candidate.id === id);
    if (descriptor?.type === "select") return descriptor;
  }
  return undefined;
}

/** Selection with the effort option set, or cleared when `value` is null. */
export function withEffort(
  selection: ModelSelection,
  descriptorId: string,
  value: string | null,
): ModelSelection {
  const others = (selection.options ?? []).filter((option) => option.id !== descriptorId);
  const options = value === null ? others : [...others, { id: descriptorId, value }];
  const { options: _previous, ...base } = selection;
  return options.length === 0 ? base : { ...base, options };
}

export function selectedEffort(
  selection: ModelSelection,
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | undefined,
): string | null {
  if (descriptor === undefined) return null;
  const value = selection.options?.find((option) => option.id === descriptor.id)?.value;
  return typeof value === "string" ? value : null;
}

export function rosterEntryKey(entry: SubagentRosterEntry): string {
  const options = (entry.selection.options ?? [])
    .map((option) => `${option.id}=${String(option.value)}`)
    .toSorted()
    .join(",");
  return `${entry.selection.instanceId}\u0000${entry.selection.model}\u0000${options}`;
}

export function sameRosterEntry(left: SubagentRosterEntry, right: SubagentRosterEntry): boolean {
  return rosterEntryKey(left) === rosterEntryKey(right);
}

export function moveRosterEntry<T>(entries: ReadonlyArray<T>, index: number, offset: -1 | 1): T[] {
  const target = index + offset;
  if (index < 0 || index >= entries.length || target < 0 || target >= entries.length) {
    return [...entries];
  }
  const next = [...entries];
  const [entry] = next.splice(index, 1);
  next.splice(target, 0, entry as T);
  return next;
}

/** A role names one entry at a time, so assigning it clears it elsewhere. */
export function assignRosterRole(
  entries: ReadonlyArray<SubagentRosterEntry>,
  index: number,
  role: SubagentRole | null,
): SubagentRosterEntry[] {
  return entries.map((entry, entryIndex) => {
    if (entryIndex === index) {
      const { role: _previous, ...rest } = entry;
      return role === null ? rest : { ...rest, role };
    }
    if (role !== null && entry.role === role) {
      const { role: _cleared, ...rest } = entry;
      return rest;
    }
    return entry;
  });
}

/** Adds entries that are not already present, keeping existing order. */
export function appendRosterEntries(
  entries: ReadonlyArray<SubagentRosterEntry>,
  additions: ReadonlyArray<SubagentRosterEntry>,
): SubagentRosterEntry[] {
  const next = [...entries];
  for (const addition of additions) {
    if (next.some((entry) => sameRosterEntry(entry, addition))) continue;
    const role =
      addition.role !== undefined && next.some((entry) => entry.role === addition.role)
        ? undefined
        : addition.role;
    const { role: _role, ...rest } = addition;
    next.push(role === undefined ? rest : { ...rest, role });
  }
  return next;
}

/** Instantiates a preset against the live provider list, skipping slots nothing can serve. */
export function resolvePreset(
  preset: SubagentPreset,
  instances: ReadonlyArray<ProviderInstanceEntry>,
): SubagentRosterEntry[] {
  const entries: SubagentRosterEntry[] = [];
  for (const slot of preset.slots) {
    const candidates = instances.filter(
      (instance) =>
        instance.driverKind === slot.driverKind && isProviderInstancePickerReady(instance),
    );
    for (const instance of candidates) {
      const model = slot.models
        .map((id) => (id === "*" ? instance.models[0] : instance.models.find((m) => m.slug === id)))
        .find((candidate) => candidate !== undefined);
      if (model === undefined) continue;
      const descriptor = effortDescriptor(model);
      const selection: ModelSelection = { instanceId: instance.instanceId, model: model.slug };
      entries.push({
        selection:
          slot.effort !== undefined &&
          descriptor?.options.some((choice) => choice.id === slot.effort)
            ? withEffort(selection, descriptor.id, slot.effort)
            : selection,
        role: slot.role,
      });
      break;
    }
  }
  return entries;
}

export interface ResolvedRosterEntry {
  readonly entry: SubagentRosterEntry;
  readonly instance: ProviderInstanceEntry | undefined;
  readonly model: ServerProviderModel | undefined;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
  /** Why delegation to this entry would fail right now, if it would. */
  readonly unavailableReason: string | null;
}

export function resolveRosterEntry(
  entry: SubagentRosterEntry,
  instances: ReadonlyArray<ProviderInstanceEntry>,
): ResolvedRosterEntry {
  const instance = instances.find(
    (candidate) => candidate.instanceId === entry.selection.instanceId,
  );
  const model = instance?.models.find((candidate) => candidate.slug === entry.selection.model);
  const descriptor = effortDescriptor(model);
  const effort = selectedEffort(entry.selection, descriptor);
  const effortLabel =
    effort === null
      ? null
      : (descriptor?.options.find((choice) => choice.id === effort)?.label ?? effort);
  const unavailableReason =
    instance === undefined
      ? `Provider ${entry.selection.instanceId} is not configured here.`
      : !isProviderInstancePickerReady(instance)
        ? `${instance.displayName} is not available.`
        : model === undefined && instance.models.length > 0
          ? `${instance.displayName} no longer offers this model.`
          : null;
  return {
    entry,
    instance,
    model,
    modelLabel: model?.shortName ?? model?.name ?? entry.selection.model,
    effortLabel,
    unavailableReason,
  };
}
