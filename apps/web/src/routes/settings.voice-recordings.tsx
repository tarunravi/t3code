import { createFileRoute } from "@tanstack/react-router";

import { VoiceRecordingsSettingsPanel } from "../components/settings/VoiceRecordingsSettings";

export const Route = createFileRoute("/settings/voice-recordings")({
  component: VoiceRecordingsSettingsPanel,
});
