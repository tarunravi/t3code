import { ANTIGRAVITY_DEFAULT_MODEL, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

export const ANTIGRAVITY_EFFORT_OPTION_ID = "effort";

const EFFORT_LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
] as const;
const EFFORT_SUFFIX = new RegExp(`-(${EFFORT_LEVELS.map((level) => level.id).join("|")})$`, "u");
const NAME_EFFORT_SUFFIX = /\s*\((?:low|medium|high|extra high|xhigh|max)\)\s*$/iu;
const DEFAULT_EFFORT = "medium";

/**
 * Antigravity's runtime does not advertise Claude Opus 5.5 to every account
 * yet, but the agy CLI ships these ids. Listing it lets T3 request it; the
 * runtime still decides whether the account can use it.
 */
const SUPPLEMENTAL_MODELS = [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high", "max"] },
] as const;

export interface AntigravityModelEntry {
  readonly value: string;
  readonly name: string;
}

interface ModelFamily {
  slug: string;
  name: string;
  efforts: Array<string>;
  /** Advertised id when the family is a single, ungrouped model. */
  exact?: string;
}

function effortLabel(effort: string) {
  return EFFORT_LEVELS.find((level) => level.id === effort)?.label ?? effort;
}

function effortCapabilities(efforts: ReadonlyArray<string>, currentValue: string) {
  const ordered = EFFORT_LEVELS.map((level) => level.id).filter((id) => efforts.includes(id));
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: ANTIGRAVITY_EFFORT_OPTION_ID,
        label: "Reasoning",
        type: "select",
        options: ordered.map((id) => ({
          id,
          label: effortLabel(id),
          ...(id === currentValue ? { isDefault: true } : {}),
        })),
        currentValue,
      },
    ],
  });
}

function splitEffort(value: string): { base: string; effort: string } | undefined {
  const match = EFFORT_SUFFIX.exec(value);
  return match?.[1] ? { base: value.slice(0, match.index), effort: match[1] } : undefined;
}

/**
 * Antigravity publishes one model id per thinking level
 * (`gemini-4-argon-high`). Collapse each family with two or more levels into
 * one model with a reasoning option so the picker matches other providers.
 */
export function buildAntigravityModels(
  entries: ReadonlyArray<AntigravityModelEntry>,
  currentValue: string | undefined,
): ReadonlyArray<ServerProviderModel> {
  const levelsByBase = new Map<string, Set<string>>();
  for (const entry of entries) {
    const split = splitEffort(entry.value);
    if (split)
      levelsByBase.set(split.base, (levelsByBase.get(split.base) ?? new Set()).add(split.effort));
  }
  const families = new Map<string, ModelFamily>();
  for (const entry of entries) {
    const split = splitEffort(entry.value);
    if (split && (levelsByBase.get(split.base)?.size ?? 0) > 1) {
      const family = families.get(split.base);
      if (family) {
        if (!family.efforts.includes(split.effort)) family.efforts.push(split.effort);
        continue;
      }
      families.set(split.base, {
        slug: split.base,
        name: entry.name.replace(NAME_EFFORT_SUFFIX, "").trim() || split.base,
        efforts: [split.effort],
      });
    } else if (!families.has(entry.value)) {
      families.set(entry.value, {
        slug: entry.value,
        name: entry.name,
        efforts: [],
        exact: entry.value,
      });
    }
  }
  if (families.size > 0) {
    for (const model of SUPPLEMENTAL_MODELS) {
      if (!families.has(model.slug)) {
        families.set(model.slug, { ...model, efforts: [...model.efforts] });
      }
    }
  }

  const currentFamily = currentValue ? (splitEffort(currentValue)?.base ?? currentValue) : null;
  return [...families.values()].map((family): ServerProviderModel => {
    const isCurrent =
      family.exact !== undefined ? family.exact === currentValue : family.slug === currentFamily;
    const currentEffort = isCurrent && currentValue ? splitEffort(currentValue)?.effort : undefined;
    const defaultEffort =
      currentEffort && family.efforts.includes(currentEffort)
        ? currentEffort
        : family.efforts.includes(DEFAULT_EFFORT)
          ? DEFAULT_EFFORT
          : family.efforts[0];
    return {
      slug: family.slug,
      name: family.name,
      isCustom: false,
      ...(isCurrent ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] } : {}),
      capabilities:
        family.exact === undefined && defaultEffort
          ? effortCapabilities(family.efforts, defaultEffort)
          : createModelCapabilities({ optionDescriptors: [] }),
    };
  });
}

/**
 * Map a T3 model selection back to the per-level id Antigravity expects.
 * Exact advertised ids (including selections saved before grouping) pass
 * through unchanged.
 */
export function resolveAntigravityModelId(
  model: string,
  effort: string | undefined,
  available: ReadonlyArray<string>,
): string {
  if (available.includes(model)) return model;
  const levels = available.flatMap((value) => {
    const split = splitEffort(value);
    return split?.base === model ? [split.effort] : [];
  });
  const supplemental = SUPPLEMENTAL_MODELS.find((entry) => entry.slug === model);
  const efforts: ReadonlyArray<string> = levels.length > 0 ? levels : (supplemental?.efforts ?? []);
  if (efforts.length === 0) return model;
  const chosen =
    effort && efforts.includes(effort)
      ? effort
      : efforts.includes(DEFAULT_EFFORT)
        ? DEFAULT_EFFORT
        : efforts[0];
  return `${model}-${chosen}`;
}

export function isSupplementalAntigravityModelId(value: string) {
  const base = splitEffort(value)?.base;
  return SUPPLEMENTAL_MODELS.some((model) => model.slug === base);
}
