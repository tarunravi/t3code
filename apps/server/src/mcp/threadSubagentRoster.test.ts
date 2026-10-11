import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { resolveRosterTarget } from "./threadSubagentRoster.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const zcode = ProviderInstanceId.make("zcode");
const providers = [
  { instanceId: claude, driver: ProviderDriverKind.make("claudeAgent") },
  { instanceId: zcode, driver: ProviderDriverKind.make("zcode") },
];
const roster = {
  entries: [
    {
      selection: {
        instanceId: claude,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "medium" }],
      },
    },
    {
      selection: { instanceId: zcode, model: "default" },
      description: "For long unattended runs.",
    },
  ],
};

describe("resolveRosterTarget", () => {
  it("uses the first matching entry in preference order when no target is specified", () => {
    expect(resolveRosterTarget({ roster, target: undefined, providers })).toEqual(
      Result.succeed({
        providerInstanceId: claude,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "medium" }],
      }),
    );
  });

  it("matches a driver kind and keeps options the agent chose", () => {
    expect(
      resolveRosterTarget({
        roster,
        target: {
          driverKind: ProviderDriverKind.make("claudeAgent"),
          options: [{ id: "effort", value: "high" }],
        },
        providers,
      }),
    ).toEqual(
      Result.succeed({
        providerInstanceId: claude,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      }),
    );
    expect(
      Result.isSuccess(
        resolveRosterTarget({
          roster,
          target: { driverKind: ProviderDriverKind.make("codex") },
          providers,
        }),
      ),
    ).toBe(false);
  });

  it("matches model-specific targets in preference order and preserves configured options", () => {
    const preferred = {
      selection: {
        instanceId: claude,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
      description: "For the hardest work.",
    };
    expect(
      resolveRosterTarget({
        roster: { entries: [preferred, roster.entries[0]!] },
        target: { model: "claude-opus-5-5" },
        providers,
      }),
    ).toEqual(
      Result.succeed({
        providerInstanceId: claude,
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      }),
    );
  });

  it("rejects every target when the roster is empty", () => {
    expect(resolveRosterTarget({ roster: { entries: [] }, target: undefined, providers })).toEqual(
      Result.fail("The user allowed no subagents in this thread."),
    );
  });
});
