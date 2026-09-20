/**
 * Web voice-input adapters for the shared VoiceInputController.
 *
 * Recording uses MediaRecorder; transcription runs in the desktop main
 * process (window.desktopBridge.transcribeVoice), which reaches the Codex
 * transcription endpoint through Electron's Chromium network stack using the
 * local Codex login (~/.codex/auth.json).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceDraftSnapshot,
  type VoiceInputState,
  type VoiceRecorder,
  type VoiceRecorderStatus,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Failed to read the recording."));
    reader.readAsDataURL(blob);
  });
}

/**
 * VoiceRecorder implementation over MediaRecorder. The controller expects a
 * file-URI-style recorder (mobile), so recordings are kept in memory keyed by
 * a synthetic URI.
 */
export class WebVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;
  onStatus: ((status: VoiceRecorderStatus) => void) | null = null;
  onLevel: ((level: number) => void) | null = null;

  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private levelMeterContext: AudioContext | null = null;
  private levelMeterSource: MediaStreamAudioSourceNode | null = null;
  private levelMeterAnalyser: AnalyserNode | null = null;
  private levelMeterData: Uint8Array<ArrayBuffer> | null = null;
  private levelMeterFrame: number | null = null;
  private lastLevelAt = 0;
  private chunks: Blob[] = [];
  private readonly blobs = new Map<string, Blob>();
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private uriCounter = 0;

  async requestPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
    try {
      // Acquire the stream here so prepareToRecordAsync can reuse it without
      // a second permission round-trip.
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { granted: true, canAskAgain: true };
    } catch (error) {
      const denied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "SecurityError");
      return { granted: false, canAskAgain: !denied };
    }
  }

  async prepareToRecordAsync(): Promise<void> {
    this.stream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType =
      PREFERRED_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.mediaRecorder = recorder;
    this.chunks = [];
    this.uri = `web-voice://${++this.uriCounter}`;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onstop = () => {
      const uri = this.uri;
      if (uri && this.chunks.length > 0) {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size > 0) this.blobs.set(uri, blob);
      }
      this.chunks = [];
      // Manual stops go through controller.stop(), which has already moved to
      // the transcribing phase and ignores this status; the duration-limit
      // auto-stop is the path that matters here.
      this.onStatus?.({ isFinished: true, hasError: false, error: null, url: uri });
    };
    recorder.onerror = (event) => {
      this.onStatus?.({
        isFinished: false,
        hasError: true,
        error: event.error instanceof Error ? event.error.message : "Recorder error",
        url: this.uri,
      });
    };
  }

  record(options: { readonly forDuration: number }): void {
    const recorder = this.mediaRecorder;
    if (!recorder) throw new Error("Recorder was not prepared.");
    recorder.start(250);
    this.startLevelMeter();
    if (Number.isFinite(options.forDuration) && options.forDuration > 0) {
      this.limitTimer = setTimeout(() => {
        if (this.mediaRecorder?.state === "recording") {
          this.mediaRecorder.stop();
        }
      }, options.forDuration * 1000);
    }
  }

  async stop(): Promise<void> {
    if (this.limitTimer) {
      clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
    const recorder = this.mediaRecorder;
    if (recorder && recorder.state !== "inactive") {
      const stopped = new Promise<void>((resolve) => {
        const previous = recorder.onstop;
        recorder.onstop = (event) => {
          previous?.call(recorder, event);
          resolve();
        };
      });
      recorder.stop();
      await stopped;
    }
    this.disposeStream();
  }

  disposeStream(): void {
    this.stopLevelMeter();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.mediaRecorder = null;
  }

  private startLevelMeter(): void {
    if (typeof window === "undefined" || !this.stream || typeof AudioContext === "undefined") {
      return;
    }

    this.stopLevelMeter();
    try {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(this.stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      this.levelMeterContext = context;
      this.levelMeterSource = source;
      this.levelMeterAnalyser = analyser;
      this.levelMeterData = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      this.lastLevelAt = 0;

      const update = (timestamp: number) => {
        const currentAnalyser = this.levelMeterAnalyser;
        const data = this.levelMeterData;
        if (!currentAnalyser || !data || this.mediaRecorder?.state !== "recording") {
          this.levelMeterFrame = null;
          return;
        }

        if (timestamp - this.lastLevelAt >= 50) {
          currentAnalyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const sample of data) {
            const normalized = (sample - 128) / 128;
            sum += normalized * normalized;
          }
          const rms = Math.sqrt(sum / data.length);
          this.onLevel?.(Math.min(1, Math.max(0, (rms - 0.01) * 5)));
          this.lastLevelAt = timestamp;
        }

        this.levelMeterFrame = window.requestAnimationFrame(update);
      };

      this.levelMeterFrame = window.requestAnimationFrame(update);
      void context.resume().catch(() => undefined);
    } catch {
      this.stopLevelMeter();
    }
  }

  private stopLevelMeter(): void {
    if (this.levelMeterFrame !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.levelMeterFrame);
    }
    this.levelMeterFrame = null;
    this.levelMeterSource?.disconnect();
    this.levelMeterAnalyser?.disconnect();
    void this.levelMeterContext?.close().catch(() => undefined);
    this.levelMeterSource = null;
    this.levelMeterAnalyser = null;
    this.levelMeterData = null;
    this.levelMeterContext = null;
  }

  readBlob(uri: string): Blob | null {
    return this.blobs.get(uri) ?? null;
  }

  deleteBlob(uri: string): void {
    this.blobs.delete(uri);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Electron IPC rejections prefix the handler message with the channel,
    // and Effect tagged errors stringify with their tag.
    const match = error.message.match(/Error invoking remote method '[^']+': ([\s\S]*)/);
    const inner = match?.[1] ?? error.message;
    return inner.replace(/^(?:Error: )?\w*VoiceTranscriptionError: /, "");
  }
  return String(error);
}

