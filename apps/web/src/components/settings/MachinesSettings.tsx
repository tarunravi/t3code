import type {
  DesktopAwsProfile,
  DesktopDevboxLogin,
  DesktopDevboxLoginProvider,
  DesktopDevboxLoginTarget,
  DesktopDevboxState,
} from "@t3tools/contracts";
import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

function remaining(expiresAt: string, nowMs: number): string {
  const ms = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0) return `expires in ${days}d ${hours}h`;
  if (hours > 0) return `expires in ${hours}h ${minutes % 60}m`;
  return `expires in ${minutes}m`;
}

function expiryTitle(expiresAt: string): string {
  return new Date(expiresAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

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
  const [target, setTarget] = useState<DesktopDevboxLoginTarget>("mac");
  const handled = useRef(new Set<string>());
  const nowMs = useRelativeTimeTick(60_000);

  const available = bridge?.getDevboxState !== undefined && bridge.startDevboxLogin !== undefined;
  const devboxRunning = state?.instance?.state === "running";
  const hasDevbox = state?.config != null;
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
              if (value === "mac" || value === "devbox") setTarget(value);
            }}
          >
            <Toggle value="mac">This Mac</Toggle>
            {hasDevbox ? (
              <Toggle value="devbox" disabled={!devboxRunning}>
                {state?.sshAlias ?? "devbox"}
                {devboxRunning ? null : ` · ${state?.instance?.state ?? "none"}`}
              </Toggle>
            ) : null}
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

        <SettingsSection title={target === "mac" ? "This Mac" : "Devbox"}>
          {!hasDevbox && target === "mac" ? (
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
                            ? ` · ${remaining(check.expiresAt, nowMs)} (${expiryTitle(check.expiresAt)})`
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
          {target === "devbox" && checks ? (
            <SettingsRow
              title="Brain vault"
              description={<span className="text-xs">{checks.brain.detail}</span>}
            />
          ) : null}
        </SettingsSection>
        {target === "devbox" ? (
          <p className="px-1 text-xs text-muted-foreground">
            Devbox sign-ins open their approval page on this Mac and tunnel the callback back to the
            devbox. GitHub and Claude reuse this Mac's session.
          </p>
        ) : null}
      </SettingsUnavailableGroup>
    </SettingsPageContainer>
  );
}
