import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { delegateTaskCorrection } from "./delegateTaskCorrection.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const zcode = ProviderInstanceId.make("zcode");

const provider = (instanceId: ProviderInstanceId, models: ReadonlyArray<string>) => ({
  providerInstanceId: instanceId,
  driverKind: ProviderDriverKind.make(instanceId),
  displayName: null,
  models: models.map((id) => ({ id, label: null })),
  canRunChildTask: true,
  canRunCrossProviderChildTask: true,
  constraints: [],
});

describe("delegateTaskCorrection", () => {
  it("lists roster descriptions and uses the first available target and options", () => {
    const text = delegateTaskCorrection({
      inheritedProviderInstanceId: claude,
      inheritedModel: "claude-opus-5-5",
      providers: [
        {
          ...provider(claude, ["claude-opus-5-5"]),
          models: [
            {
              id: "claude-opus-5-5",
              label: null,
              options: [
                {
                  id: "effort",
                  label: "Effort",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            },
          ],
        },
        provider(zcode, ["default"]),
      ],
      threadRoster: {
        guidance: "",
        entries: [
          {
            target: { providerInstanceId: zcode, model: "default" },
            label: null,
            description: "Long unattended runs.",
            available: false,
          },
          {
            target: {
              providerInstanceId: claude,
              model: "claude-opus-5-5",
              options: [{ id: "effort", value: "medium" }],
            },
            label: null,
            description: "Everyday implementation.",
            available: true,
          },
        ],
      },
    });
    assert.include(text, "- zcode / default [unavailable] — Long unattended runs.");
    assert.include(
      text,
      "- claudeAgent / claude-opus-5-5 (options: effort=low|medium|high) — Everyday implementation.",
    );
    assert.include(
      text,
      'Example: {"task":"...","target":{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","options":{"effort":"medium"}},"mode":"async"}',
    );
  });

  it("skips providers that cannot run a subagent", () => {
    const text = delegateTaskCorrection({
      inheritedProviderInstanceId: claude,
      inheritedModel: "claude-opus-5-5",
      providers: [
        { ...provider(claude, ["claude-opus-5-5"]), canRunChildTask: false },
        provider(zcode, ["default"]),
      ],
    });
    assert.notInclude(text, "- claudeAgent:");
    assert.include(text, '"target":{"providerInstanceId":"zcode","model":"default"}');
  });

  it("does not suggest a provider outside an empty or unavailable roster", () => {
    const text = delegateTaskCorrection({
      inheritedProviderInstanceId: claude,
      inheritedModel: "claude-opus-5-5",
      providers: [provider(claude, ["claude-opus-5-5"])],
      threadRoster: { guidance: "", entries: [] },
    });
    assert.include(text, "With a thread roster, omitting target uses its first matching entry");
    assert.include(text, "No available thread-roster target can run this task");
    assert.notInclude(text, "Example:");
    assert.notInclude(text, '"providerInstanceId":"claudeAgent"');
    assert.notInclude(text, "Available targets (providerInstanceId:");
  });
});
