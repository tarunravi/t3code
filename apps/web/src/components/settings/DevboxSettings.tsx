import type { DesktopDevboxAction, DesktopDevboxState } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckCircle2Icon, CircleAlertIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { setDevboxPanelState } from "~/lib/devboxPanel";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { DevboxProfileForm } from "./DevboxPanelSetting";
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
  launch: "Spinning up",
  setup: "Setting up",
  start: "Starting",
  stop: "Stopping",
  terminate: "Terminating",
};

type Instance = DesktopDevboxState["instances"][number];
type Job = DesktopDevboxState["jobs"][number];

function JobLog({ job }: { readonly job: Job }) {
  return (
    <div className="px-3 py-2 sm:px-4">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        {job.running ? `${ACTION_LABELS[job.action]}…` : "Last run"}
      </p>
      {job.error ? <p className="mb-2 text-xs text-destructive">{job.error}</p> : null}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-2xs leading-relaxed text-muted-foreground">
        {job.log.join("\n") || "Starting…"}
      </pre>
    </div>
  );
}

const errorMessage = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']+':\s*(Error:\s*)?/u,
    "",
  );

function Status({ ok, detail }: { readonly ok: boolean; readonly detail: string }) {
  const Icon = ok ? CheckCircle2Icon : CircleAlertIcon;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className={ok ? "size-3.5 shrink-0 text-success" : "size-3.5 shrink-0 text-warning"} />
      <span className="truncate">{detail}</span>
    </span>
  );
}

