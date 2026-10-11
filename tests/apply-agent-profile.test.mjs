import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/apply-agent-profile.mjs");
const bundledProfile = resolve("config/agent-profile.json");

function makeHome(settings) {
  const root = mkdtempSync(join(tmpdir(), "t3-agent-profile-"));
  const userdata = join(root, "userdata");
  mkdirSync(userdata);
  const settingsPath = join(userdata, "settings.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { root, settingsPath };
}

function run(home, profilePath = bundledProfile, apply = false) {
  return spawnSync(
    process.execPath,
    [script, ...(apply ? ["--apply"] : []), "--home", home, profilePath],
    {
      encoding: "utf8",
    },
  );
}

test("applies portable choices while preserving recipient credentials, paths, settings, and rosters", (t) => {
  const { root, settingsPath } = makeHome({
    apiToken: "test-only-local-value",
    unrelatedSetting: { keep: true },
    defaultSubagentPresetId: "local-work-id",
    providerInstances: {
      codex: {
        driver: "codex",
        enabled: false,
        environment: [{ name: "LOCAL_TOKEN", value: "test-only-local-value", sensitive: true }],
        config: {
          executablePath: "/recipient/path/codex",
          apiKey: "test-only-local-value",
          customModels: ["recipient-model"],
        },
      },
    },
    subagentModelPreferences: { recipient: { hiddenModels: ["keep-hidden"] } },
    subagentPresets: [
      {
        id: "local-work-id",
        name: "Work",
        entries: [{ selection: { instanceId: "codex", model: "recipient-model" } }],
      },
      { id: "my-custom", name: "Personal", entries: [] },
    ],
    threadSubagentRosters: {
      threadA: { entries: [{ selection: { instanceId: "codex", model: "recipient-model" } }] },
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = run(root, bundledProfile, true);
  assert.equal(first.status, 0, first.stderr);
  const imported = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(imported.apiToken, "test-only-local-value");
  assert.deepEqual(imported.unrelatedSetting, { keep: true });
  assert.equal(imported.providerInstances.codex.enabled, false);
  assert.equal(imported.providerInstances.codex.environment[0].value, "test-only-local-value");
  assert.equal(imported.providerInstances.codex.config.apiKey, "test-only-local-value");
  assert.equal(imported.providerInstances.codex.config.executablePath, "/recipient/path/codex");
  assert.deepEqual(imported.providerInstances.codex.config.customModels, ["recipient-model"]);
  assert.equal(imported.providerInstances.opencode.enabled, false);
  assert.equal(imported.providerInstances.omp.enabled, false);
  assert.deepEqual(imported.subagentModelPreferences.recipient, { hiddenModels: ["keep-hidden"] });
  assert.deepEqual(imported.threadSubagentRosters.threadA, {
    entries: [{ selection: { instanceId: "codex", model: "recipient-model" } }],
  });
  assert.equal(imported.defaultSubagentPresetId, "local-work-id");
  assert.deepEqual(
    imported.subagentPresets.map(({ id, name }) => ({ id, name })),
    [
      { id: "local-work-id", name: "Work" },
      { id: "my-custom", name: "Personal" },
      { id: "preset-cook", name: "cook" },
    ],
  );
  assert.ok(
    readdirSync(join(root, "userdata")).some((name) => name.startsWith("settings.json.bak.")),
  );
});

test("repeat application is byte-stable and creates no second backup", (t) => {
  const { root, settingsPath } = makeHome({ providerInstances: {}, subagentPresets: [] });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(run(root, bundledProfile, true).status, 0);
  const first = readFileSync(settingsPath, "utf8");
  const backups = readdirSync(join(root, "userdata")).filter((name) =>
    name.startsWith("settings.json.bak."),
  );
  assert.equal(run(root, bundledProfile, true).status, 0);
  assert.equal(readFileSync(settingsPath, "utf8"), first);
  assert.equal(
    readdirSync(join(root, "userdata")).filter((name) => name.startsWith("settings.json.bak."))
      .length,
    backups.length,
  );
});

test("rejects malformed profiles before changing settings or creating a backup", (t) => {
  const { root, settingsPath } = makeHome({ untouched: true });
  const profilePath = join(root, "bad-profile.json");
  const profile = JSON.parse(readFileSync(bundledProfile, "utf8"));
  profile.providerInstances[0].endpoint = "https://private.example";
  writeFileSync(profilePath, JSON.stringify(profile));
  const before = readFileSync(settingsPath, "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, profilePath, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported field/);
  assert.equal(readFileSync(settingsPath, "utf8"), before);
  assert.deepEqual(readdirSync(join(root, "userdata")), ["settings.json"]);
});

test("previews a fresh T3 home without writing, then creates settings on apply", (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3-agent-profile-fresh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const preview = run(root, bundledProfile, false);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(existsSync(join(root, "userdata")), false);
  const applied = run(root, bundledProfile, true);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Created settings:/);
  assert.doesNotMatch(applied.stdout, /Backup:/);
  const settings = JSON.parse(readFileSync(join(root, "userdata", "settings.json"), "utf8"));
  assert.ok(
    Object.values(settings.providerInstances).every((instance) => instance.enabled === false),
  );
  assert.equal(readdirSync(join(root, "userdata")).length, 1);
});

test("rejects a provider driver collision without writing settings", (t) => {
  const { root, settingsPath } = makeHome({
    providerInstances: { codex: { driver: "omp", enabled: true } },
  });
  const before = readFileSync(settingsPath, "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, bundledProfile, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /profile expects codex/);
  assert.equal(readFileSync(settingsPath, "utf8"), before);
  assert.deepEqual(readdirSync(join(root, "userdata")), ["settings.json"]);
});

test("rejects symlinked settings without changing its target", (t) => {
  const root = mkdtempSync(join(tmpdir(), "t3-agent-profile-symlink-"));
  const userdata = join(root, "userdata");
  mkdirSync(userdata);
  const targetPath = join(root, "recipient-settings.json");
  const settingsPath = join(userdata, "settings.json");
  const before = '{"keep":true}\n';
  writeFileSync(targetPath, before);
  symlinkSync(targetPath, settingsPath);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, bundledProfile, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlinked settings.json/);
  assert.equal(readFileSync(targetPath, "utf8"), before);
  assert.equal(lstatSync(settingsPath).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(userdata), ["settings.json"]);
});

test("merges nonempty custom models by slug and preserves provider credentials", (t) => {
  const { root, settingsPath } = makeHome({
    providerInstances: {
      codex: {
        driver: "codex",
        enabled: true,
        config: {
          apiKey: "recipient-only",
          customModels: ["local-model", { slug: "shared", name: "Old name" }],
        },
      },
    },
  });
  const profilePath = join(root, "profile-with-models.json");
  const profile = JSON.parse(readFileSync(bundledProfile, "utf8"));
  profile.providerInstances.find((instance) => instance.instanceId === "codex").customModels = [
    { slug: "shared", name: "Portable name" },
    { slug: "new-model", name: "Portable model" },
  ];
  writeFileSync(profilePath, JSON.stringify(profile));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, profilePath, true);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.providerInstances.codex.config.apiKey, "recipient-only");
  assert.deepEqual(settings.providerInstances.codex.config.customModels, [
    "local-model",
    { slug: "shared", name: "Portable name" },
    { slug: "new-model", name: "Portable model" },
  ]);
});

test("does not shadow a locally configured legacy provider with a disabled instance", (t) => {
  const { root, settingsPath } = makeHome({
    providers: {
      opencode: { enabled: true, binaryPath: "/recipient/opencode", apiKey: "recipient-only" },
    },
    providerInstances: {},
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, bundledProfile, true);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(Object.hasOwn(settings.providerInstances, "opencode"), false);
  assert.deepEqual(settings.providers.opencode, {
    enabled: true,
    binaryPath: "/recipient/opencode",
    apiKey: "recipient-only",
  });
});

test("preserves implicit enabled Codex and Claude defaults in existing settings", (t) => {
  const { root, settingsPath } = makeHome({ unrelatedSetting: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, bundledProfile, true);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(Object.hasOwn(settings.providerInstances, "codex"), false);
  assert.equal(Object.hasOwn(settings.providerInstances, "claudeAgent"), false);
  assert.equal(settings.unrelatedSetting, true);
});

test("materializes an implicit Codex instance with custom models and enabled by default", (t) => {
  const { root, settingsPath } = makeHome({ unrelatedSetting: true });
  const profilePath = join(root, "profile-with-models.json");
  const profile = JSON.parse(readFileSync(bundledProfile, "utf8"));
  profile.providerInstances.find((instance) => instance.instanceId === "codex").customModels = [
    "recipient-model",
  ];
  writeFileSync(profilePath, JSON.stringify(profile));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, profilePath, true);
  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.providerInstances.codex.enabled, true);
  assert.deepEqual(settings.providerInstances.codex.config.customModels, ["recipient-model"]);
});
