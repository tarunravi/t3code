import { PlayIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  DesktopBridge,
  VoiceRecordingAudio,
  VoiceRecordingMetadata,
} from "@t3tools/contracts";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

interface VoiceRecordingsBridge {
  readonly list: () => Promise<readonly VoiceRecordingMetadata[]>;
  readonly read: (id: string) => Promise<VoiceRecordingAudio>;
  readonly retry: (id: string) => Promise<VoiceRecordingMetadata>;
  readonly remove: (id: string) => Promise<void>;
}

function readBridge(): VoiceRecordingsBridge | null {
  const bridge: DesktopBridge | undefined = window.desktopBridge;
  const list = bridge?.listVoiceRecordings;
  const read = bridge?.readVoiceRecording;
  const retry = bridge?.retryVoiceRecording;
  const remove = bridge?.deleteVoiceRecording;
  if (!list || !read || !retry || !remove) return null;
  return { list, read, retry, remove };
}

function recordingErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Electron IPC rejections prefix the handler message with the channel,
    // and Effect tagged errors stringify with their tag.
    const match = error.message.match(/Error invoking remote method '[^']+': ([\s\S]*)/);
    const inner = match?.[1] ?? error.message;
    return inner.replace(/^(?:Error: )?\w*(?:VoiceRecordingError|VoiceTranscriptionError): /, "");
  }
  return String(error);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function VoiceRecordingRow({
  recording,
  bridge,
  onChanged,
  onDeleted,
}: {
  readonly recording: VoiceRecordingMetadata;
  readonly bridge: VoiceRecordingsBridge;
  readonly onChanged: (recording: VoiceRecordingMetadata) => void;
  readonly onDeleted: (id: string) => void;
}) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    },
    [audioUrl],
  );

  const loadAudio = useCallback(async () => {
    if (audioUrl || audioLoading) return;
    setAudioLoading(true);
    setAudioError(null);
    try {
      const audio = await bridge.read(recording.id);
      const bytes = Uint8Array.from(atob(audio.audioBase64), (char) => char.charCodeAt(0));
      setAudioUrl(URL.createObjectURL(new Blob([bytes], { type: audio.mimeType })));
    } catch (error) {
      setAudioError(recordingErrorMessage(error));
    } finally {
      setAudioLoading(false);
    }
  }, [audioLoading, audioUrl, bridge, recording.id]);

  const retry = useCallback(async () => {
    if (retrying || deleting) return;
    setRetrying(true);
    setActionError(null);
    try {
      onChanged(await bridge.retry(recording.id));
    } catch (error) {
      setActionError(recordingErrorMessage(error));
    } finally {
      setRetrying(false);
    }
  }, [bridge, deleting, onChanged, recording.id, retrying]);

  const remove = useCallback(async () => {
    if (retrying || deleting) return;
    setDeleting(true);
    setActionError(null);
    try {
      await bridge.remove(recording.id);
      onDeleted(recording.id);
    } catch (error) {
      setActionError(recordingErrorMessage(error));
      setDeleting(false);
    }
  }, [bridge, deleting, onDeleted, recording.id, retrying]);

  const failed = recording.status === "error";

  return (
    <div className="border-b border-border/60 px-3 py-3 last:border-b-0 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={failed ? "error" : "success"}>{failed ? "Failed" : "Transcribed"}</Badge>
        <span className="text-xs text-muted-foreground">{formatTimestamp(recording.createdAt)}</span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatBytes(recording.sizeBytes)}
        </span>
        {recording.attempts > 1 ? (
          <span className="text-xs text-muted-foreground">
            {recording.attempts} attempts
          </span>
        ) : null}
        <span className="ms-auto flex shrink-0 items-center gap-1.5">
          {audioUrl ? null : (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              disabled={audioLoading}
              onClick={() => void loadAudio()}
              aria-label="Play recording"
              title="Play recording"
            >
              <PlayIcon className="size-3" />
            </Button>
          )}
          <Button size="xs" variant="outline" disabled={retrying || deleting} onClick={() => void retry()}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
          <Button size="xs" variant="ghost" disabled={retrying || deleting} onClick={() => void remove()}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </span>
      </div>
      {recording.transcript ? (
        <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-foreground/90">
          {recording.transcript}
        </p>
      ) : null}
      {recording.error ? (
        <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-destructive">
          {recording.error}
        </p>
      ) : null}
      {audioError ? (
        <p className="mt-1.5 text-xs text-destructive">{audioError}</p>
      ) : null}
      {actionError ? (
        <p className="mt-1.5 text-xs text-destructive">{actionError}</p>
      ) : null}
      {audioUrl ? (
        <audio controls src={audioUrl} className="mt-2 h-8 w-full" preload="metadata" />
      ) : null}
    </div>
  );
}

type VoiceRecordingsState =
  | { readonly status: "unsupported" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly recordings: VoiceRecordingMetadata[] };

export function VoiceRecordingsSettingsPanel() {
  const [bridge] = useState<VoiceRecordingsBridge | null>(() => readBridge());
  const [state, setState] = useState<VoiceRecordingsState>(() =>
    bridge ? { status: "loading" } : { status: "unsupported" },
  );
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge) {
      setState({ status: "unsupported" });
      return;
    }
    setRefreshing(true);
    try {
      const recordings = await bridge.list();
      setState({ status: "ready", recordings: [...recordings] });
    } catch (error) {
      setState({ status: "error", message: recordingErrorMessage(error) });
    } finally {
      setRefreshing(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleChanged = useCallback((updated: VoiceRecordingMetadata) => {
    setState((previous) =>
      previous.status !== "ready"
        ? previous
        : {
            status: "ready",
            recordings: previous.recordings.map((recording) =>
              recording.id === updated.id ? updated : recording,
            ),
          },
    );
  }, []);

  const handleDeleted = useCallback((id: string) => {
    setState((previous) =>
      previous.status !== "ready"
        ? previous
        : {
            status: "ready",
            recordings: previous.recordings.filter((recording) => recording.id !== id),
          },
    );
  }, []);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Saved recordings"
        headerAction={
          state.status === "ready" ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground/60">
                {state.recordings.length === 30
                  ? "30 most recent"
                  : `${state.recordings.length} saved`}
              </span>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={refreshing}
                onClick={() => void refresh()}
                aria-label="Refresh recordings"
              >
                <RefreshIcon refreshing={refreshing} />
              </Button>
            </span>
          ) : null
        }
      >
        {state.status === "unsupported" ? (
          <p className="px-3 py-5 text-sm/6 text-muted-foreground sm:px-4">
            Voice recordings are only available in the desktop app.
          </p>
        ) : state.status === "error" ? (
          <div className="flex flex-col items-start gap-3 px-3 py-5 sm:px-4">
            <p className="max-w-[70ch] text-pretty text-[13px] leading-[1.45] text-muted-foreground/80">
              {state.message}
            </p>
            <Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>
              Try again
            </Button>
          </div>
        ) : state.status === "loading" ? (
          <p className="px-3 py-5 text-sm/6 text-muted-foreground sm:px-4">
            Loading voice recordings…
          </p>
        ) : state.recordings.length === 0 || !bridge ? (
          <p className="px-3 py-5 text-sm/6 text-muted-foreground sm:px-4">
            No voice recordings yet. Dictations are saved here automatically, whether
            transcription succeeds or fails.
          </p>
        ) : (
          <div className="text-base sm:text-sm">
            {state.recordings.map((recording) => (
              <VoiceRecordingRow
                key={recording.id}
                recording={recording}
                bridge={bridge}
                onChanged={handleChanged}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
