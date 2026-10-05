import { describe, expect, it, vi } from "vite-plus/test";

import {
  findPreferredMicrophone,
  microphoneLabelsHidden,
  microphoneOptions,
  openVoiceStream,
  selectableMicrophones,
  SYSTEM_DEFAULT_MICROPHONE,
} from "./voiceMicrophone";

function input(deviceId: string, label: string) {
  return { deviceId, label, kind: "audioinput" as const };
}

const BUILT_IN = input("built-in-id", "MacBook Pro Microphone");
const USB = input("usb-id", "USB Microphone");
const DEVICES = [
  input("default", "Default - MacBook Pro Microphone"),
  BUILT_IN,
  USB,
  { deviceId: "speaker-id", label: "MacBook Pro Speakers", kind: "audiooutput" as const },
];

const stream = (name: string) => ({ id: name }) as unknown as MediaStream;

function missingDevice(name: "OverconstrainedError" | "NotFoundError") {
  return Object.assign(new Error("device missing"), { name });
}

describe("selectableMicrophones", () => {
  it("lists real inputs without the default alias or outputs", () => {
    expect(selectableMicrophones(DEVICES)).toEqual([BUILT_IN, USB]);
  });
});

describe("microphoneLabelsHidden", () => {
  it("reports inputs whose labels are hidden until permission is granted", () => {
    expect(microphoneLabelsHidden([input("", "")])).toBe(true);
    expect(microphoneLabelsHidden(DEVICES)).toBe(false);
  });
});

describe("findPreferredMicrophone", () => {
  it("matches the saved device by id", () => {
    expect(findPreferredMicrophone({ deviceId: "usb-id", label: "Renamed" }, DEVICES)).toBe(USB);
  });

  it("re-matches by label when the device id changed", () => {
    expect(findPreferredMicrophone({ deviceId: "old-id", label: "USB Microphone" }, DEVICES)).toBe(
      USB,
    );
  });

  it("returns null when the device is gone", () => {
    expect(findPreferredMicrophone({ deviceId: "old-id", label: "Headset" }, DEVICES)).toBeNull();
    expect(findPreferredMicrophone({ deviceId: "old-id", label: "" }, [input("x", "")])).toBeNull();
  });
});

describe("openVoiceStream", () => {
  function mediaDevices(getUserMedia: (constraints: MediaStreamConstraints) => unknown) {
    return {
      enumerateDevices: vi.fn().mockResolvedValue(DEVICES),
      getUserMedia: vi.fn(getUserMedia) as unknown as MediaDevices["getUserMedia"],
    };
  }

  it("opens the system default without a saved device", async () => {
    const devices = mediaDevices(async () => stream("default"));

    await expect(openVoiceStream(devices, null)).resolves.toEqual({
      stream: stream("default"),
      unavailableDevice: null,
    });
    expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it("requires the saved device, re-matched by label", async () => {
    const devices = mediaDevices(async () => stream("usb"));

    await expect(
      openVoiceStream(devices, { deviceId: "old-id", label: "USB Microphone" }),
    ).resolves.toEqual({ stream: stream("usb"), unavailableDevice: null });
    expect(devices.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "usb-id" } },
    });
  });

  it.each(["OverconstrainedError", "NotFoundError"] as const)(
    "falls back to the system default on %s and reports the missing device",
    async (errorName) => {
      const preference = { deviceId: "gone-id", label: "Headset" };
      const devices = mediaDevices(async (constraints) => {
        if (constraints.audio !== true) throw missingDevice(errorName);
        return stream("default");
      });

      await expect(openVoiceStream(devices, preference)).resolves.toEqual({
        stream: stream("default"),
        unavailableDevice: preference,
      });
      expect(devices.getUserMedia).toHaveBeenNthCalledWith(1, {
        audio: { deviceId: { exact: "gone-id" } },
      });
      expect(devices.getUserMedia).toHaveBeenNthCalledWith(2, { audio: true });
    },
  );

  it("rethrows a denied permission instead of falling back", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const devices = mediaDevices(async () => {
      throw denied;
    });

    await expect(openVoiceStream(devices, { deviceId: "usb-id", label: "USB" })).rejects.toBe(
      denied,
    );
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe("microphoneOptions", () => {
  it("starts with the system default and selects it without a saved device", () => {
    expect(microphoneOptions(DEVICES, null)).toEqual({
      options: [
        { value: SYSTEM_DEFAULT_MICROPHONE, label: "System default" },
        { value: "built-in-id", label: "MacBook Pro Microphone" },
        { value: "usb-id", label: "USB Microphone" },
      ],
      value: SYSTEM_DEFAULT_MICROPHONE,
    });
  });

  it("selects the saved device after its id changed", () => {
    expect(microphoneOptions(DEVICES, { deviceId: "old-id", label: "USB Microphone" }).value).toBe(
      "usb-id",
    );
  });

  it("keeps a disconnected saved device selectable", () => {
    const { options, value } = microphoneOptions(DEVICES, {
      deviceId: "headset-id",
      label: "Headset",
    });
    expect(value).toBe("headset-id");
    expect(options.at(-1)).toEqual({ value: "headset-id", label: "Headset (not connected)" });
  });
});
