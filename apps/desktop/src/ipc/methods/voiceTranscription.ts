import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import {
  VoiceRecordingAudio,
  VoiceRecordingId,
  VoiceRecordingMetadata,
  VoiceTranscribeInput,
  VoiceTranscribeResult,
} from "@t3tools/contracts";

import * as TranscribeWithRetry from "../../voice/transcribeWithRetry.ts";
import * as VoiceRecordingStore from "../../voice/voiceRecordingStore.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  DELETE_VOICE_RECORDING_CHANNEL,
  LIST_VOICE_RECORDINGS_CHANNEL,
  READ_VOICE_RECORDING_CHANNEL,
  RETRY_VOICE_RECORDING_CHANNEL,
  TRANSCRIBE_VOICE_CHANNEL,
} from "../channels.ts";

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    message: Schema.String,
  },
) {}

export class VoiceRecordingError extends Schema.TaggedError<VoiceRecordingError>()(
  "VoiceRecordingError",
  {
    message: Schema.String,
  },
) {}

const RECORDING_NOT_FOUND_MESSAGE = "Recording not found. It may have been deleted.";

function recordingsDir(): string {
  return VoiceRecordingStore.voiceRecordingsDir(Electron.app.getPath("userData"));
}

function fetchWithChromiumNetwork(
  url: string,
  init: { method: string; headers: Record<string, string>; body: FormData },
): Promise<TranscribeWithRetry.TranscribeFetchResponse> {
  return Electron.net.fetch(url, init);
}

export const transcribeVoice = DesktopIpc.makeIpcMethod({
  channel: TRANSCRIBE_VOICE_CHANNEL,
  payload: VoiceTranscribeInput,
  result: VoiceTranscribeResult,
  handler: (input) =>
    Effect.tryPromise({
      try: async () => {
        const outcome = await TranscribeWithRetry.transcribeWithRetry(input, {
          fetchImpl: fetchWithChromiumNetwork,
        });
        try {
          VoiceRecordingStore.saveVoiceRecording(recordingsDir(), {
            mimeType: input.mimeType,
            audio: Buffer.from(input.audioBase64, "base64"),
            status: outcome.ok ? "ok" : "error",
            attempts: outcome.attempts,
            error: outcome.ok ? null : outcome.error.message,
            transcript: outcome.ok ? outcome.text : null,
          });
        } catch {
          // Persistence must never fail transcription.
        }
        if (!outcome.ok) throw outcome.error;
        return { text: outcome.text };
      },
      catch: (error) =>
        new VoiceTranscriptionError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
});

export const listVoiceRecordings = DesktopIpc.makeIpcMethod({
  channel: LIST_VOICE_RECORDINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(VoiceRecordingMetadata),
  handler: () =>
    Effect.tryPromise({
      try: () => Promise.resolve(VoiceRecordingStore.listVoiceRecordings(recordingsDir())),
      catch: (error) =>
        new VoiceRecordingError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
});

export const readVoiceRecording = DesktopIpc.makeIpcMethod({
  channel: READ_VOICE_RECORDING_CHANNEL,
  payload: VoiceRecordingId,
  result: VoiceRecordingAudio,
  handler: (id) =>
    Effect.tryPromise({
      try: () => {
        const found = VoiceRecordingStore.readVoiceRecording(recordingsDir(), id);
        if (!found) throw new Error(RECORDING_NOT_FOUND_MESSAGE);
        return Promise.resolve({
          audioBase64: found.audio.toString("base64"),
          mimeType: found.metadata.mimeType,
        });
      },
      catch: (error) =>
        new VoiceRecordingError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
});

export const retryVoiceRecording = DesktopIpc.makeIpcMethod({
  channel: RETRY_VOICE_RECORDING_CHANNEL,
  payload: VoiceRecordingId,
  result: VoiceRecordingMetadata,
  handler: (id) =>
    Effect.tryPromise({
      try: async () => {
        const dir = recordingsDir();
        const found = VoiceRecordingStore.readVoiceRecording(dir, id);
        if (!found) throw new Error(RECORDING_NOT_FOUND_MESSAGE);
        const outcome = await TranscribeWithRetry.transcribeWithRetry(
          {
            audioBase64: found.audio.toString("base64"),
            mimeType: found.metadata.mimeType,
          },
          { fetchImpl: fetchWithChromiumNetwork },
        );
        const updated = VoiceRecordingStore.updateVoiceRecording(dir, id, {
          status: outcome.ok ? "ok" : "error",
          attempts: outcome.attempts,
          error: outcome.ok ? null : outcome.error.message,
          transcript: outcome.ok ? outcome.text : null,
        });
        if (!updated) throw new Error(RECORDING_NOT_FOUND_MESSAGE);
        return updated;
      },
      catch: (error) =>
        new VoiceRecordingError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
});

export const deleteVoiceRecording = DesktopIpc.makeIpcMethod({
  channel: DELETE_VOICE_RECORDING_CHANNEL,
  payload: VoiceRecordingId,
  result: Schema.Void,
  handler: (id) =>
    Effect.tryPromise({
      try: () => {
        if (!VoiceRecordingStore.deleteVoiceRecording(recordingsDir(), id)) {
          throw new Error(RECORDING_NOT_FOUND_MESSAGE);
        }
        return Promise.resolve(undefined);
      },
      catch: (error) =>
        new VoiceRecordingError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
});
