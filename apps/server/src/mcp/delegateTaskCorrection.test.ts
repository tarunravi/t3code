import {
  type OrchestratorMcpProviderCapability,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { delegateTaskCorrection } from "./delegateTaskCorrection.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const zcode = ProviderInstanceId.make("zcode");

const provider = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<string>,
): OrchestratorMcpProviderCapability => ({
  providerInstanceId: instanceId,
  driverKind: ProviderDriverKind.make(instanceId),
  displayName: null,
  models: models.map((id) => ({ id })),
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

// Capability options are the wire shape, not UI ProviderOptionDescriptors.
it("uses only advertised string/boolean values and prefers a valid default", () => {
  for (const [values, defaultValue, expected] of [
    [["low", "high"], "high", "high"],
    [[false, true], false, false],
    [[false, true], true, true],
    [["low", "high"], undefined, "low"],
    [["low", "high"], "unlisted", "low"],
    [[true], undefined, true],
  ] as const) {
    const text = delegateTaskCorrection({
      inheritedProviderInstanceId: claude,
      inheritedModel: "model",
      providers: [
        {
          ...provider(claude, []),
          models: [
            {
              id: "model",
              options: [
                {
                  id: "option",
                  values,
                  ...(defaultValue === undefined ? {} : { default: defaultValue }),
                },
              ],
            },
          ],
        },
      ],
    });
    assert.include(text, `option=${values.join("|")}`);
    assert.deepEqual(JSON.parse(text.split("Example: ")[1]!).target.options, { option: expected });
    assert.notInclude(text, "unlisted");
  }
});

it("omits empty options and never echoes unrelated capability data", () => {
  const text = delegateTaskCorrection({
    inheritedProviderInstanceId: claude,
    inheritedModel: "model",
    providers: [
      {
        ...provider(claude, []),
        displayName: "not-for-help",
        constraints: ["not-for-help"],
        models: [{ id: "model", label: "not-for-help", options: [{ id: "empty", values: [] }] }],
      },
    ],
  });
  assert.notProperty(JSON.parse(text.split("Example: ")[1]!).target, "options");
  assert.notInclude(text, "not-for-help");
});
