import {
  DesktopEnvironmentRecoveryRecipeSchema,
  DesktopEnvironmentRecoveryStateSchema,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { DesktopEnvironmentRecovery } from "../../recovery/DesktopEnvironmentRecovery.ts";
import * as Channels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getEnvironmentRecovery = makeIpcMethod({
  channel: Channels.GET_ENVIRONMENT_RECOVERY_CHANNEL,
  payload: Schema.Array(EnvironmentId),
  result: Schema.Array(DesktopEnvironmentRecoveryStateSchema),
  handler: (connected) =>
    Effect.flatMap(DesktopEnvironmentRecovery, (recovery) => recovery.get(connected)),
});
export const setEnvironmentRecovery = makeIpcMethod({
  channel: Channels.SET_ENVIRONMENT_RECOVERY_CHANNEL,
  payload: Schema.Struct({
    environmentId: EnvironmentId,
    recipe: Schema.NullOr(DesktopEnvironmentRecoveryRecipeSchema),
  }),
  result: DesktopEnvironmentRecoveryStateSchema,
  handler: (input) =>
    Effect.flatMap(DesktopEnvironmentRecovery, (recovery) =>
      recovery.set(input.environmentId, input.recipe),
    ),
});
export const runEnvironmentRecovery = makeIpcMethod({
  channel: Channels.RUN_ENVIRONMENT_RECOVERY_CHANNEL,
  payload: Schema.Struct({
    environmentId: EnvironmentId,
    reason: Schema.Literals(["automatic", "manual"]),
  }),
  result: DesktopEnvironmentRecoveryStateSchema,
  handler: (input) =>
    Effect.flatMap(DesktopEnvironmentRecovery, (recovery) =>
      recovery.run(input.environmentId, input.reason),
    ),
});
export const cancelEnvironmentRecovery = makeIpcMethod({
  channel: Channels.CANCEL_ENVIRONMENT_RECOVERY_CHANNEL,
  payload: EnvironmentId,
  result: DesktopEnvironmentRecoveryStateSchema,
  handler: (id) => Effect.flatMap(DesktopEnvironmentRecovery, (recovery) => recovery.cancel(id)),
});
