import { ProviderDriverKind } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import {
  makeAcpRegistryProviderInstance,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Schema from "effect/Schema";
import { DshSettings } from "./settings.ts";

export const DSH_DRIVER_KIND = ProviderDriverKind.make("dsh");
export type DshDriverEnv = AcpRegistryDriverEnv;
const decodeSettings = Schema.decodeSync(DshSettings);
const decodeAcpSettings = Schema.decodeSync(AcpRegistrySettings);

export function dshAcpSettings(settings: DshSettings): AcpRegistrySettings {
  return decodeAcpSettings({
    source: "local",
    enabled: settings.enabled,
    commandPath: settings.binaryPath || "dsh",
    commandArgs: ["--profile", "acp", ...tokenizeCliArgs(settings.launchArgs)],
    customModels: readCustomModelEntries(settings.customModels).map((entry) => entry.slug),
  });
}

export const DshDriver: ProviderDriver<DshSettings, DshDriverEnv> = {
  driverKind: DSH_DRIVER_KIND,
  metadata: {
    displayName: "DeepSeek Harness",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: DshSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    makeAcpRegistryProviderInstance({
      driverKind: DSH_DRIVER_KIND,
      flavorOverrides: { runtimeHarness: "deepseek-harness" },
    })({ ...input, config: dshAcpSettings(input.config) }),
};
