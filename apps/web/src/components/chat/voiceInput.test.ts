import type { VoiceRecordingMetadata } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { latestVoiceRecordingId, transcribeWithRetry } from "./voiceInput";

const INPUT = { audioBase64: "AAAA", mimeType: "audio/webm" };

function recording(overrides: Partial<VoiceRecordingMetadata>): VoiceRecordingMetadata {
  return {
    id: "rec-1",
    createdAt: "2026-10-04T00:00:00.000Z",
    mimeType: "audio/webm",
    sizeBytes: 4,
    status: "error",
    attempts: 3,
    error: "Transcription failed (500).",
    transcript: null,
    ...overrides,
  };
}

const noSleep = () => Promise.resolve();

describe("transcribeWithRetry", () => {
  it("returns the first successful transcript without retrying", async () => {
    const transcribeVoice = vi.fn().mockResolvedValue({ text: "hello" });
    const retryVoiceRecording = vi.fn();

    await expect(
      transcribeWithRetry(
        INPUT,
        { transcribeVoice, retryVoiceRecording },
        new AbortController().signal,
        noSleep,
      ),
    ).resolves.toBe("hello");
    expect(transcribeVoice).toHaveBeenCalledTimes(1);
    expect(retryVoiceRecording).not.toHaveBeenCalled();
  });

  it("retries the saved recording instead of saving a duplicate", async () => {
    const transcribeVoice = vi.fn().mockRejectedValue(new Error("blocked"));
    const listVoiceRecordings = vi.fn().mockResolvedValue([recording({ id: "rec-new" })]);
    const retryVoiceRecording = vi
      .fn()
      .mockResolvedValueOnce(recording({ id: "rec-new" }))
      .mockResolvedValueOnce(
        recording({ id: "rec-new", status: "ok", error: null, transcript: "recovered" }),
      );
    const sleep = vi.fn(noSleep);

    await expect(
      transcribeWithRetry(
        INPUT,
        { transcribeVoice, listVoiceRecordings, retryVoiceRecording },
        new AbortController().signal,
        sleep,
      ),
    ).resolves.toBe("recovered");
    expect(transcribeVoice).toHaveBeenCalledTimes(1);
    expect(retryVoiceRecording).toHaveBeenCalledTimes(2);
    expect(retryVoiceRecording).toHaveBeenCalledWith("rec-new");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("surfaces the last error after three attempts", async () => {
    const transcribeVoice = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'desktop:transcribe-voice': VoiceTranscriptionError: Transcription failed (500).",
        ),
      );

    await expect(
      transcribeWithRetry(INPUT, { transcribeVoice }, new AbortController().signal, noSleep),
    ).rejects.toMatchObject({
      code: "transcription-failed",
      message: "Transcription failed (500).",
    });
    expect(transcribeVoice).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once cancelled", async () => {
    const abort = new AbortController();
    const transcribeVoice = vi.fn().mockImplementation(() => {
      abort.abort();
      return Promise.reject(new Error("network"));
    });

    await expect(
      transcribeWithRetry(INPUT, { transcribeVoice }, abort.signal, noSleep),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(transcribeVoice).toHaveBeenCalledTimes(1);
  });
});

describe("latestVoiceRecordingId", () => {
  it("returns the newest saved recording, or null when unavailable", async () => {
    await expect(
      latestVoiceRecordingId({
        listVoiceRecordings: () =>
          Promise.resolve([recording({ id: "newest" }), recording({ id: "older" })]),
      }),
    ).resolves.toBe("newest");
    await expect(latestVoiceRecordingId(undefined)).resolves.toBeNull();
    await expect(
      latestVoiceRecordingId({ listVoiceRecordings: () => Promise.reject(new Error("io")) }),
    ).resolves.toBeNull();
  });
});
