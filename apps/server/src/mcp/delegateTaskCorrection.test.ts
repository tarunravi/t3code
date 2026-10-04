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
  it("lists allowed targets and uses the inherited model as the example", () => {
    const text = delegateTaskCorrection({
      inheritedProviderInstanceId: claude,
      inheritedModel: "claude-opus-5-5",
      providers: [provider(zcode, ["default"]), provider(claude, ["claude-opus-5-5"])],
    });
    assert.include(text, "- zcode: default");
    assert.include(text, "- claudeAgent: claude-opus-5-5");
    assert.include(text, '"target":{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5"}');
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
