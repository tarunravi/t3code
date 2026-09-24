import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  deleteVoiceRecording,
  listVoiceRecordings,
  readVoiceRecording,
  saveVoiceRecording,
  updateVoiceRecording,
  VOICE_RECORDINGS_MAX_COUNT,
} from "./voiceRecordingStore.ts";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voice-recordings-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function saveAudio(dir: string, body: string, mimeType = "audio/webm;codecs=opus") {
  return saveVoiceRecording(dir, {
    mimeType,
    audio: Buffer.from(body),
    status: "ok",
    attempts: 1,
    error: null,
    transcript: `transcript ${body}`,
  });
}

describe("voiceRecordingStore", () => {
  it("lists recordings newest first", async () => {
    const dir = makeTempDir();
    const first = saveAudio(dir, "first");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = saveAudio(dir, "second");

    const listed = listVoiceRecordings(dir);

    expect(listed.map((entry) => entry.id)).toEqual([second.id, first.id]);
    expect(listed[0]).toMatchObject({
      mimeType: "audio/webm;codecs=opus",
      sizeBytes: Buffer.from("second").byteLength,
      status: "ok",
      attempts: 1,
      transcript: "transcript second",
    });
  });

  it("evicts the oldest recording (audio + sidecar) past the cap", async () => {
    const dir = makeTempDir();
    const oldest = saveAudio(dir, "oldest");
    for (let index = 1; index < VOICE_RECORDINGS_MAX_COUNT; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      saveAudio(dir, `filler-${index}`);
    }
    expect(listVoiceRecordings(dir)).toHaveLength(VOICE_RECORDINGS_MAX_COUNT);

    await new Promise((resolve) => setTimeout(resolve, 2));
    saveAudio(dir, "newest");

    const listed = listVoiceRecordings(dir);
    expect(listed).toHaveLength(VOICE_RECORDINGS_MAX_COUNT);
    expect(listed.map((entry) => entry.id)).not.toContain(oldest.id);
    expect(NodeFS.readdirSync(dir)).toHaveLength(VOICE_RECORDINGS_MAX_COUNT * 2);
    expect(NodeFS.existsSync(NodePath.join(dir, `${oldest.id}.json`))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(dir, `${oldest.id}.webm`))).toBe(false);
  });

  it("reads audio bytes back by id", () => {
    const dir = makeTempDir();
    const saved = saveAudio(dir, "playback-me");

    const found = readVoiceRecording(dir, saved.id);

    expect(found?.metadata.id).toBe(saved.id);
    expect(found?.audio.equals(Buffer.from("playback-me"))).toBe(true);
    expect(readVoiceRecording(dir, "missing")).toBe(null);
    expect(readVoiceRecording(dir, "../escape")).toBe(null);
  });

  it("updates status after a retry", () => {
    const dir = makeTempDir();
    const saved = saveVoiceRecording(dir, {
      mimeType: "audio/webm",
      audio: Buffer.from("flaky"),
      status: "error",
      attempts: 3,
      error: "Transcription failed (503).",
      transcript: null,
    });

    const updated = updateVoiceRecording(dir, saved.id, {
      status: "ok",
      attempts: 1,
      error: null,
      transcript: "recovered",
    });

    expect(updated).toMatchObject({ status: "ok", attempts: 1, transcript: "recovered" });
    expect(listVoiceRecordings(dir)[0]).toMatchObject({ id: saved.id, status: "ok" });
    expect(
      updateVoiceRecording(dir, "missing", {
        status: "ok",
        attempts: 1,
        error: null,
        transcript: null,
      }),
    ).toBe(null);
  });

  it("deletes audio + sidecar by id", () => {
    const dir = makeTempDir();
    const saved = saveAudio(dir, "delete-me");

    expect(deleteVoiceRecording(dir, saved.id)).toBe(true);
    expect(listVoiceRecordings(dir)).toEqual([]);
    expect(NodeFS.readdirSync(dir)).toEqual([]);
    expect(deleteVoiceRecording(dir, saved.id)).toBe(false);
  });

  it("reads a missing directory and corrupt sidecars as empty", () => {
    const dir = makeTempDir();
    expect(listVoiceRecordings(NodePath.join(dir, "absent"))).toEqual([]);

    NodeFS.writeFileSync(NodePath.join(dir, "bogus.json"), "{not-json");
    expect(listVoiceRecordings(dir)).toEqual([]);
  });
});
