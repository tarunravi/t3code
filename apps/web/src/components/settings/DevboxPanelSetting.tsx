import type { DesktopAwsProfile } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { setDevboxPanelState, useDevboxPanelEnabled } from "~/lib/devboxPanel";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

/** Settings → General switch; turning it on asks which AWS profile holds the devbox. */
export function DevboxPanelSetting() {
  const enabled = useDevboxPanelEnabled();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [profiles, setProfiles] = useState<readonly DesktopAwsProfile[]>([]);
  const [profile, setProfile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!bridge?.setDevboxEnabled || !bridge.listAwsProfiles) return null;

  const openDialog = async () => {
    const found = (await bridge.listAwsProfiles?.()) ?? [];
    setProfiles(found);
    setProfile(
      (current) =>
        current ?? found.find((entry) => entry.name === "shift")?.name ?? found[0]?.name ?? null,
    );
    setError(null);
    setDialogOpen(true);
  };

  const enable = async () => {
    if (!profile || !bridge.setDevboxEnabled) return;
    setSaving(true);
    setError(null);
    try {
      setDevboxPanelState(await bridge.setDevboxEnabled({ awsProfile: profile }));
      setDialogOpen(false);
      void navigate({ to: "/settings/devbox" });
    } catch (cause) {
      setError(
        (cause instanceof Error ? cause.message : String(cause)).replace(
          /^Error invoking remote method '[^']+':\s*(Error:\s*)?/u,
          "",
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  const signInToAws = async () => {
    if (!profile || !bridge.startDevboxLogin) return;
    const state = await bridge.startDevboxLogin({
      target: "mac",
      provider: "aws",
      awsProfile: profile,
    });
    const link = state.logins.find((login) => login.provider === "aws" && login.target === "mac")
      ?.links[0];
    if (link) void bridge.openExternal(link);
    setError("Approve the AWS sign-in in your browser, then choose Turn on again.");
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("devbox-panel")}
        description="Show Settings → Devbox on this Mac to launch a devbox and sign in to AWS, Teleport, GitHub, Codex, and Claude on it."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              if (checked) {
                void openDialog();
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
            {profiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No profiles in ~/.aws/config.</p>
            ) : (
              <Select value={profile} onValueChange={(value) => setProfile(value)}>
                <SelectTrigger aria-label="AWS profile">
                  <SelectValue>
                    {profile
                      ? `${profile} · ${profiles.find((entry) => entry.name === profile)?.region ?? "no region"}`
                      : "Choose a profile"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {profiles.map((entry) => (
                    <SelectItem key={entry.name} value={entry.name}>
                      {entry.name} · {entry.region ?? "no region"}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
            {error ? (
              <div className="mt-3 grid gap-2">
                <p className="text-xs text-destructive">{error}</p>
                {/sign in to aws/iu.test(error) ? (
                  <Button size="xs" variant="outline" onClick={() => void signInToAws()}>
                    Sign in to AWS
                  </Button>
                ) : null}
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void enable()} disabled={!profile || saving}>
              Turn on
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
