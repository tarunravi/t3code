/**
 * OmpDriver — `ProviderDriver` for oh-my-pi. omp speaks ACP (`omp acp`), so
 * the instance runs through the ACP Registry driver's local-command path:
 * discovery publishes omp's model and thinking config options, and the ACP
 * runtime streams text, reasoning, and tool calls. omp adds turn token usage
 * from its prompt results and text generation through `omp -p`.
 */
import { OmpSettings } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import {
  OMP_DRIVER_KIND,
  ompAcpRegistrySettings,
  ompPromptTurnTokenUsage,
} from "../acp/OmpAcpSupport.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeAcpRegistryProviderInstance, type AcpRegistryDriverEnv } from "./AcpRegistryDriver.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

export type OmpDriverEnv = AcpRegistryDriverEnv;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: OMP_DRIVER_KIND,
  metadata: {
    displayName: "oh-my-pi",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const settings = { ...input.config, enabled: input.enabled } satisfies OmpSettings;
      const textGeneration = yield* makeOmpTextGeneration(
        settings,
        mergeProviderInstanceEnvironment(input.environment, yield* HostProcessEnvironment),
      );
      return yield* makeAcpRegistryProviderInstance({
        driverKind: OMP_DRIVER_KIND,
        flavorOverrides: {
          runtimeHarness: "oh-my-pi",
          promptTurnTokenUsage: ompPromptTurnTokenUsage,
        },
        textGeneration,
      })({ ...input, config: ompAcpRegistrySettings(settings) });
    }),
};
