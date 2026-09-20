import * as Schema from "effect/Schema";

export const VoiceTranscribeInput = Schema.Struct({
  /**
   * Base64-encoded audio bytes (typically audio/webm;codecs=opus from MediaRecorder).
   */
  audioBase64: Schema.String,
  /**
   * MIME type of the encoded audio, e.g. "audio/webm;codecs=opus".
   */
  mimeType: Schema.String,
  /**
   * Optional BCP-47 language hint for the transcription model.
   */
  language: Schema.optional(Schema.String),
});
export type VoiceTranscribeInput = typeof VoiceTranscribeInput.Type;

export const VoiceTranscribeResult = Schema.Struct({
  text: Schema.String,
});
export type VoiceTranscribeResult = typeof VoiceTranscribeResult.Type;
