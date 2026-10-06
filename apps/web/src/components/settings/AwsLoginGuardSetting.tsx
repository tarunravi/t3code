import type { DesktopAwsLoginGuardInput, DesktopAwsProfile } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { defaultAwsProfile, setAwsLoginStatus, useAwsLoginStatus } from "~/lib/awsLogin";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { AwsProfilePicker } from "./AwsProfilePicker";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

/** Settings → General: warn in the sidebar when this Mac's AWS SSO session is missing or ending. */
export function AwsLoginGuardSetting() {
  const status = useAwsLoginStatus();
  const [profiles, setProfiles] = useState<readonly DesktopAwsProfile[]>([]);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    void bridge?.listAwsProfiles?.().then(setProfiles);
    void bridge?.getDevboxState?.().then((state) => setLastUsed(state.signInAwsProfile));
  }, []);

  if (!bridge?.setAwsLoginGuard) return null;

  const watched = status?.awsProfile ?? null;
  const profile = (draft ?? watched ?? defaultAwsProfile(profiles, lastUsed) ?? "").trim();

  const save = async (input: DesktopAwsLoginGuardInput) => {
    try {
      setAwsLoginStatus(await bridge.setAwsLoginGuard!(input));
      setDraft(null);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not update Require AWS login",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("aws-login-guard")}
      description="Shows a sidebar warning when this Mac's AWS SSO session for the profile is missing or ends within an hour, with a button to log in. Bifrost on devbox0 needs it."
      control={
        <div className="flex items-center gap-2">
          <div className="w-44">
            <AwsProfilePicker profiles={profiles} value={profile} onValueChange={setDraft} />
          </div>
          {watched !== null && profile && profile !== watched ? (
            <Button size="xs" variant="outline" onClick={() => void save({ awsProfile: profile })}>
              Save
            </Button>
          ) : null}
          <Switch
            aria-label="Require AWS login"
            checked={watched !== null}
            disabled={watched === null && !profile}
            onCheckedChange={(checked) => void save(checked ? { awsProfile: profile } : null)}
          />
        </div>
      }
    />
  );
}
