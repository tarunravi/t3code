import { describe, expect, it } from "vite-plus/test";

import { visibleVoiceWaveformLevels } from "./VoiceRecordingWaveform";

describe("visibleVoiceWaveformLevels", () => {
  it("pads new recordings on the left so new samples enter on the right", () => {
    expect(visibleVoiceWaveformLevels([0.2, 0.8], 4)).toEqual([0, 0, 0.2, 0.8]);
  });

  it("keeps only the most recent samples", () => {
    expect(visibleVoiceWaveformLevels([0.1, 0.2, 0.3, 0.4], 2)).toEqual([0.3, 0.4]);
  });

  it("renders silence as baseline samples", () => {
    expect(visibleVoiceWaveformLevels([], 3)).toEqual([0, 0, 0]);
  });
});
