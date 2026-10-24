import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";
import { applyPreferredCodexDefaultModel, mapCodexModelCapabilities } from "./CodexProvider.ts";

it("defaults to standard routing even when the catalog recommends another tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it.each([
  ["gpt-6.1-sol", ["low", "medium", "high", "max", "ultra"], "medium"],
  ["openai.gpt-6.1-sol", ["low", "medium", "high"], "medium"],
  ["gpt-6-luna", ["max", "medium", "low", "xhigh", "high"], "max"],
  ["openai.gpt-6-luna", ["low", "medium", "high"], "high"],
] as const)("uses the preferred supported effort for %s", (model, efforts, expected) => {
  const caps = mapCodexModelCapabilities({
    id: model,
    model,
    displayName: model,
    description: "",
    hidden: false,
    isDefault: false,
    additionalSpeedTiers: [],
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: "",
    })),
  });
  const effort = caps.optionDescriptors?.find((descriptor) => descriptor.id === "reasoningEffort");
  assert.equal(effort?.currentValue, expected);
  assert.deepStrictEqual(
    effort?.type === "select"
      ? effort.options.filter((option) => option.isDefault).map((option) => option.id)
      : [],
    [expected],
  );
});

it.each([
  { options: undefined, expected: "default" },
  { options: [], expected: "default" },
  { options: [{ id: "fastMode", value: false }], expected: "default" },
  { options: [{ id: "fastMode", value: true }], expected: "fast" },
  { options: [{ id: "serviceTier", value: "priority" }], expected: "priority" },
])("dispatches $expected routing while preserving explicit choices", ({ options, expected }) => {
  assert.equal(
    getCodexServiceTierOptionValue({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-sol",
      ...(options ? { options } : {}),
    }),
    expected,
  );
});
