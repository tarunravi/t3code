import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { DshSettings } from "./settings.ts";

export const dshClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("dsh"),
  label: "DeepSeek Harness",
  settingsSchema: DshSettings,
  hasDefaultInstance: false,
  environmentFields: [
    {
      name: "DSH_HOME",
      label: "Harness home",
      description: "Optional isolated profile and session directory.",
    },
  ],
});
