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

export const VoiceRecordingId = Schema.String.check(Schema.isTrimmed()).check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
);
export type VoiceRecordingId = typeof VoiceRecordingId.Type;

export const VoiceRecordingStatus = Schema.Literals(["ok", "error"]);
export type VoiceRecordingStatus = typeof VoiceRecordingStatus.Type;

export const VoiceRecordingMetadata = Schema.Struct({
  id: VoiceRecordingId,
  /** ISO-8601 creation time. */
  createdAt: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  status: VoiceRecordingStatus,
  /** Transcription attempts made (1 when the first attempt succeeded). */
  attempts: Schema.Int,
  error: Schema.NullOr(Schema.String),
  transcript: Schema.NullOr(Schema.String),
});
export type VoiceRecordingMetadata = typeof VoiceRecordingMetadata.Type;

export const VoiceRecordingAudio = Schema.Struct({
  audioBase64: Schema.String,
  mimeType: Schema.String,
});
export type VoiceRecordingAudio = typeof VoiceRecordingAudio.Type;
