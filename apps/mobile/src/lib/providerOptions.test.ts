import { describe, expect, it } from "vite-plus/test";
import type { ModelCapabilities } from "@t3tools/contracts";

import { applyProviderOptionSelection, resolveProviderOptionDescriptors } from "./providerOptions";

describe("mobile server-owned provider options", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "opaque-thinking",
        label: "Server Thinking",
        type: "select",
        options: [
          { id: "server/default", label: "Default", isDefault: true },
          { id: "server/custom", label: "Custom" },
        ],
        currentValue: "server/default",
      },
      { id: "opaque-toggle", label: "Server Toggle", type: "boolean", currentValue: true },
    ],
  };

  it("keeps an explicit false while changing a server-defined select option", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities,
      selections: [{ id: "opaque-toggle", value: false }],
    });
    expect(
      applyProviderOptionSelection(descriptors, {
        id: "opaque-thinking",
        value: "server/custom",
      }),
    ).toEqual([
      { id: "opaque-thinking", value: "server/custom" },
      { id: "opaque-toggle", value: false },
    ]);
    expect(
      applyProviderOptionSelection(descriptors, {
        id: "opaque-toggle",
        value: false,
      }),
    ).toEqual([
      { id: "opaque-thinking", value: "server/default" },
      { id: "opaque-toggle", value: false },
    ]);
    expect(capabilities.optionDescriptors?.[1]?.currentValue).toBe(true);
  });

  it("rejects options and values not advertised by the server", () => {
    const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: [] });
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: false })).toBeNull();
    expect(
      applyProviderOptionSelection(descriptors, {
        id: "opaque-thinking",
        value: "client-invented",
      }),
    ).toBeNull();
    expect(
      applyProviderOptionSelection(descriptors, {
        id: "opaque-toggle",
        value: "false",
      }),
    ).toBeNull();
    expect(resolveProviderOptionDescriptors({ capabilities: null, selections: [] })).toEqual([]);
  });
});
