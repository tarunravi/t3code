import { useCallback, useEffect, useState } from "react";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "~/hooks/useSettings";
import {
  microphoneLabelsHidden,
  microphoneOptions,
  selectableMicrophones,
  SYSTEM_DEFAULT_MICROPHONE,
} from "../chat/voiceMicrophone";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type AccessState = "idle" | "requesting" | "denied";

export function VoiceMicrophoneSetting() {
  const preference = useClientSettings((settings) => settings.voiceInputDevice);
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdateClientSettings();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [access, setAccess] = useState<AccessState>("idle");
  const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;

  const refreshDevices = useCallback(async () => {
    if (!mediaDevices) return;
    setDevices(await mediaDevices.enumerateDevices().catch(() => []));
  }, [mediaDevices]);

  useEffect(() => {
    if (!mediaDevices) return;
    void refreshDevices();
    mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, [mediaDevices, refreshDevices]);

  const requestAccess = useCallback(async () => {
    if (!mediaDevices) return;
    setAccess("requesting");
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setAccess("idle");
      await refreshDevices();
    } catch {
      setAccess("denied");
    }
  }, [mediaDevices, refreshDevices]);

  const { options, value } = microphoneOptions(devices, preference);
  const labelsHidden = microphoneLabelsHidden(devices);

  return (
    <SettingsRow
      {...searchableSetting("voice-microphone")}
      description={
        access === "denied"
          ? "Microphone access was denied. Allow it in System Settings › Privacy & Security › Microphone."
          : labelsHidden
            ? "Allow microphone access to choose a microphone by name."
            : "Microphone used for voice input."
      }
      resetAction={
        preference ? (
          <SettingResetButton
            label="microphone"
            onClick={() => updateSettings({ voiceInputDevice: null })}
          />
        ) : null
      }
      control={
        <span className="flex items-center gap-2">
          {labelsHidden ? (
            <Button
              size="sm"
              variant="outline"
              disabled={access === "requesting"}
              onClick={() => void requestAccess()}
            >
              Allow access
            </Button>
          ) : null}
          <Select
            items={options}
            value={value}
            disabled={!settingsHydrated || !mediaDevices}
            onValueChange={(next) => {
              if (next === SYSTEM_DEFAULT_MICROPHONE) {
                updateSettings({ voiceInputDevice: null });
                return;
              }
              const device = selectableMicrophones(devices).find(
                (candidate) => candidate.deviceId === next,
              );
              if (device) {
                updateSettings({
                  voiceInputDevice: { deviceId: device.deviceId, label: device.label },
                });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-auto min-w-0 max-w-64" aria-label="Microphone">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </span>
      }
    />
  );
}
