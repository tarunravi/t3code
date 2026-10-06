import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopKeepAwake from "../../app/DesktopKeepAwake.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getKeepAwakeEnabled = makeSyncIpcMethod({
  channel: IpcChannels.GET_KEEP_AWAKE_ENABLED_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.keepAwake.getEnabled")(function* () {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    return (yield* appSettings.get).keepAwakeEnabled;
  }),
});

export const setKeepAwakeEnabled = makeIpcMethod({
  channel: IpcChannels.SET_KEEP_AWAKE_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.keepAwake.setEnabled")(function* (enabled) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;
    yield* appSettings.setKeepAwakeEnabled(enabled);
    yield* keepAwake.setEnabled(enabled);
  }),
});
