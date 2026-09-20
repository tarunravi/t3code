import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { VoiceRecordingMetadata } from "@t3tools/contracts";

/** Directory under Electron userData holding saved voice recordings. */
export const VOICE_RECORDINGS_DIRNAME = "voice-recordings";
/** Newest recordings kept; older audio + sidecars are evicted on overflow. */
export const VOICE_RECORDINGS_MAX_COUNT = 30;

const SIDECAR_SUFFIX = ".json";
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function audioExtensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

export function voiceRecordingsDir(userDataPath: string): string {
  return path.join(userDataPath, VOICE_RECORDINGS_DIRNAME);
}

function audioFileName(id: string, mimeType: string): string {
  return `${id}.${audioExtensionForMimeType(mimeType)}`;
}

function sidecarFileName(id: string): string {
  return `${id}${SIDECAR_SUFFIX}`;
}

function isSafeId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id) && id.length <= 128;
}

function readSidecar(dir: string, file: string): VoiceRecordingMetadata | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.createdAt !== "string" ||
      typeof record.mimeType !== "string" ||
      typeof record.sizeBytes !== "number" ||
      (record.status !== "ok" && record.status !== "error") ||
      typeof record.attempts !== "number"
    ) {
      return null;
    }
    return {
      id: record.id,
      createdAt: record.createdAt,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      status: record.status,
      attempts: record.attempts,
      error: typeof record.error === "string" ? record.error : null,
      transcript: typeof record.transcript === "string" ? record.transcript : null,
    };
  } catch {
    return null;
  }
}

function removeRecordingFiles(dir: string, metadata: VoiceRecordingMetadata): void {
  for (const file of [sidecarFileName(metadata.id), audioFileName(metadata.id, metadata.mimeType)]) {
    try {
      fs.rmSync(path.join(dir, file), { force: true });
    } catch {
      // Best-effort eviction; a leftover file is retried on the next save.
    }
  }
}

/** All saved recordings, newest first. Missing directory and corrupt sidecars read as empty. */
export function listVoiceRecordings(dir: string): VoiceRecordingMetadata[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(SIDECAR_SUFFIX))
    .map((file) => readSidecar(dir, file))
    .filter((metadata): metadata is VoiceRecordingMetadata => metadata !== null)
    .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
}

export interface SaveVoiceRecordingInput {
  readonly mimeType: string;
  readonly audio: Buffer;
  readonly status: VoiceRecordingMetadata["status"];
  readonly attempts: number;
  readonly error: string | null;
  readonly transcript: string | null;
}

export function saveVoiceRecording(
  dir: string,
  input: SaveVoiceRecordingInput,
): VoiceRecordingMetadata {
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const metadata: VoiceRecordingMetadata = {
    id,
    createdAt: new Date().toISOString(),
    mimeType: input.mimeType,
    sizeBytes: input.audio.byteLength,
    status: input.status,
    attempts: input.attempts,
    error: input.error,
    transcript: input.transcript,
  };
  fs.writeFileSync(path.join(dir, audioFileName(id, input.mimeType)), input.audio);
  fs.writeFileSync(path.join(dir, sidecarFileName(id)), JSON.stringify(metadata));
  for (const overflow of listVoiceRecordings(dir).slice(VOICE_RECORDINGS_MAX_COUNT)) {
    removeRecordingFiles(dir, overflow);
  }
  return metadata;
}

export interface VoiceRecordingWithAudio {
  readonly metadata: VoiceRecordingMetadata;
  readonly audio: Buffer;
}

export function readVoiceRecording(dir: string, id: string): VoiceRecordingWithAudio | null {
  if (!isSafeId(id)) return null;
  const metadata = readSidecar(dir, sidecarFileName(id));
  if (!metadata) return null;
  try {
    const audio = fs.readFileSync(path.join(dir, audioFileName(id, metadata.mimeType)));
    return { metadata, audio };
  } catch {
    return null;
  }
}

export interface UpdateVoiceRecordingInput {
  readonly status: VoiceRecordingMetadata["status"];
  readonly attempts: number;
  readonly error: string | null;
  readonly transcript: string | null;
}

export function updateVoiceRecording(
  dir: string,
  id: string,
  patch: UpdateVoiceRecordingInput,
): VoiceRecordingMetadata | null {
  if (!isSafeId(id)) return null;
  const metadata = readSidecar(dir, sidecarFileName(id));
  if (!metadata) return null;
  const updated: VoiceRecordingMetadata = { ...metadata, ...patch };
  try {
    fs.writeFileSync(path.join(dir, sidecarFileName(id)), JSON.stringify(updated));
  } catch {
    return null;
  }
  return updated;
}

export function deleteVoiceRecording(dir: string, id: string): boolean {
  if (!isSafeId(id)) return false;
  const metadata = readSidecar(dir, sidecarFileName(id));
  if (!metadata) return false;
  removeRecordingFiles(dir, metadata);
  return true;
}
