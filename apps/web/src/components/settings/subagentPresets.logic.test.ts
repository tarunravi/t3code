import {
  ProviderInstanceId,
  type SubagentPreset,
  type SubagentPresetEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyPresetEntryDescription,
  applyPresetEntryRole,
  createPreset,
  mergePresetDescriptions,
  presetEntryAsRosterEntry,
  removePreset,
  renamePreset,
} from "./subagentPresets.logic";

const OPUS: SubagentPresetEntry = {
  selection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  role: "hard",
  description: "Tricky bugs.",
};
const GLM: SubagentPresetEntry = {
  selection: { instanceId: ProviderInstanceId.make("zcode"), model: "default" },
  description: "Overnight runs.",
};
const PRESET: SubagentPreset = { id: "hard", name: "Hard work", entries: [OPUS, GLM] };

describe("subagent preset helpers", () => {
  it("strips descriptions when converting entries to roster entries", () => {
    expect(presetEntryAsRosterEntry(OPUS)).toEqual({
      selection: OPUS.selection,
      role: "hard",
    });
  });

  it("re-attaches descriptions to entries the roster helpers returned", () => {
    const next = mergePresetDescriptions(PRESET.entries, [
      presetEntryAsRosterEntry(GLM),
      { selection: OPUS.selection, role: "hard" },
    ]);
    expect(next).toEqual([GLM, OPUS]);
  });

  it("adds presets with unique names", () => {
    expect(createPreset([], "a")).toEqual([{ id: "a", name: "New preset", entries: [] }]);
    const second = createPreset([{ id: "a", name: "New preset", entries: [] }], "b");
    expect(second[1]?.name).toBe("New preset 2");
  });

  it("renames presets and ignores blank names", () => {
    const [renamed] = renamePreset([PRESET], "hard", "  Overnight  ");
    expect(renamed?.name).toBe("Overnight");
    expect(renamePreset([PRESET], "hard", "   ")).toEqual([PRESET]);
  });

  it("removes a preset by id", () => {
    expect(removePreset([PRESET], "hard")).toEqual([]);
    expect(removePreset([PRESET], "other")).toEqual([PRESET]);
  });

  it("names one role at a time within a preset", () => {
    const both: SubagentPreset = {
      id: "both",
      name: "Both",
      entries: [OPUS, { ...GLM, role: "hard" }],
    };
    const reassigned = applyPresetEntryRole(both, 1, "hard");
    expect(reassigned.entries[0]?.role).toBeUndefined();
    expect(reassigned.entries[1]?.role).toBe("hard");

    const cleared = applyPresetEntryRole(reassigned, 1, null);
    expect(cleared.entries[1]?.role).toBeUndefined();
    expect(cleared.entries[1]?.description).toBe("Overnight runs.");
  });

  it("keeps a role on entries the assignment did not touch", () => {
    const reassigned = applyPresetEntryRole(PRESET, 1, "overnight");
    expect(reassigned.entries[0]?.role).toBe("hard");
    expect(reassigned.entries[1]?.role).toBe("overnight");
  });

  it("keeps descriptions when clearing a role", () => {
    const withoutRole = applyPresetEntryRole(PRESET, 0, null);
    expect(withoutRole.entries[0]).toEqual({
      selection: OPUS.selection,
      description: "Tricky bugs.",
    });
  });

  it("sets, trims, and clears entry descriptions", () => {
    const written = applyPresetEntryDescription(PRESET, 0, "  Design work.  ");
    expect(written.entries[0]?.description).toBe("Design work.");

    const cleared = applyPresetEntryDescription(written, 0, "   ");
    expect(cleared.entries[0]?.description).toBeUndefined();
  });
});
