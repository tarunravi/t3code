import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ServerProviderModel } from "@t3tools/contracts";
import { cursorContextWindowTokens, cursorSdkModelSelection } from "./sdkModel.ts";

const grok: ServerProviderModel = {
  slug: "grok-4.7",
  name: "Grok 4.7",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "contextWindow",
        label: "Context",
        type: "select",
        options: [{ id: "500k", label: "500k", isDefault: true }],
      },
    ],
  },
};

describe("Cursor Grok context compatibility", () => {
  it("budgets the catalog default while omitting the rejected explicit SDK parameter", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("cursor"),
      model: "grok-4.7",
    };
    expect(cursorContextWindowTokens(selection, [grok])).toBe(500_000);
    expect(cursorSdkModelSelection(selection)).toEqual({ id: "grok-4.7" });
    const explicit = { ...selection, options: [{ id: "contextWindow", value: "500k" }] };
    expect(cursorContextWindowTokens(explicit, [grok])).toBe(500_000);
    expect(cursorSdkModelSelection(explicit)).toEqual({ id: "grok-4.7" });
  });
});
