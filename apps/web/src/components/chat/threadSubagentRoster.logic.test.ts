import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type SubagentRosterEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  appendRosterEntries,
  assignRosterRole,
  moveRosterEntry,
  resolvePreset,
  resolveRosterEntry,
  SUBAGENT_PRESETS,
} from "./threadSubagentRoster.logic";

const effort = {
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
};

function provider(
  driver: string,
  models: ReadonlyArray<{ slug: string; withEffort?: boolean }>,
  enabled = true,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-02T00:00:00.000Z",
    models: models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: false,
      capabilities: model.withEffort ? { optionDescriptors: [effort] } : {},
    })),
    slashCommands: [],
    skills: [],
  };
}

const workPreset = SUBAGENT_PRESETS.find((preset) => preset.id === "work")!;
const personalPreset = SUBAGENT_PRESETS.find((preset) => preset.id === "personal")!;

describe("resolvePreset", () => {
  it("instantiates the work preset with Opus at medium effort and GLM overnight", () => {
    const instances = deriveProviderInstanceEntries([
      provider("claudeAgent", [
        { slug: "claude-haiku-4-5" },
        { slug: "claude-opus-5-5", withEffort: true },
      ]),
      provider("zcode", [{ slug: "default" }]),
    ]);
    expect(resolvePreset(workPreset, instances)).toEqual([
      {
        selection: {
          instanceId: "claudeAgent",
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "medium" }],
        },
        role: "default",
      },
      { selection: { instanceId: "zcode", model: "default" }, role: "overnight" },
    ]);
  });

  it("skips slots no ready provider can serve and falls back to a provider's first model", () => {
    const instances = deriveProviderInstanceEntries([
      provider("codex", [{ slug: "gpt-7" }]),
      provider("antigravity", [{ slug: "gemini-3.8-flash-medium" }], false),
    ]);
    expect(resolvePreset(personalPreset, instances)).toEqual([
      { selection: { instanceId: "codex", model: "gpt-7" }, role: "default" },
    ]);
  });
});

describe("roster edits", () => {
  const opus: SubagentRosterEntry = {
    selection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
    role: "default",
  };
  const glm: SubagentRosterEntry = {
    selection: { instanceId: ProviderInstanceId.make("zcode"), model: "default" },
  };

  it("moves a role instead of duplicating it", () => {
    expect(assignRosterRole([opus, glm], 1, "default")).toEqual([
      { selection: opus.selection },
      { ...glm, role: "default" },
    ]);
  });

  it("appends only new entries and drops a role already taken", () => {
    expect(appendRosterEntries([opus], [{ ...opus }, { ...glm, role: "default" }])).toEqual([
      opus,
      glm,
    ]);
  });

  it("keeps order at the edges", () => {
    expect(moveRosterEntry([opus, glm], 0, -1)).toEqual([opus, glm]);
    expect(moveRosterEntry([opus, glm], 0, 1)).toEqual([glm, opus]);
  });

  it("flags entries a provider can no longer serve", () => {
    const instances = deriveProviderInstanceEntries([provider("claudeAgent", [{ slug: "other" }])]);
    expect(resolveRosterEntry(opus, instances).unavailableReason).toContain("no longer offers");
    expect(resolveRosterEntry(glm, instances).unavailableReason).toContain("not configured");
  });
});
