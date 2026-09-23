import type { DesktopDevboxState } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

// The devbox panel is turned on per machine, so the desktop process owns the
// answer; this caches it for the settings nav and the General toggle.
let enabled = false;
let loaded = false;
const listeners = new Set<() => void>();

function publish(state: DesktopDevboxState | null) {
  enabled = state?.config != null;
  loaded = true;
  for (const listener of listeners) listener();
}

function load() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (loaded || !bridge?.getDevboxState) return;
  loaded = true;
  void bridge.getDevboxState().then(publish, () => publish(null));
}

/** Call with the state returned by any devbox bridge method to keep the nav in sync. */
export function setDevboxPanelState(state: DesktopDevboxState) {
  publish(state);
}

export function useDevboxPanelEnabled(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      load();
      return () => listeners.delete(listener);
    },
    () => enabled,
    () => false,
  );
}
