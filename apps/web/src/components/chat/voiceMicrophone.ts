/**
 * Microphone selection for voice input: which input device to open, and the
 * fallback to the system default when the saved device is gone.
 */
import type { VoiceInputDevice } from "@t3tools/contracts";

type DeviceInfo = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;
type MediaDevicesLike = Pick<MediaDevices, "enumerateDevices" | "getUserMedia">;

// Chromium's aliases for the OS default devices. They follow whatever the OS
// default is, so "System default" already covers them.
const DEFAULT_DEVICE_ALIASES = new Set(["default", "communications"]);

/** Real audio inputs the user can pick, without the OS default aliases. */
export function selectableMicrophones(devices: ReadonlyArray<DeviceInfo>): DeviceInfo[] {
  return devices.filter(
    (device) =>
      device.kind === "audioinput" &&
      device.deviceId !== "" &&
      !DEFAULT_DEVICE_ALIASES.has(device.deviceId),
  );
}

/**
 * Chromium hides device ids and labels until the page has microphone access,
 * so a blank label means the list cannot be shown by name yet.
 */
export function microphoneLabelsHidden(devices: ReadonlyArray<DeviceInfo>): boolean {
  return devices.some((device) => device.kind === "audioinput" && device.label === "");
}

/**
 * Finds the saved device among the current inputs: by id first, then by
 * label, since ids can change (for example after clearing site data).
 */
export function findPreferredMicrophone(
  preference: VoiceInputDevice,
  devices: ReadonlyArray<DeviceInfo>,
): DeviceInfo | null {
  const microphones = selectableMicrophones(devices);
  return (
    microphones.find((device) => device.deviceId === preference.deviceId) ??
    (preference.label
      ? microphones.find((device) => device.label === preference.label)
      : undefined) ??
    null
  );
}

export function isMissingMicrophoneError(error: unknown): boolean {
  // Chromium's OverconstrainedError is not a DOMException, so match on name.
  const name = (error as { name?: unknown } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
}

export interface VoiceStream {
  readonly stream: MediaStream;
  /** The saved device that could not be opened, when the default was used instead. */
  readonly unavailableDevice: VoiceInputDevice | null;
}

/**
 * Opens the preferred microphone, falling back to the system default when it
 * is missing. Other failures, such as a denied permission, are rethrown.
 */
export async function openVoiceStream(
  mediaDevices: MediaDevicesLike,
  preference: VoiceInputDevice | null,
): Promise<VoiceStream> {
  if (!preference) {
    return { stream: await mediaDevices.getUserMedia({ audio: true }), unavailableDevice: null };
  }
  const devices = await mediaDevices.enumerateDevices().catch(() => []);
  const deviceId = findPreferredMicrophone(preference, devices)?.deviceId ?? preference.deviceId;
  try {
    const stream = await mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    return { stream, unavailableDevice: null };
  } catch (error) {
    if (!isMissingMicrophoneError(error)) throw error;
    return {
      stream: await mediaDevices.getUserMedia({ audio: true }),
      unavailableDevice: preference,
    };
  }
}

export const SYSTEM_DEFAULT_MICROPHONE = "system-default";

export interface MicrophoneOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Options for the microphone picker and the selected value. A saved device
 * that is not connected stays listed so the picker never shows a blank value.
 */
export function microphoneOptions(
  devices: ReadonlyArray<DeviceInfo>,
  preference: VoiceInputDevice | null,
): { readonly options: MicrophoneOption[]; readonly value: string } {
  const options: MicrophoneOption[] = [
    { value: SYSTEM_DEFAULT_MICROPHONE, label: "System default" },
    ...selectableMicrophones(devices).map((device, index) => ({
      value: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    })),
  ];
  if (!preference) return { options, value: SYSTEM_DEFAULT_MICROPHONE };
  const match = findPreferredMicrophone(preference, devices);
  if (match) return { options, value: match.deviceId };
  options.push({
    value: preference.deviceId,
    label: `${preference.label || "Saved microphone"} (not connected)`,
  });
  return { options, value: preference.deviceId };
}
