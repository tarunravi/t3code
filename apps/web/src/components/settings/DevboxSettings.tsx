import type {
  DesktopDevboxAction,
  DesktopDevboxLogin,
  DesktopDevboxLoginProvider,
  DesktopDevboxLoginTarget,
  DesktopDevboxState,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckCircle2Icon, CircleAlertIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { setDevboxPanelState } from "~/lib/devboxPanel";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";

const POLL_MS = 2_000;

// The desktop bridge is fixed for the window's lifetime, so callbacks read it directly.
const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

const ACTION_LABELS: Record<DesktopDevboxAction, string> = {
  launch: "Spinning up the devbox",
  setup: "Setting up the devbox",
  start: "Starting the devbox",
  stop: "Stopping the devbox",
  terminate: "Terminating the devbox",
};

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

const TARGET_LABELS: Record<DesktopDevboxLoginTarget, string> = { mac: "Mac", devbox: "devbox" };

function Status({ ok, detail }: { readonly ok: boolean; readonly detail: string }) {
  const Icon = ok ? CheckCircle2Icon : CircleAlertIcon;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className={ok ? "size-3.5 shrink-0 text-success" : "size-3.5 shrink-0 text-warning"} />
      <span className="truncate">{detail}</span>
    </span>
  );
}

function LoginSession({
  login,
  onInput,
}: {
  readonly login: DesktopDevboxLogin;
  readonly onInput: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const title = `${PROVIDERS.find((entry) => entry.provider === login.provider)?.title} on ${TARGET_LABELS[login.target]}`;
  return (
    <div className="grid gap-2 border-t border-border/60 px-3 py-2.5 first:border-t-0 sm:px-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm">
          {login.status === "running" ? <Spinner className="size-3" /> : null}
          {title}
        </span>
        <Status
          ok={login.status !== "failed"}
          detail={login.status === "running" ? "Waiting for approval" : login.status}
        />
      </div>
      {login.links.map((link) => (
        <div key={link} className="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => void bridge?.openExternal(link)}>
            <ExternalLinkIcon className="size-3" />
            Open approval
          </Button>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{link}</span>
        </div>
      ))}
      {login.codes.map((code) => (
        <div key={code} className="flex items-center gap-2 text-xs">
          <span className="font-mono text-sm tracking-wider">{code}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigator.clipboard.writeText(code)}
          >
            <CopyIcon className="size-3" />
            Copy code
          </Button>
        </div>
      ))}
      {login.status === "running" ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim().length === 0) return;
            onInput(text);
            setText("");
          }}
        >
          <Input
            size="sm"
            placeholder="Paste a code the browser shows, if asked"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button size="xs" variant="outline" type="submit">
            Send
          </Button>
        </form>
      ) : null}
      <details>
        <summary className="cursor-pointer text-[11px] text-muted-foreground">Output</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
          {login.output || "…"}
        </pre>
      </details>
    </div>
  );
}

