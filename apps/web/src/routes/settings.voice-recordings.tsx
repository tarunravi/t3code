import { createFileRoute } from "@tanstack/react-router";

import { VoiceRecordingsSettingsPanel } from "../components/settings/VoiceRecordingsSettings";

function SettingsVoiceRecordingsRoute() {
  const { recording } = Route.useSearch();
  return <VoiceRecordingsSettingsPanel {...(recording ? { focusedRecordingId: recording } : {})} />;
}

export const Route = createFileRoute("/settings/voice-recordings")({
  validateSearch: (raw: Record<string, unknown>): { recording?: string } =>
    typeof raw.recording === "string" && raw.recording.trim() ? { recording: raw.recording } : {},
  component: SettingsVoiceRecordingsRoute,
});
