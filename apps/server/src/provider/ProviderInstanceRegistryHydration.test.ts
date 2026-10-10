import { describe, expect, it } from "vite-plus/test";
import { ServerSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const settings = Schema.decodeUnknownSync(ServerSettings);

describe("optional fork providers", () => {
  it("does not start ZCode or oh-my-pi without a configured instance", () => {
    const instances = deriveProviderInstanceConfigMap(settings({}));
    expect(
      Object.values(instances).some(({ driver }) => driver === "zcode" || driver === "omp"),
    ).toBe(false);
    expect(instances[ProviderInstanceId.make("codex")]?.driver).toBe("codex");
  });

  it("keeps explicitly configured ZCode and oh-my-pi instances", () => {
    const configured = {
      personal: { driver: "zcode", config: { binaryPath: "zcode-personal" } },
      local: { driver: "omp", config: { binaryPath: "omp-personal" } },
    };
    const instances = deriveProviderInstanceConfigMap(settings({ providerInstances: configured }));
    expect(instances[ProviderInstanceId.make("personal")]).toEqual(configured.personal);
    expect(instances[ProviderInstanceId.make("local")]).toEqual(configured.local);
  });
});
