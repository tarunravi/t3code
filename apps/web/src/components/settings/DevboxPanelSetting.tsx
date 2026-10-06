import type { DesktopAwsProfile, DesktopDevboxState } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { defaultAwsProfile } from "~/lib/awsLogin";
import { setDevboxPanelState, useDevboxPanelEnabled } from "~/lib/devboxPanel";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { AwsProfilePicker } from "./AwsProfilePicker";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

const errorMessage = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/u,
    "",
  );

/**
 * Picks the AWS profile that holds the devboxes, starting on the last one used,
 * and turns the panel on for it (or switches an enabled panel to it).
 */
export function DevboxProfileForm({
  submitLabel,
  onEnabled,
  onCancel,
}: {
  readonly submitLabel: string;
  readonly onEnabled: (state: DesktopDevboxState) => void;
  readonly onCancel?: () => void;
}) {
  const [profiles, setProfiles] = useState<readonly DesktopAwsProfile[]>([]);
  const [profile, setProfile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([bridge?.listAwsProfiles?.() ?? [], bridge?.getDevboxState?.()]).then(
      ([found, state]) => {
        setProfiles(found);
        setProfile((current) => current ?? defaultAwsProfile(found, state?.signInAwsProfile));
      },
    );
  }, []);

  const chosen = profile?.trim() ?? "";

  const enable = async () => {
    if (!chosen || !bridge?.setDevboxEnabled) return;
    setSaving(true);
    setError(null);
    try {
      const state = await bridge.setDevboxEnabled({ awsProfile: chosen });
      setDevboxPanelState(state);
      onEnabled(state);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const signInToAws = async () => {
    if (!chosen || !bridge?.startDevboxLogin) return;
    const state = await bridge.startDevboxLogin({
      target: "mac",
      provider: "aws",
      awsProfile: chosen,
    });
    const link = state.logins.find((login) => login.provider === "aws" && login.target === "mac")
      ?.links[0];
    if (link) void bridge.openExternal(link);
    setError(`Approve the AWS sign-in in your browser, then choose ${submitLabel} again.`);
  };

  return (
    <div className="grid gap-3">
      <AwsProfilePicker profiles={profiles} value={profile ?? ""} onValueChange={setProfile} />
      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No profiles in ~/.aws/config; type the profile name.
        </p>
      ) : null}
      {error ? (
        <div className="grid gap-2">
          <p className="text-xs text-destructive">{error}</p>
          {/sign in to aws/iu.test(error) ? (
            <Button size="xs" variant="outline" onClick={() => void signInToAws()}>
              Sign in to AWS
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void enable()} disabled={!chosen || saving}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** Settings → General switch; turning it on asks which AWS profile holds the devbox. */
export function DevboxPanelSetting() {
  const enabled = useDevboxPanelEnabled();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!bridge?.setDevboxEnabled || !bridge.listAwsProfiles) return null;

  return (
    <>
      <SettingsRow
        {...searchableSetting("devbox-panel")}
        description="Show Settings → Devbox on this Mac to launch and manage a devbox. Its sign-ins then appear in Settings → Machines."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              if (checked) {
                setDialogOpen(true);
              } else {
                void bridge.setDevboxEnabled?.(null).then(setDevboxPanelState);
              }
            }}
          />
        }
      />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Turn on the devbox panel</DialogTitle>
            <DialogDescription>
              Pick the AWS profile for the devbox account. Network settings are copied from an
              existing instance tagged Purpose=devbox.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {dialogOpen ? (
              <DevboxProfileForm
                submitLabel="Turn on"
                onCancel={() => setDialogOpen(false)}
                onEnabled={() => {
                  setDialogOpen(false);
                  void navigate({ to: "/settings/devbox" });
                }}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