export function DevboxSettings() {
  const navigate = useNavigate();
  const [state, setState] = useState<DesktopDevboxState | null>(null);
  const [connecting, setConnecting] = useState<ReadonlySet<string>>(new Set());
  const [newName, setNewName] = useState<string | null>(null);
  const [changingProfile, setChangingProfile] = useState(false);
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const runningJobs = useRef(new Set<string>());

  const available = bridge?.getDevboxState !== undefined && bridge.runDevboxAction !== undefined;
  const instances = state?.instances ?? [];
  const jobs = state?.jobs ?? [];
  const anyBusy = jobs.some((job) => job.running);
  const jobFor = (name: string) => jobs.find((job) => job.devbox === name);
  const pendingLaunches = jobs.filter(
    (job) => job.action === "launch" && !instances.some((instance) => instance.name === job.devbox),
  );
  const t3EnvironmentFor = (instance: Instance) =>
    environments.find((environment) => environment.displayUrl?.endsWith(`@${instance.instanceId}`));

  const apply = (next: DesktopDevboxState) => {
    setState(next);
    setDevboxPanelState(next);
  };

  const load = useCallback(async (options: { refresh?: boolean; checkHealth?: boolean } = {}) => {
    if (!bridge?.getDevboxState) return;
    apply(await bridge.getDevboxState(options));
  }, []);

  useEffect(() => {
    void load({ refresh: true });
  }, [load]);

  // Jobs run in the desktop process; poll only while one is active.
  useEffect(() => {
    if (!anyBusy) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyBusy, load]);

  const connectT3 = useCallback(async (devbox: string) => {
    if (!bridge) return;
    setConnecting((current) => new Set(current).add(devbox));
    try {
      const target = await bridge.resolveSshHost(devbox);
      const result = await connectSshEnvironment({ target, label: devbox });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: `Could not connect T3 to ${devbox}`,
            description: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      toastManager.add({ type: "success", title: "Devbox connected", description: devbox });
    } finally {
      setConnecting((current) => {
        const next = new Set(current);
        next.delete(devbox);
        return next;
      });
    }
  }, []);

  // Launch and setup end by pairing T3 through the normal SSH connection flow.
  useEffect(() => {
    for (const job of jobs) {
      const wasRunning = runningJobs.current.has(job.devbox);
      if (job.running) {
        runningJobs.current.add(job.devbox);
        continue;
      }
      runningJobs.current.delete(job.devbox);
      if (wasRunning && job.error === null && (job.action === "launch" || job.action === "setup")) {
        void connectT3(job.devbox);
      }
    }
  }, [connectT3, jobs]);

  const run = async (action: DesktopDevboxAction, devbox: string) => {
    if (!bridge?.runDevboxAction) return;
    if (action === "terminate" && !window.confirm(`Terminate ${devbox}? Its disk is deleted.`)) {
      return;
    }
    try {
      apply(await bridge.runDevboxAction({ action, devbox }));
      if (action === "launch") setNewName(null);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Could not ${action === "launch" ? "spin up" : action} ${devbox}`,
        description: errorMessage(cause),
      });
    }
  };

  if (state !== null && state.config === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Devbox">
          <div className="grid gap-3 px-3 py-3 sm:px-4">
            <p className="text-sm text-muted-foreground">
              Pick the AWS profile for the devbox account. Network settings are copied from an
              existing instance tagged Purpose=devbox.
            </p>
            <DevboxProfileForm submitLabel="Use profile" onEnabled={apply} />
          </div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const launchName = (newName ?? state?.nextName ?? "").trim();

  return (
    <SettingsPageContainer>
      <SettingsUnavailableGroup
        message={available ? undefined : "The devbox panel is available in the desktop app."}
      >
        <SettingsSection title="Devboxes">
          <SettingsRow
            title="AWS profile"
            description={
              state?.config
                ? `${state.config.awsProfile} · ${state.config.awsRegion}`
                : "Devbox account"
            }
            status={state ? <Status {...state.aws} /> : null}
            control={
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={anyBusy || changingProfile}
                  onClick={() => setChangingProfile(true)}
                >
                  Change
                </Button>
                <Button size="xs" variant="ghost" onClick={() => void load({ refresh: true })}>
                  Refresh
                </Button>
              </div>
            }
          />
          {changingProfile ? (
            <div className="px-3 py-3 sm:px-4">
              <DevboxProfileForm
                submitLabel="Switch profile"
                onCancel={() => setChangingProfile(false)}
                onEnabled={(next) => {
                  apply(next);
                  setChangingProfile(false);
                }}
              />
            </div>
          ) : null}
          <SettingsRow
            title="New devbox"
            description="Launches an instance with the same network, installs Teleport, Claude, and Codex, signs in GitHub, sets up the brain vault, and connects T3."
            control={
              <div className="flex items-center gap-1.5">
                <Input
                  size="sm"
                  className="w-32"
                  aria-label="New devbox name"
                  value={launchName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <Button
                  size="xs"
                  disabled={!state?.aws.ok || launchName.length === 0}
                  onClick={() => void run("launch", launchName)}
                >
                  Spin up devbox
                </Button>
              </div>
            }
          />
          <SettingsRow
            title="Sign-ins"
            description="AWS, Teleport, GitHub, Codex, and Claude on this Mac and each devbox."
            control={
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/machines" })}
              >
                Open Machines
              </Button>
            }
          />
          {state !== null && instances.length === 0 && pendingLaunches.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
              No instances tagged t3-managed=true yet.
            </p>
          ) : null}
        </SettingsSection>

        {instances.map((instance) => {
          const job = jobFor(instance.name);
          const busy = job?.running === true;
          const running = instance.state === "running";
          const t3Environment = t3EnvironmentFor(instance);
          return (
            <SettingsSection key={instance.instanceId} title={instance.name}>
              <SettingsRow
                title="Instance"
                description={`${instance.instanceId} · ${instance.instanceType} · ssh ${instance.name}`}
                status={<Status ok={running} detail={instance.state} />}
                control={
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {instance.state === "stopped" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void run("start", instance.name)}
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
                          onClick={() => void run("setup", instance.name)}
                        >
                          Re-run setup
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run("stop", instance.name)}
                        >
                          Stop
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={busy}
                      onClick={() => void run("terminate", instance.name)}
                    >
                      Terminate
                    </Button>
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
                      disabled={busy || connecting.has(instance.name)}
                      onClick={() => void connectT3(instance.name)}
                    >
                      {connecting.has(instance.name) ? <Spinner className="size-3" /> : null}
                      {t3Environment ? "Reconnect" : "Connect"}
                    </Button>
                  }
                />
              ) : null}
              {job ? <JobLog job={job} /> : null}
            </SettingsSection>
          );
        })}

        {pendingLaunches.map((job) => (
          <SettingsSection key={job.devbox} title={job.devbox}>
            <JobLog job={job} />
          </SettingsSection>
        ))}
      </SettingsUnavailableGroup>
    </SettingsPageContainer>
  );
}
