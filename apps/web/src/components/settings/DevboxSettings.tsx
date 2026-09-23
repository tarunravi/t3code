import type { DesktopDevboxAction, DesktopDevboxState } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckCircle2Icon, CircleAlertIcon, CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";

const JOB_POLL_MS = 2_000;

const ACTION_LABELS: Record<DesktopDevboxAction, string> = {
  "aws-login": "Logging in to AWS",
  launch: "Spinning up the devbox",
  setup: "Setting up the devbox",
  start: "Starting the devbox",
  stop: "Stopping the devbox",
  terminate: "Terminating the devbox",
};

function Status({ ok, detail }: { readonly ok: boolean; readonly detail: string }) {
  const Icon = ok ? CheckCircle2Icon : CircleAlertIcon;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className={ok ? "size-3.5 shrink-0 text-success" : "size-3.5 shrink-0 text-warning"} />
      <span className="truncate">{detail}</span>
    </span>
  );
}

function CopyCommand({ command }: { readonly command: string }) {
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => {
        void navigator.clipboard.writeText(command);
        toastManager.add({ type: "success", title: "Command copied", description: command });
      }}
    >
      <CopyIcon className="size-3" />
      Copy login command
    </Button>
  );
}

// The desktop bridge is fixed for the window's lifetime, so callbacks read it directly.
const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;

export function DevboxSettings() {
  const [state, setState] = useState<DesktopDevboxState | null>(null);
  const [checking, setChecking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, { reportFailure: false });
  const { environments } = useEnvironments();
  const wasRunning = useRef(false);

  const available = bridge?.getDevboxState !== undefined && bridge.runDevboxAction !== undefined;
  const instance = state?.instance ?? null;
  const job = state?.job ?? null;
  const busy = job?.running === true;
  const t3Environment =
    instance === null
      ? undefined
      : environments.find((environment) =>
          environment.displayUrl?.endsWith(`@${instance.instanceId}`),
        );

  const load = useCallback(async (options: { refresh?: boolean; checkHealth?: boolean } = {}) => {
    if (!bridge?.getDevboxState) return;
    setState(await bridge.getDevboxState(options));
  }, []);

  useEffect(() => {
    void load({ refresh: true });
  }, [load]);

  // A job runs in the desktop process; poll its log only while one is active.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), JOB_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, load]);

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

  const run = useCallback(async (action: DesktopDevboxAction) => {
    if (!bridge?.runDevboxAction) return;
    if (action === "terminate" && !window.confirm("Terminate the devbox? Its disk is deleted.")) {
      return;
    }
    setState(await bridge.runDevboxAction(action));
  }, []);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try {
      await load({ checkHealth: true });
    } finally {
      setChecking(false);
    }
  }, []);

  const running = instance?.state === "running";
  const checks = state?.checks ?? null;

  return (
    <SettingsPageContainer>
      <SettingsUnavailableGroup
        message={available ? undefined : "The devbox panel is available in the desktop app."}
      >
        <SettingsSection title="Devbox">
          <SettingsRow
            title="AWS"
            description="GovCloud profile used to launch and reach the devbox."
            status={state ? <Status {...state.aws} /> : null}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void run("aws-login")}
              >
                Log in to AWS
              </Button>
            }
          />
          <SettingsRow
            title="Instance"
            description={
              instance
                ? `${instance.instanceId} · ${instance.instanceType} · ssh ${state?.sshAlias}`
                : "No devbox yet. Spinning one up launches it, installs Claude and Codex, signs in GitHub, sets up the brain vault, and connects T3."
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

        {running ? (
          <SettingsSection
            title="Devbox health"
            headerAction={
              <Button
                size="xs"
                variant="ghost"
                disabled={checking || busy}
                onClick={() => void checkHealth()}
              >
                {checking ? <Spinner className="size-3" /> : null}
                Check
              </Button>
            }
          >
            <SettingsRow
              title="GitHub"
              status={checks ? <Status {...checks.github} /> : null}
              control={
                checks && !checks.github.ok ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run("setup")}
                  >
                    Sign in again
                  </Button>
                ) : null
              }
            />
            <SettingsRow
              title="Claude Code"
              status={checks ? <Status {...checks.claude} /> : null}
              control={
                checks && !checks.claude.ok ? (
                  <CopyCommand command={`ssh -t ${state?.sshAlias} 'claude auth login'`} />
                ) : null
              }
            />
            <SettingsRow
              title="Codex"
              status={checks ? <Status {...checks.codex} /> : null}
              control={
                checks && !checks.codex.ok ? (
                  <CopyCommand
                    command={`ssh -tt -o ExitOnForwardFailure=yes -L localhost:1455:localhost:1455 ${state?.sshAlias} 'codex login'`}
                  />
                ) : null
              }
            />
            <SettingsRow
              title="Brain vault"
              status={checks ? <Status {...checks.brain} /> : null}
            />
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
