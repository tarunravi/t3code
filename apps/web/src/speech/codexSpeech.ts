import { useSyncExternalStore } from "react";

let supported = false;
let probe: Promise<void> | undefined;
const listeners = new Set<() => void>();

function probeSupported() {
  if (!supported && !probe && window.desktopBridge?.codexSpeech) {
    probe = window.desktopBridge.codexSpeech
      .supported()
      .then((value) => {
        if (!value || supported) return;
        supported = true;
        listeners.forEach((notify) => notify());
      })
      .catch(() => {})
      .finally(() => {
        probe = undefined;
      });
  }
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("focus", probeSupported);
  listeners.add(listener);
  probeSupported();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("focus", probeSupported);
  };
}

/** Codex dictation runs in the desktop app and needs a Codex login on this device. */
export function useCodexSpeechSupported() {
  return useSyncExternalStore(
    subscribe,
    () => supported,
    () => false,
  );
}
