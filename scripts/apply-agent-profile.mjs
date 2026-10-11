#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROFILE = join(ROOT, "config", "agent-profile.json");
const DEFAULT_T3_HOME = join(homedir(), ".t3");
const ALLOWED_PROFILE_KEYS = [
  "schemaVersion",
  "id",
  "version",
  "providerInstances",
  "subagentModelPreferences",
  "presets",
];
const ALLOWED_INSTANCE_KEYS = [
  "instanceId",
  "driver",
  "displayName",
  "preferredEnabled",
  "customModels",
];
const ALLOWED_PRESET_KEYS = ["id", "name", "entries"];
const ALLOWED_ENTRY_KEYS = ["selection", "role", "description"];
const ROLES = new Set(["default", "hard", "bulk", "overnight"]);
const SLUG = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    fail(`${label} must be an object`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  assertObject(value, label);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) fail(`${label} has unsupported field(s): ${extra.join(", ")}`);
}

function nonEmptyString(value, label, max = 160) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > max
  ) {
    fail(`${label} must be a trimmed string of 1–${max} characters`);
  }
  if (/[\r\n\0]/.test(value)) fail(`${label} must be one line`);
  return value;
}

function validateCustomModels(models, label) {
  if (!Array.isArray(models)) fail(`${label} must be an array`);
  for (const [index, model] of models.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (typeof model === "string") {
      nonEmptyString(model, itemLabel, 160);
      continue;
    }
    exactKeys(model, ["slug", "name"], itemLabel);
    nonEmptyString(model.slug, `${itemLabel}.slug`, 160);
    if (model.name !== undefined) nonEmptyString(model.name, `${itemLabel}.name`, 120);
  }
}

function validateProfile(profile) {
  exactKeys(profile, ALLOWED_PROFILE_KEYS, "profile");
  if (profile.schemaVersion !== 1) fail("profile.schemaVersion must be 1");
  nonEmptyString(profile.id, "profile.id", 80);
  if (!Number.isInteger(profile.version) || profile.version < 1)
    fail("profile.version must be a positive integer");
  if (!Array.isArray(profile.providerInstances) || profile.providerInstances.length === 0) {
    fail("profile.providerInstances must be a non-empty array");
  }
  const identities = new Map();
  for (const [index, instance] of profile.providerInstances.entries()) {
    const label = `profile.providerInstances[${index}]`;
    exactKeys(instance, ALLOWED_INSTANCE_KEYS, label);
    if (!SLUG.test(instance.instanceId ?? "") || !SLUG.test(instance.driver ?? "")) {
      fail(`${label} instanceId and driver must be provider slugs`);
    }
    if (identities.has(instance.instanceId))
      fail(`${label} duplicates instanceId ${instance.instanceId}`);
    if (typeof instance.preferredEnabled !== "boolean")
      fail(`${label}.preferredEnabled must be boolean`);
    if (instance.displayName !== undefined)
      nonEmptyString(instance.displayName, `${label}.displayName`, 80);
    validateCustomModels(instance.customModels, `${label}.customModels`);
    identities.set(instance.instanceId, instance);
  }
  assertObject(profile.subagentModelPreferences, "profile.subagentModelPreferences");
  for (const [instanceId, preference] of Object.entries(profile.subagentModelPreferences)) {
    if (!identities.has(instanceId))
      fail(`subagentModelPreferences references unknown instance ${instanceId}`);
    exactKeys(preference, ["hiddenModels"], `subagentModelPreferences.${instanceId}`);
    if (
      !Array.isArray(preference.hiddenModels) ||
      preference.hiddenModels.some((model) => typeof model !== "string")
    ) {
      fail(`subagentModelPreferences.${instanceId}.hiddenModels must be an array of strings`);
    }
  }
  if (!Array.isArray(profile.presets)) fail("profile.presets must be an array");
  const presetIds = new Set();
  for (const [index, preset] of profile.presets.entries()) {
    const label = `profile.presets[${index}]`;
    exactKeys(preset, ALLOWED_PRESET_KEYS, label);
    nonEmptyString(preset.id, `${label}.id`, 80);
    nonEmptyString(preset.name, `${label}.name`, 80);
    if (presetIds.has(preset.id)) fail(`${label} duplicates preset id ${preset.id}`);
    presetIds.add(preset.id);
    if (!Array.isArray(preset.entries)) fail(`${label}.entries must be an array`);
    for (const [entryIndex, entry] of preset.entries.entries()) {
      const entryLabel = `${label}.entries[${entryIndex}]`;
      exactKeys(entry, ALLOWED_ENTRY_KEYS, entryLabel);
      exactKeys(entry.selection, ["instanceId", "model", "options"], `${entryLabel}.selection`);
      if (!identities.has(entry.selection.instanceId))
        fail(`${entryLabel} references unknown provider instance`);
      nonEmptyString(entry.selection.model, `${entryLabel}.selection.model`, 200);
      if (entry.selection.options !== undefined) {
        if (!Array.isArray(entry.selection.options))
          fail(`${entryLabel}.selection.options must be an array`);
        for (const option of entry.selection.options) {
          exactKeys(option, ["id", "value"], `${entryLabel}.selection option`);
          nonEmptyString(option.id, `${entryLabel}.selection option id`, 80);
          if (typeof option.value !== "string" && typeof option.value !== "boolean") {
            fail(`${entryLabel}.selection option value must be a string or boolean`);
          }
          if (typeof option.value === "string")
            nonEmptyString(option.value, `${entryLabel}.selection option value`, 120);
        }
      }
      if (entry.role !== undefined && !ROLES.has(entry.role))
        fail(`${entryLabel}.role is unsupported`);
      if (entry.description !== undefined) {
        nonEmptyString(entry.description, `${entryLabel}.description`, 240);
        if (/(?:https?:\/\/|\b[A-Za-z]:\\|\/Users\/|\/home\/)/i.test(entry.description)) {
          fail(`${entryLabel}.description must not contain URLs or machine paths`);
        }
      }
    }
  }
}

