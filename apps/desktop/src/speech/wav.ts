export const SPEECH_SAMPLE_RATE = 16_000;

/** 16 kHz mono Float32 PCM to a 16-bit WAV. */
export function encodeSpeechWav(pcmBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  // Float32Array needs a 4-byte-aligned offset; copy a view that is not (Buffer.slice is a view).
  const aligned =
    pcmBytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
      ? pcmBytes
      : new Uint8Array(pcmBytes);
  const samples = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const wav = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SPEECH_SAMPLE_RATE, true);
  view.setUint32(28, SPEECH_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const clamped = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
    view.setInt16(44 + index * 2, Math.round(clamped * 0x7fff), true);
  });
  return wav;
}
