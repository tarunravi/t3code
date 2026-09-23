import {
  DesktopAwsProfileSchema,
  DesktopDevboxActionSchema,
  DesktopDevboxEnableInputSchema,
  DesktopDevboxLoginStartSchema,
  DesktopDevboxStateOptionsSchema,
  DesktopDevboxStateSchema,
  DesktopSignInAwsProfileInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

export const listAwsProfiles = makeIpcMethod({
  channel: IpcChannels.LIST_AWS_PROFILES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopAwsProfileSchema),
  handler: Effect.fn("desktop.ipc.devbox.listAwsProfiles")(function* () {
    const devbox = yield* DesktopDevbox.DesktopDevbox;
    return yield* devbox.listAwsProfiles;
  }),
});

export const setDevboxEnabled = makeIpcMethod({
  channel: IpcChannels.SET_DEVBOX_ENABLED_CHANNEL,
  payload: DesktopDevboxEnableInputSchema,
  result: DesktopDevboxStateSchema,
  handler: Effect.fn("desktop.ipc.devbox.setEnabled")(function* (input) {
    const devbox = yield* DesktopDevbox.DesktopDevbox;
    return yield* devbox.setEnabled(input);
  }),
});

export const startDevboxLogin = makeIpcMethod({
  channel: IpcChannels.START_DEVBOX_LOGIN_CHANNEL,
  payload: DesktopDevboxLoginStartSchema,
  result: DesktopDevboxStateSchema,
  handler: Effect.fn("desktop.ipc.devbox.startLogin")(function* (input) {
    const devbox = yield* DesktopDevbox.DesktopDevbox;
    return yield* devbox.startLogin(input);
  }),
});

export const setSignInAwsProfile = makeIpcMethod({
  channel: IpcChannels.SET_SIGN_IN_AWS_PROFILE_CHANNEL,
  payload: DesktopSignInAwsProfileInputSchema,
  result: DesktopDevboxStateSchema,
  handler: Effect.fn("desktop.ipc.devbox.setSignInAwsProfile")(function* (input) {
    const devbox = yield* DesktopDevbox.DesktopDevbox;
    return yield* devbox.setSignInAwsProfile(input);
  }),
});