function parseArgs(argv) {
  let apply = false;
  let t3Home = DEFAULT_T3_HOME;
  let profilePath = DEFAULT_PROFILE;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--home") {
      const value = argv[++i];
      if (!value) fail("--home requires a T3 home directory");
      t3Home = resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else if (arg.startsWith("-")) fail(`unknown option ${arg}`);
    else if (profilePath === DEFAULT_PROFILE) profilePath = resolve(arg);
    else fail("provide at most one profile path");
  }
  return { apply, t3Home, profilePath };
}

function modelKey(model) {
  return typeof model === "string" ? model : model.slug;
}

function mergeModels(existing, incoming) {
  if (existing !== undefined && !Array.isArray(existing))
    fail("target customModels must be an array");
  const merged = new Map();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...incoming])
    merged.set(modelKey(item), item);
  return [...merged.values()];
}

function mergeProfile(settings, profile, settingsExisted) {
  for (const [key, label] of [
    ["providerInstances", "target providerInstances"],
    ["subagentModelPreferences", "target subagentModelPreferences"],
  ]) {
    if (settings[key] !== undefined) assertObject(settings[key], label);
  }
  if (settings.subagentPresets !== undefined && !Array.isArray(settings.subagentPresets)) {
    fail("target subagentPresets must be an array");
  }
  const providerInstances = { ...(settings.providerInstances ?? {}) };
  let addedInstances = 0;
  for (const portable of profile.providerInstances) {
    const hasExplicitInstance = Object.hasOwn(providerInstances, portable.instanceId);
    const hasLegacyConfig = Object.hasOwn(settings.providers ?? {}, portable.instanceId);
    const implicitBuiltin =
      settingsExisted &&
      !hasExplicitInstance &&
      !hasLegacyConfig &&
      (portable.instanceId === "codex" || portable.instanceId === "claudeAgent");
    if (implicitBuiltin && portable.customModels.length === 0) continue;
    // Old settings store the default instance's local configuration under
    // providers[driver]. Let the server's migration/hydration retain that
    // enabled state and config rather than shadowing it with a disabled entry.
    if (!hasExplicitInstance && hasLegacyConfig) continue;
    const current = Object.hasOwn(providerInstances, portable.instanceId)
      ? providerInstances[portable.instanceId]
      : undefined;
    if (current !== undefined)
      assertObject(current, `target providerInstances.${portable.instanceId}`);
    if (current && current.driver !== portable.driver) {
      fail(
        `target instance ${portable.instanceId} uses driver ${current.driver}; profile expects ${portable.driver}`,
      );
    }
    const next = {
      ...(current ?? { driver: portable.driver, enabled: implicitBuiltin ? true : false }),
    };
    if (portable.displayName !== undefined) next.displayName = portable.displayName;
    if (portable.customModels.length) {
      if (current?.config !== undefined && !isRecord(current.config)) {
        fail(`target instance ${portable.instanceId} config is not an object`);
      }
      const config = { ...(current?.config ?? {}) };
      config.customModels = mergeModels(config.customModels, portable.customModels);
      next.config = config;
    }
    providerInstances[portable.instanceId] = next;
    if (!current) addedInstances += 1;
  }

  const subagentModelPreferences = {
    ...(settings.subagentModelPreferences ?? {}),
    ...profile.subagentModelPreferences,
  };
  const subagentPresets = [...(settings.subagentPresets ?? [])];
  let updatedPresets = 0;
  for (const preset of profile.presets) {
    const index = subagentPresets.findIndex((current) => current?.id === preset.id);
    const sameNameIndex =
      index < 0 ? subagentPresets.findIndex((current) => current?.name === preset.name) : -1;
    if (index >= 0) subagentPresets[index] = preset;
    else if (sameNameIndex >= 0) {
      subagentPresets[sameNameIndex] = { ...preset, id: subagentPresets[sameNameIndex].id };
    } else subagentPresets.push(preset);
    updatedPresets += 1;
  }
  return {
    settings: { ...settings, providerInstances, subagentModelPreferences, subagentPresets },
    addedInstances,
    updatedPresets,
  };
}

