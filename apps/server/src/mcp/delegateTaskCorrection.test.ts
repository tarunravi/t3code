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
  it("lists roster subagents with their descriptions and uses the default entry as the example", () => {
    const text = delegateTaskCorrection({
      inheritedProviderInstanceId: claude,
      inheritedModel: "claude-opus-5-5",
      providers: [provider(claude, ["claude-opus-5-5"]), provider(zcode, ["default"])],
      threadRoster: {
        guidance: "",
        entries: [
          {
            target: { providerInstanceId: zcode, model: "default" },
            label: null,
            role: "overnight",
            description: "Long unattended runs.",
            available: true,
          },
          {
            target: {
              providerInstanceId: claude,
              model: "claude-opus-5-5",
              options: [{ id: "effort", value: "medium" }],
            },
            label: null,
            role: "default",
            description: "Everyday implementation.",
            available: true,
          },
        ],
      },
    });
    assert.include(text, "- zcode / default [overnight] — Long unattended runs.");
    assert.include(text, "- claudeAgent / claude-opus-5-5 [default] — Everyday implementation.");
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
});
