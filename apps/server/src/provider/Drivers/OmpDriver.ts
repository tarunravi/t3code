/**
 * OmpDriver — `ProviderDriver` for oh-my-pi. The instance is built on the ACP
 * Registry driver's local-command path (`omp acp`): discovery publishes omp's
 * model and thinking config options, and text generation runs `omp -p`.
 *
 * Sessions run over omp's RPC mode by default, through the Pi adapter with
 * omp's flavor. RPC shows turns omp starts on its own (background job and
 * timer wakes), queues prompts sent while omp is busy, and runs `/goal` on
 * omp's own goal loop when the omp build supports it. The `acp` transport
 * keeps the ACP runtime, with T3-tracked goals and omp's plan mode.
 */
import { OmpSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import {
  OMP_DRIVER_KIND,
  OMP_GOAL_SLASH_COMMAND,
  ompAcpRegistrySettings,
  ompPromptTurnTokenUsage,
} from "../acp/OmpAcpSupport.ts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeAcpRegistryProviderInstance,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import {
  makePiFamilyAdapter,
  OMP_RPC_FLAVOR,
  type PiAdapterV2DriverEnv,
} from "@t3tools/provider-pi/server";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

export type OmpDriverEnv = AcpRegistryDriverEnv | PiAdapterV2DriverEnv;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: OMP_DRIVER_KIND,
  metadata: {
    displayName: "oh-my-pi",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const settings = { ...input.config, enabled: input.enabled } satisfies OmpSettings;
      const textGeneration = yield* makeOmpTextGeneration(
        settings,
        yield* mergeProviderInstanceEnvironment(input.environment, yield* HostProcess.Environment),
      );
      const instance = yield* makeAcpRegistryProviderInstance({
        driverKind: OMP_DRIVER_KIND,
        flavorOverrides: {
          runtimeHarness: "oh-my-pi",
          promptTurnTokenUsage: ompPromptTurnTokenUsage,
          tracksGoalsLocally: true,
          retryPromptWhileSessionBusy: true,
        },
        slashCommands: [OMP_GOAL_SLASH_COMMAND],
        textGeneration,
      })({ ...input, config: ompAcpRegistrySettings(settings) });
      if (settings.transport === "acp") return instance;
      const orchestrationAdapter = yield* makePiFamilyAdapter(input, OMP_RPC_FLAVOR).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: OMP_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to build the oh-my-pi RPC adapter.",
              cause,
            }),
        ),
      );
      return { ...instance, orchestrationAdapter };
    }),
};
