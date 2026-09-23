import {
  DesktopDevboxActionSchema,
  DesktopDevboxStateOptionsSchema,
  DesktopDevboxStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopDevbox from "../../devbox/DesktopDevbox.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getDevboxState = makeIpcMethod({
  channel: IpcChannels.GET_DEVBOX_STATE_CHANNEL,
  payload: DesktopDevboxStateOptionsSchema,
  result: DesktopDevboxStateSchema,
  handler: Effect.fn("desktop.ipc.devbox.getState")(function* (options) {
    const devbox = yield* DesktopDevbox.DesktopDevbox;
    return yield* devbox.getState(options);
  }),
});

export const runDevboxAction = makeIpcMethod({
  channel: IpcChannels.RUN_DEVBOX_ACTION_CHANNEL,
  payload: DesktopDevboxActionSchema,
  result: DesktopDevboxStateSchema,
  handler: Effect.fn("desktop.ipc.devbox.run")(function* (action) {
    const devbox = yield* DesktopDevbox.DesktopDevbox;
    return yield* devbox.run(action);
  }),
});
