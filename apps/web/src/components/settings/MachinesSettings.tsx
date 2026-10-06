import type {
  DesktopAwsProfile,
  DesktopDevboxLogin,
  DesktopDevboxLoginProvider,
  DesktopDevboxLoginTarget,
  DesktopDevboxState,
} from "@t3tools/contracts";
import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { formatExpiresIn, formatExpiryTime } from "~/lib/awsLogin";
import { cn } from "~/lib/utils";
import { setDevboxPanelState } from "~/lib/devboxPanel";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
  useRelativeTimeTick,
} from "./settingsLayout";

const POLL_MS = 1_500;
const MAC = "mac";

// The desktop bridge is fixed for the window's lifetime, so handlers read it directly.
const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

const PROVIDERS: ReadonlyArray<{
  readonly provider: DesktopDevboxLoginProvider;
  readonly title: string;
}> = [
  { provider: "aws", title: "AWS SSO" },
  { provider: "teleport", title: "Teleport" },
  { provider: "github", title: "GitHub" },
  { provider: "codex", title: "Codex" },
  { provider: "claude", title: "Claude Code" },
];

const PHASES = ["connecting", "approve", "verifying", "done"] as const;

const PHASE_LABELS: Record<DesktopDevboxLogin["phase"], string> = {
  connecting: "Signing out and starting a fresh sign-in…",
  approve: "Approve in your browser",
  verifying: "Checking the new session…",
  done: "Signed in",
  failed: "Sign-in failed",
};

const isActive = (login: DesktopDevboxLogin) =>
  login.phase === "connecting" || login.phase === "approve" || login.phase === "verifying";

