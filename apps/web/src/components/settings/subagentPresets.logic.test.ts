import * as Schema from "effect/Schema";
import {
  ServerSettings,
  ServerSettingsPatch,
  ProviderInstanceId,
  ThreadId,
  type SubagentPreset,
  type SubagentPresetEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  draftSubagentRosterPatch,
  withSubagentDescription,
  applyPresetEntryDescription,
  applyPresetToRoster,
  createPreset,
  findPresetForRoster,
  mergePresetDescriptions,
  presetEntryAsRosterEntry,
  removePreset,
  renamePreset,
} from "./subagentPresets.logic";

const decodeSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

const OPUS: SubagentPresetEntry = {
  selection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-5-5",
    options: [
      { id: "effort", value: "high" },
      { id: "speed", value: "fast" },
    ],
  },
  description: "Tricky bugs.",
};
const GLM: SubagentPresetEntry = {
  selection: { instanceId: ProviderInstanceId.make("zcode"), model: "default" },
  description: "Overnight runs.",
};
const PRESET: SubagentPreset = { id: "hard", name: "Hard work", entries: [OPUS, GLM] };

describe("subagent preset helpers", () => {
  it("targets first-submit and multi-model destination ids while preserving options and notes", () => {
    const first = ThreadId.make("first-submit");
    const second = ThreadId.make("multi-submit");
    const patch = draftSubagentRosterPatch(applyPresetToRoster(PRESET), [first, second]);
    expect(decodeSettingsPatch(patch)).toEqual({
      threadSubagentRosters: {
        [first]: { entries: PRESET.entries },
        [second]: { entries: PRESET.entries },
      },
    });
    expect(draftSubagentRosterPatch(undefined, [first])).toBeNull();
    expect(draftSubagentRosterPatch(null, [first])).toEqual({
      threadSubagentRosters: { [first]: null },
    });
    expect(draftSubagentRosterPatch([], [first])).toEqual({
      threadSubagentRosters: { [first]: { entries: [] } },
    });
  });

  it("edits and clears roster notes while preserving model options", () => {
    const legacy = {
      ...OPUS,
      selection: { ...OPUS.selection, options: [{ id: "effort", value: "medium" }] },
    };
    const edited = withSubagentDescription(legacy, "  New notes.  ");
    expect(edited).toEqual({ ...legacy, description: "New notes." });
    const cleared = withSubagentDescription(edited, "  ");
    expect(cleared).toEqual({ selection: legacy.selection });
    expect(OPUS.description).toBe("Tricky bugs.");
  });

  it("preserves descriptions when converting entries to roster entries", () => {
    expect(presetEntryAsRosterEntry(OPUS)).toEqual({
      selection: OPUS.selection,
      description: "Tricky bugs.",
    });
  });

  it("re-attaches descriptions to entries the roster helpers returned", () => {
    const next = mergePresetDescriptions(PRESET.entries, [
      presetEntryAsRosterEntry(GLM),
      { selection: OPUS.selection },
    ]);
    expect(next).toEqual([GLM, OPUS]);
  });

  it("preserves notes for repeated model/options entries in preference order", () => {
    const duplicate: SubagentPresetEntry = {
      selection: OPUS.selection,
      description: "Verify the result mechanically.",
    };
    const presetEntries = [{ ...OPUS, description: "Investigate the root cause." }, duplicate];
    const next = mergePresetDescriptions(presetEntries, [
      { selection: OPUS.selection },
      { selection: OPUS.selection },
    ]);
    expect(next).toEqual(presetEntries);

    const updatedFirst = mergePresetDescriptions(presetEntries, [
      { selection: OPUS.selection, description: "Check a new failure mode." },
      { selection: OPUS.selection },
    ]);
    expect(updatedFirst).toEqual([
      { ...OPUS, description: "Check a new failure mode." },
      duplicate,
    ]);
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

  it("sets, trims, and clears entry descriptions", () => {
    const written = applyPresetEntryDescription(PRESET, 0, "  Design work.  ");
    expect(written.entries[0]?.description).toBe("Design work.");

    const cleared = applyPresetEntryDescription(written, 0, "   ");
    expect(cleared.entries[0]?.description).toBeUndefined();
  });

  it("copies all preset metadata into a roster", () => {
    expect(applyPresetToRoster(PRESET)).toEqual([OPUS, GLM]);
  });

  it("persists applied descriptions through settings patches and snapshots", () => {
    const patch = {
      threadSubagentRosters: { "thread:preset": { entries: applyPresetToRoster(PRESET) } },
    };
    const decodedPatch = decodeSettingsPatch(patch);
    const persisted = Schema.encodeSync(ServerSettings)(
      Schema.decodeUnknownSync(ServerSettings)(JSON.parse(JSON.stringify(decodedPatch))),
    );
    expect(persisted).toMatchObject(patch);
    expect(decodedPatch.threadSubagentRosters?.[ThreadId.make("thread:preset")]?.entries).toEqual([
      OPUS,
      GLM,
    ]);
  });

  it("finds the preset whose entries match a roster in order", () => {
    expect(findPresetForRoster([PRESET], applyPresetToRoster(PRESET))).toBe(PRESET);
    expect(findPresetForRoster([PRESET], [])).toBeNull();
    expect(findPresetForRoster([PRESET], [{ ...OPUS, description: "Changed" }, GLM])).toBeNull();
  });

  it("rejects rosters that differ from every preset in selection, description, or order", () => {
    const roster = applyPresetToRoster(PRESET);
    expect(findPresetForRoster([PRESET], [...roster].reverse())).toBeNull();
    expect(
      findPresetForRoster(
        [PRESET],
        [roster[0]!, { ...roster[1]!, selection: { ...roster[1]!.selection, model: "other" } }],
      ),
    ).toBeNull();
  });

  it("matches same-selection entries by description and preference order", () => {
    const shared = { selection: OPUS.selection };
    const preset: SubagentPreset = {
      id: "hard",
      name: "Hard",
      entries: [
        { ...shared, description: "Investigate the root cause." },
        { ...shared, description: "Verify the fix mechanically." },
      ],
    };
    expect(
      findPresetForRoster(
        [preset],
        [
          { ...shared, description: "Investigate the root cause." },
          { ...shared, description: "Verify the fix mechanically." },
        ],
      ),
    ).toBe(preset);
    expect(
      findPresetForRoster(
        [preset],
        [
          { ...shared, description: "Verify the fix mechanically." },
          { ...shared, description: "Investigate the root cause." },
        ],
      ),
    ).toBeNull();
  });
});