export function DevboxSettings() {
  const [state, setState] = useState<DesktopDevboxState | null>(null);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const wasRunning = useRef(false);
  const openedLinks = useRef(new Set<string>());

  const available = bridge?.getDevboxState !== undefined && bridge.runDevboxAction !== undefined;
  const instance = state?.instance ?? null;
  const job = state?.job ?? null;
  const busy = job?.running === true;
  const loginsRunning = state?.logins.some((login) => login.status === "running") ?? false;
  const running = instance?.state === "running";
  const t3Environment =
    instance === null
      ? undefined
      : environments.find((environment) =>
          environment.displayUrl?.endsWith(`@${instance.instanceId}`),
        );

  const apply = (next: DesktopDevboxState) => {
    setState(next);
    setDevboxPanelState(next);
    // Open each approval link once, the way the CLI would from a local terminal.
    for (const login of next.logins) {
      const link = login.links[0];
      if (login.status === "running" && link && !openedLinks.current.has(login.id)) {
        openedLinks.current.add(login.id);
        void bridge?.openExternal(link);
      }
    }
  };

  const load = useCallback(async (options: { refresh?: boolean; checkHealth?: boolean } = {}) => {
    if (!bridge?.getDevboxState) return;
    apply(await bridge.getDevboxState(options));
  }, []);

  useEffect(() => {
    void load({ checkHealth: true });
  }, [load]);

  // Jobs and sign-ins run in the desktop process; poll only while one is active.
  useEffect(() => {
    if (!busy && !loginsRunning) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, loginsRunning, load]);

  const sshAlias = state?.sshAlias ?? null;
  const connectT3 = useCallback(async () => {
    if (!bridge || sshAlias === null) return;
    setConnecting(true);
    try {
      const target = await bridge.resolveSshHost(sshAlias);
      const result = await connectSshEnvironment({ target, label: "devbox" });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Could not connect T3 to the devbox",
            description: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      toastManager.add({ type: "success", title: "Devbox connected", description: sshAlias });
    } finally {
      setConnecting(false);
    }
  }, [sshAlias]);

  // Launch and setup end by pairing T3 through the normal SSH connection flow.
  useEffect(() => {
    const finished = wasRunning.current && !busy;
    wasRunning.current = busy;
    if (
      finished &&
      job &&
      job.error === null &&
      (job.action === "launch" || job.action === "setup")
    ) {
      void connectT3();
    }
  }, [busy, connectT3, job]);

  const run = async (action: DesktopDevboxAction) => {
    if (!bridge?.runDevboxAction) return;
    if (action === "terminate" && !window.confirm("Terminate the devbox? Its disk is deleted.")) {
      return;
    }
    apply(await bridge.runDevboxAction(action));
  };

  const signIn = async (target: DesktopDevboxLoginTarget, provider: DesktopDevboxLoginProvider) => {
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

  const signInToEverything = () => {
    const current = state?.checks;
    for (const { provider } of PROVIDERS) {
      if (current?.mac && !current.mac[provider].ok) void signIn("mac", provider);
      if (running && current?.devbox && !current.devbox[provider].ok) {
        void signIn("devbox", provider);
      }
    }
  };

  const checkHealth = async () => {
    setChecking(true);
    try {
      await load({ checkHealth: true });
    } finally {
      setChecking(false);
    }
  };

  const checks = state?.checks ?? { mac: null, devbox: null };

  if (state !== null && state.config === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Devbox">
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            The devbox panel is off on this Mac. Turn it on in Settings → General.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsUnavailableGroup
        message={available ? undefined : "The devbox panel is available in the desktop app."}
      >
        <SettingsSection title="Devbox">
          <SettingsRow
            title="AWS"
            description={
              state?.config
                ? `${state.config.awsProfile} · ${state.config.awsRegion}`
                : "Devbox account"
            }
            status={state ? <Status {...state.aws} /> : null}
          />
          <SettingsRow
            title="Instance"
            description={
              instance
                ? `${instance.instanceId} · ${instance.instanceType} · ssh ${state?.sshAlias}`
                : "No devbox yet. Spinning one up launches it, installs Teleport, Claude, and Codex, signs in GitHub, sets up the brain vault, and connects T3."
            }
            status={instance ? <Status ok={running} detail={instance.state} /> : null}
            control={
              <div className="flex flex-wrap justify-end gap-1.5">
                {instance === null ? (
                  <Button
                    size="xs"
                    disabled={busy || !state?.aws.ok}
                    onClick={() => void run("launch")}
                  >
                    Spin up devbox
                  </Button>
                ) : (
                  <>
                    {instance.state === "stopped" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run("start")}
                      >
                        Start
                      </Button>
                    ) : null}
                    {running ? (
                      <>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run("setup")}
                        >
                          Re-run setup
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run("stop")}
                        >
                          Stop
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={busy}
                      onClick={() => void run("terminate")}
                    >
                      Terminate
                    </Button>
                  </>
                )}
              </div>
            }
          />
          {running ? (
            <SettingsRow
              title="T3"
              description="Runs on the devbox and connects over the SSH tunnel."
              status={
                t3Environment ? (
                  <Status
                    ok={t3Environment.connection.phase === "connected"}
                    detail={t3Environment.connection.phase}
                  />
                ) : (
                  <Status ok={false} detail="Not connected" />
                )
              }
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || connecting}
                  onClick={() => void connectT3()}
                >
                  {connecting ? <Spinner className="size-3" /> : null}
                  {t3Environment ? "Reconnect" : "Connect"}
                </Button>
              }
            />
          ) : null}
        </SettingsSection>

        <SettingsSection
          title="Sign-ins"
          headerAction={
            <div className="flex gap-1.5">
              <Button
                size="xs"
                variant="ghost"
                disabled={checking}
                onClick={() => void checkHealth()}
              >
                {checking ? <Spinner className="size-3" /> : null}
                Check
              </Button>
              <Button size="xs" variant="outline" disabled={checking} onClick={signInToEverything}>
                Sign in to everything
              </Button>
            </div>
          }
        >
          {PROVIDERS.map(({ provider, title }) => (
            <SettingsRow
              key={provider}
              title={title}
              description={
                <span className="grid gap-0.5">
                  {checks.mac ? (
                    <span className="flex gap-1.5">
                      Mac: <Status {...checks.mac[provider]} />
                    </span>
                  ) : null}
                  {checks.devbox ? (
                    <span className="flex gap-1.5">
                      Devbox: <Status {...checks.devbox[provider]} />
                    </span>
                  ) : null}
                </span>
              }
              control={
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button size="xs" variant="outline" onClick={() => void signIn("mac", provider)}>
                    Mac
                  </Button>
                  {running ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void signIn("devbox", provider)}
                    >
                      Devbox
                    </Button>
                  ) : null}
                </div>
              }
            />
          ))}
          {checks.devbox ? (
            <SettingsRow title="Brain vault" status={<Status {...checks.devbox.brain} />} />
          ) : null}
        </SettingsSection>

        {state && state.logins.length > 0 ? (
          <SettingsSection title="Sign-in sessions">
            {state.logins.map((login) => (
              <LoginSession
                key={login.id}
                login={login}
                onInput={(text) =>
                  void bridge?.sendDevboxLoginInput?.({ id: login.id, text }).then(apply)
                }
              />
            ))}
          </SettingsSection>
        ) : null}

        {job ? (
          <SettingsSection title={busy ? ACTION_LABELS[job.action] : "Last run"}>
            <div className="px-3 py-2 sm:px-4">
              {job.error ? <p className="mb-2 text-xs text-destructive">{job.error}</p> : null}
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
                {job.log.join("\n") || "Starting…"}
              </pre>
            </div>
          </SettingsSection>
        ) : null}
      </SettingsUnavailableGroup>
    </SettingsPageContainer>
  );
}
