import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { VoiceRecordingAudio, VoiceRecordingMetadata } from "./voice.ts";

const decodeMetadata = Schema.decodeUnknownSync(VoiceRecordingMetadata);
const decodeAudio = Schema.decodeUnknownSync(VoiceRecordingAudio);

describe("VoiceRecordingMetadata", () => {
  it("decodes a saved recording sidecar", () => {
    expect(
      decodeMetadata({
        id: "4f1e2b9e-0c2a-4d1e-9f3a-7c8b9d0e1f2a",
        createdAt: "2026-09-20T20:00:00.000Z",
        mimeType: "audio/webm;codecs=opus",
        sizeBytes: 12345,
        status: "error",
        attempts: 3,
        error: "Transcription failed (503).",
        transcript: null,
      }),
    ).toMatchObject({ status: "error", attempts: 3 });
  });

  it("rejects unknown statuses", () => {
    expect(() =>
      decodeMetadata({
        id: "abc",
        createdAt: "2026-09-20T20:00:00.000Z",
        mimeType: "audio/webm",
        sizeBytes: 1,
        status: "pending",
        attempts: 1,
        error: null,
        transcript: null,
      }),
    ).toThrow();
  });
});

describe("VoiceRecordingAudio", () => {
  it("decodes playback payloads", () => {
    expect(decodeAudio({ audioBase64: "aGVsbG8=", mimeType: "audio/webm" })).toEqual({
      audioBase64: "aGVsbG8=",
      mimeType: "audio/webm",
    });
  });
});