function Progress({ login }: { readonly login: DesktopDevboxLogin }) {
  const reached =
    login.phase === "failed" ? -1 : PHASES.indexOf(login.phase as (typeof PHASES)[number]);
  return (
    <div className="grid gap-1.5 pt-1">
      <div className="flex gap-1" aria-hidden>
        {PHASES.map((phase, index) => (
          <span
            key={phase}
            className={cn(
              "h-1 flex-1 rounded-full",
              login.phase === "failed"
                ? "bg-destructive/60"
                : index <= reached
                  ? "bg-primary"
                  : "bg-muted",
            )}
          />
        ))}
      </div>
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs",
          login.phase === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {isActive(login) ? <Spinner className="size-3" /> : null}
        {login.phase === "failed" && login.output
          ? `${PHASE_LABELS.failed}: ${login.output.split("\n").at(-1)}`
          : PHASE_LABELS[login.phase]}
        {login.phase === "approve" && login.codes[0] ? ` · code ${login.codes[0]}` : null}
        {login.phase === "approve" && login.links[0] ? (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => void bridge?.openExternal(login.links[0]!)}
          >
            Reopen
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function MachinesSettings() {
  const [state, setState] = useState<DesktopDevboxState | null>(null);
  const [profiles, setProfiles] = useState<readonly DesktopAwsProfile[]>([]);
  const [selected, setTarget] = useState<DesktopDevboxLoginTarget>(MAC);
  const handled = useRef(new Set<string>());
  const nowMs = useRelativeTimeTick(60_000);

  const available = bridge?.getDevboxState !== undefined && bridge.startDevboxLogin !== undefined;
  const hasDevbox = state?.config != null;
  const instances = hasDevbox ? (state?.instances ?? []) : [];
  const isRunning = (name: string) =>
    instances.some((instance) => instance.name === name && instance.state === "running");
  // A devbox that stopped or disappeared falls back to this Mac.
  const target = selected === MAC || isRunning(selected) ? selected : MAC;
  const onMac = target === MAC;
  const busy = state?.checking === true || (state?.logins.some(isActive) ?? false);
  const checks = state?.checks[target] ?? null;

  const apply = (next: DesktopDevboxState) => {
    setState(next);
    setDevboxPanelState(next);
    for (const login of next.logins) {
      if (login.phase !== "approve" || handled.current.has(login.id)) continue;
      handled.current.add(login.id);
      // The page opens pre-filled with the device code where the provider supports it.
      const link = login.links[0];
      if (link && !login.opensBrowser) void bridge?.openExternal(link);
      // GitHub's device page has no pre-fill, so the code goes to the clipboard.
      if (login.provider === "github" && login.codes[0]) {
        void navigator.clipboard.writeText(login.codes[0]);
      }
    }
  };

  const load = async (options: { refresh?: boolean; checkHealth?: boolean } = {}) => {
    if (!bridge?.getDevboxState) return;
    apply(await bridge.getDevboxState(options));
  };

  useEffect(() => {
    void load({ checkHealth: true });
    void bridge?.listAwsProfiles?.().then(setProfiles);
  }, []);

  // Sign-ins and checks run in the desktop process; follow them only while active.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy]);

  const signIn = async (provider: DesktopDevboxLoginProvider) => {
    if (!bridge?.startDevboxLogin) return;
    try {
      apply(await bridge.startDevboxLogin({ target, provider }));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start sign-in",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const loginFor = (provider: DesktopDevboxLoginProvider) =>
    state?.logins.find((login) => login.target === target && login.provider === provider);

  return (
    <SettingsPageContainer>
      <SettingsUnavailableGroup
        message={available ? undefined : "Machine sign-ins are available in the desktop app."}
      >
        <div className="flex items-center justify-between gap-3 px-1">
          <ToggleGroup
            aria-label="Machine"
            variant="segmented"
            value={[target]}
            onValueChange={(next) => {
              const value = next[0];
              if (value) setTarget(value);
            }}
          >
            <Toggle value={MAC}>This Mac</Toggle>
            {instances.map((instance) => (
              <Toggle
                key={instance.instanceId}
                value={instance.name}
                disabled={instance.state !== "running"}
              >
                {instance.name}
                {instance.state === "running" ? null : ` · ${instance.state}`}
              </Toggle>
            ))}
          </ToggleGroup>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => void load({ checkHealth: true })}
          >
            {state?.checking ? <Spinner className="size-3" /> : null}
            Refresh
          </Button>
        </div>

        <SettingsSection title={onMac ? "This Mac" : target}>
          {!hasDevbox && onMac ? (
            <SettingsRow
              title="AWS profile"
              description="Profile used for AWS SSO on this Mac."
              control={
                <Select
                  value={state?.signInAwsProfile ?? null}
                  onValueChange={(value) => {
                    if (value && bridge?.setSignInAwsProfile) {
                      void bridge
                        .setSignInAwsProfile({ awsProfile: value })
                        .then(() => load({ checkHealth: true }));
                    }
                  }}
                >
                  <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="AWS profile">
                    <SelectValue>{state?.signInAwsProfile ?? "Choose a profile"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {profiles.map((entry) => (
                      <SelectItem hideIndicator key={entry.name} value={entry.name}>
                        {entry.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ) : null}
          {PROVIDERS.map(({ provider, title }) => {
            const check = checks?.[provider] ?? null;
            const login = loginFor(provider);
            const Icon = check?.ok ? CheckCircle2Icon : CircleAlertIcon;
            return (
              <SettingsRow
                key={provider}
                title={title}
                description={
                  <span className="grid gap-1">
                    {check ? (
                      <span className="flex min-w-0 items-center gap-1.5 text-xs">
                        <Icon
                          className={cn(
                            "size-3.5 shrink-0",
                            check.ok ? "text-success" : "text-warning",
                          )}
                        />
                        <span className="truncate">
                          {check.detail}
                          {check.ok && check.expiresAt
                            ? ` · ${formatExpiresIn(check.expiresAt, nowMs)} (${formatExpiryTime(check.expiresAt)})`
                            : check.ok && provider === "github"
                              ? " · doesn't expire"
                              : null}
                        </span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Checking…</span>
                    )}
                    {login ? <Progress login={login} /> : null}
                  </span>
                }
                control={
                  <Button
                    size="xs"
                    variant={check?.ok ? "outline" : "default"}
                    disabled={login !== undefined && isActive(login)}
                    onClick={() => void signIn(provider)}
                  >
                    {check?.ok ? "Sign in again" : "Sign in"}
                  </Button>
                }
              />
            );
          })}
          {!onMac && checks ? (
            <SettingsRow
              title="Brain vault"
              description={<span className="text-xs">{checks.brain.detail}</span>}
            />
          ) : null}
        </SettingsSection>
        {!onMac ? (
          <p className="px-1 text-xs text-muted-foreground">
            Devbox sign-ins open their approval page on this Mac and tunnel the callback back to the
            devbox. GitHub and Claude reuse this Mac's session. One Codex sign-in runs at a time
            because its callback port is fixed.
          </p>
        ) : null}
      </SettingsUnavailableGroup>
    </SettingsPageContainer>
  );
}
