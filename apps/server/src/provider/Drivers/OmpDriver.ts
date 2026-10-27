import { ompUsageReader } from "@t3tools/provider-pi/server/usage";
/** omp uses its native RPC goal loop by default; ACP remains an opt-in transport. */
import { OmpSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";

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

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv, Path.Path> = {
  driverKind: OMP_DRIVER_KIND,
  usage: ompUsageReader,
  metadata: {
    displayName: "oh-my-pi",
    supportsMultipleInstances: true,
    hasDefaultInstance: false,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: (input) => {
    const operation = Effect.fn("OmpDriver.create")(function* () {
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
    });
    return operation();
  },
};