function backupName(settingsPath) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  return `${settingsPath}.bak.${stamp}.${process.pid}.${randomUUID().slice(0, 8)}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/apply-agent-profile.mjs [--apply] [--home T3_HOME] [PROFILE.json]",
    );
    console.log(
      "Preview is the default. --home points to a T3 home containing userdata/settings.json.",
    );
    return;
  }
  const rawProfile = readFileSync(args.profilePath, "utf8");
  if (Buffer.byteLength(rawProfile) > 256_000) fail("profile exceeds 256 KB");
  const profile = JSON.parse(rawProfile);
  validateProfile(profile);
  const settingsPath = join(args.t3Home, "userdata", "settings.json");
  let targetStat;
  try {
    targetStat = lstatSync(settingsPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const existed = targetStat !== undefined;
  if (targetStat?.isSymbolicLink()) fail("refusing to replace a symlinked settings.json");
  if (existed && !targetStat.isFile()) fail("settings.json must be a regular file");
  const original = existed ? readFileSync(settingsPath, "utf8") : "{}\n";
  const currentSettings = JSON.parse(original);
  assertObject(currentSettings, "target settings");
  const merged = mergeProfile(currentSettings, profile, existed);
  const result = JSON.stringify(merged.settings, null, 2) + "\n";
  console.log(
    `${args.apply ? "Apply" : "Preview"} profile ${profile.id} v${profile.version} to ${settingsPath}`,
  );
  console.log(
    `Provider identities: ${profile.providerInstances.length} reviewed, ${merged.addedInstances} added disabled`,
  );
  console.log(
    `Subagent model preferences: ${Object.keys(profile.subagentModelPreferences).length} instance entries`,
  );
  console.log(`Presets: ${merged.updatedPresets} added or merged by id or name`);
  console.log(
    "Existing provider enablement, credentials, paths, unrelated settings, and thread rosters are preserved.",
  );
  console.log(
    "Missing nondefault identities are added disabled; legacy and implicit Codex/Claude defaults retain T3 enablement.",
  );
  if (!args.apply) {
    console.log(
      `${existed ? "Preview only. Re-run with --apply to write settings." : "No settings file exists yet; --apply will create it."}`,
    );
    return;
  }
  if (existed && result === original) {
    console.log("Settings already match this profile; no file or backup created.");
    return;
  }
  const backupPath = backupName(settingsPath);
  if (existed) copyFileSync(settingsPath, backupPath);
  else mkdirSync(dirname(settingsPath), { recursive: true });
  const tempPath = `${settingsPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, result, { mode: existed ? statSync(settingsPath).mode : 0o600 });
    if (existed) chmodSync(tempPath, statSync(settingsPath).mode & 0o777);
    renameSync(tempPath, settingsPath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {}
    throw error;
  }
  console.log(existed ? `Backup: ${backupPath}` : `Created settings: ${settingsPath}`);
}

try {
  main();
} catch (error) {
  console.error(`Profile not applied: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
