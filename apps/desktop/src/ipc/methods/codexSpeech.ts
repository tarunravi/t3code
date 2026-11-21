import {
  DesktopCodexSpeechResultSchema,
  DesktopCodexSpeechTranscribeInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Electron from "electron";
import * as Schema from "effect/Schema";

import * as CodexTranscription from "../../speech/codexTranscription.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const codexSpeechSupported = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CODEX_SPEECH_SUPPORTED_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: () => Effect.sync(CodexTranscription.codexSpeechSupported),
});

export const codexSpeechTranscribe = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CODEX_SPEECH_TRANSCRIBE_CHANNEL,
  payload: DesktopCodexSpeechTranscribeInputSchema,
  result: DesktopCodexSpeechResultSchema,
  handler: Effect.fn("desktop.ipc.codexSpeech.transcribe")(function* (input) {
    // Electron's net.fetch uses Chromium's network stack, which passes the bot
    // mitigation that rejects plain Node fetch on the Codex transcription endpoint.
    return yield* Effect.promise(() =>
      CodexTranscription.transcribeCodexSpeech(input, {
        fetchImpl: (url, init) => Electron.net.fetch(url, init),
      }),
    );
  }),
});