export function getCodexVoiceTranscriber(recorder: WebVoiceRecorder): VoiceTranscriber | null {
  if (typeof window === "undefined") return null;
  const bridge = window.desktopBridge;
  if (!bridge?.transcribeVoice) return null;
  const transcribeVoice = bridge.transcribeVoice.bind(bridge);
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US",
        transcribe: async (uri, { signal }) => {
          const blob = recorder.readBlob(uri);
          if (!blob) {
            throw new VoiceTranscriptionError(
              "transcription-failed",
              "The recording could not be read.",
            );
          }
          const audioBase64 = await blobToBase64(blob);
          throwIfVoiceTranscriptionAborted(signal);
          try {
            const result = await transcribeVoice({
              audioBase64,
              mimeType: blob.type || "audio/webm",
            });
            return result.text;
          } catch (error) {
            throw new VoiceTranscriptionError("transcription-failed", errorMessage(error));
          }
        },
      };
    },
  };
}

export function useCodexVoiceInput(input: {
  readonly ownerKey: string | null;
  readonly draftText: string;
  readonly cursor: number;
  readonly disabled?: boolean;
  readonly onCommit: (text: string, cursor: number) => void;
}) {
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [waveformLevels, setWaveformLevels] = useState<number[]>([]);
  const recorderRef = useRef<WebVoiceRecorder | null>(null);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const previousDraftRef = useRef({ ownerKey: input.ownerKey, text: input.draftText });
  const revisionRef = useRef(0);
  if (
    previousDraftRef.current.ownerKey !== input.ownerKey ||
    previousDraftRef.current.text !== input.draftText
  ) {
    previousDraftRef.current = { ownerKey: input.ownerKey, text: input.draftText };
    revisionRef.current += 1;
  }
  const latestInputRef = useRef(input);
  latestInputRef.current = input;

  if (!recorderRef.current) {
    recorderRef.current = new WebVoiceRecorder();
  }
  const recorder = recorderRef.current;

  if (!controllerRef.current) {
    recorder.onStatus = (status) => {
      controllerRef.current?.handleRecorderStatus(status);
    };
    recorder.onLevel = (level) => {
      setWaveformLevels((previous) => [...previous.slice(-71), level]);
    };
    controllerRef.current = new VoiceInputController({
      recorder,
      getTranscriber: () => getCodexVoiceTranscriber(recorder),
      requestPermission: () => recorder.requestPermission(),
      configureRecording: async () => {},
      releaseRecording: async () => {
        recorder.disposeStream();
      },
      deleteRecording: (uri) => recorder.deleteBlob(uri),
      readDraft: (): VoiceDraftSnapshot | null => {
        const current = latestInputRef.current;
        if (!current.ownerKey) return null;
        return {
          ownerKey: current.ownerKey,
          text: current.draftText,
          selection: { start: current.cursor, end: current.cursor },
          revision: revisionRef.current,
        };
      },
      commitDraft: (text, selection) => {
        latestInputRef.current.onCommit(text, selection.start);
      },
      onStateChange: setState,
    });
  }
  const controller = controllerRef.current;

  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (state.phase !== "recording") {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
    return () => clearInterval(interval);
  }, [state.phase]);

  useEffect(() => {
    if (state.phase === "idle" || state.phase === "preparing" || state.phase === "error") {
      setWaveformLevels([]);
    }
  }, [state.phase]);

  const start = useCallback(() => {
    if (!latestInputRef.current.disabled) void controller.start();
  }, [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);
  /**
   * Stops recording and waits for the transcript commit. Resolves true when
   * the draft was updated, false when transcription failed or was empty.
   */
  const stopAndAwaitTranscript = useCallback(async (): Promise<boolean> => {
    await controller.stop();
    return controller.currentState.phase === "idle";
  }, [controller]);

  return {
    isAvailable: getCodexVoiceTranscriber(recorder) !== null,
    state,
    elapsedSeconds,
    waveformLevels,
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    cancel,
    stopAndAwaitTranscript,
  };
}
