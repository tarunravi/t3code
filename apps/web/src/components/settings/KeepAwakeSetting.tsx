import { useState } from "react";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

/** Settings → General switch; the desktop app applies it immediately. */
export function KeepAwakeSetting() {
  const [enabled, setEnabled] = useState(() => bridge?.getKeepAwakeEnabled?.() ?? true);
  const [error, setError] = useState<string | null>(null);
  if (!bridge?.setKeepAwakeEnabled) return null;

  const applyChange = async (next: boolean) => {
    setEnabled(next);
    setError(null);
    try {
      await bridge.setKeepAwakeEnabled?.(next);
    } catch (cause) {
      setEnabled(!next);
      setError(cause instanceof Error ? cause.message : "Couldn't change this setting.");
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("keep-awake")}
      description="Stops the Mac from sleeping so running agents don't stall. The display can still turn off."
      status={error ? <span className="text-destructive">{error}</span> : null}
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => void applyChange(checked)}
          aria-label="Keep Mac awake while T3 Code is running"
        />
      }
    />
  );
}
