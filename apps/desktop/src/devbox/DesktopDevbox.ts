import type {
  DesktopDevboxAction,
  DesktopDevboxState,
  DesktopDevboxStateOptions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  DEVBOX,
  DEVBOX_BOOTSTRAP_SCRIPT,
  DEVBOX_BRAIN_SCRIPT,
  DEVBOX_HEALTH_SCRIPT,
  awsArgs,
  buildSshConfigBlock,
  buildUserData,
  describeManagedInstanceArgs,
  devboxPath,
  parseDevboxHealth,
  parseManagedInstance,
  runInstancesArgs,
  upsertSshConfigBlock,
  type DevboxInstance,
} from "./devboxPlan.ts";

const MAX_LOG_LINES = 400;
const SSM_ONLINE_TIMEOUT = Duration.minutes(10);
const SSH_READY_TIMEOUT = Duration.minutes(5);

type Job = NonNullable<DesktopDevboxState["job"]>;
type Checks = DesktopDevboxState["checks"];

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

class DevboxStepError extends Error {}

export class DesktopDevbox extends Context.Service<
  DesktopDevbox,
  {
    readonly getState: (options?: DesktopDevboxStateOptions) => Effect.Effect<DesktopDevboxState>;
    readonly run: (action: DesktopDevboxAction) => Effect.Effect<DesktopDevboxState>;
  }
>()("@t3tools/desktop/devbox/DesktopDevbox") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const layerScope = yield* Effect.scope;

  const home = environment.homeDirectory;
  const commandEnv = { PATH: devboxPath(home, process.env.PATH) };
  const sshConfigPath = path.join(home, ".ssh", "config");

  const job = yield* Ref.make<Job | null>(null);
  const aws = yield* Ref.make<{
    readonly aws: DesktopDevboxState["aws"];
    readonly instance: DevboxInstance | null;
  }>({ aws: { ok: false, detail: "Not checked yet" }, instance: null });
  const checks = yield* Ref.make<Checks>(null);

  const log = (line: string) =>
    Ref.update(job, (current) =>
      current === null
        ? current
        : { ...current, log: [...current.log, line].slice(-MAX_LOG_LINES) },
    );

  /** Runs a local command; `echo` streams its output into the job log. */
  const runCommand = (
    command: string,
    args: readonly string[],
    options: { readonly stdin?: string; readonly echo?: boolean } = {},
  ): Effect.Effect<CommandResult> =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, [...args], {
            env: commandEnv,
            extendEnv: true,
            stdin: {
              stream:
                options.stdin === undefined
                  ? Stream.empty
                  : Stream.encodeText(Stream.make(options.stdin)),
              endOnDone: true,
            },
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
          stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runFold(
              () => [] as string[],
              (lines, line) => [...lines, line],
            ),
            Effect.tap((lines) =>
              options.echo ? Effect.forEach(lines, log, { discard: true }) : Effect.void,
            ),
          );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { exitCode: Number(exitCode), stdout: stdout.join("\n"), stderr: stderr.join("\n") };
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({ exitCode: 127, stdout: "", stderr: `${command}: ${String(error)}` }),
      ),
    );

  const require = (result: CommandResult, what: string) =>
    result.exitCode === 0
      ? Effect.succeed(result.stdout)
      : Effect.fail(
          new DevboxStepError(`${what} failed: ${(result.stderr || result.stdout).slice(-600)}`),
        );

  const awsJson = (args: string[], what: string) =>
    runCommand("aws", args).pipe(
      Effect.flatMap((result) => require(result, what)),
      Effect.map((stdout) => JSON.parse(stdout) as unknown),
    );

  const ssh = (
    remote: readonly string[],
    options: { readonly stdin?: string; readonly echo?: boolean },
  ) =>
    runCommand(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=60", DEVBOX.sshAlias, ...remote],
      options,
    );

  const refreshAws = Effect.gen(function* () {
    const identity = yield* runCommand("aws", awsArgs("sts", "get-caller-identity"));
    if (identity.exitCode !== 0) {
      const expired = /sso|token|expired|login/iu.test(identity.stderr);
      yield* Ref.set(aws, {
        aws: {
          ok: false,
          detail: expired
            ? `AWS SSO session for ${DEVBOX.awsProfile} expired`
            : identity.stderr.slice(-300) || "aws CLI unavailable",
        },
        instance: null,
      });
      return;
    }
    const arn = (JSON.parse(identity.stdout) as { Arn?: string }).Arn ?? DEVBOX.awsProfile;
    const described = yield* runCommand("aws", describeManagedInstanceArgs());
    yield* Ref.set(aws, {
      aws: { ok: true, detail: arn.split("/").slice(-1)[0] ?? arn },
      instance: described.exitCode === 0 ? parseManagedInstance(described.stdout) : null,
    });
  });

  const refreshChecks = Effect.gen(function* () {
    const instance = (yield* Ref.get(aws)).instance;
    if (instance?.state !== "running") {
      yield* Ref.set(checks, null);
      return;
    }
    const result = yield* ssh(["bash", "-s"], { stdin: DEVBOX_HEALTH_SCRIPT });
    const health = yield* Effect.try(() => parseDevboxHealth(result.stdout)).pipe(
      Effect.orElseSucceed(() => {
        const detail = (result.stderr || "Could not reach the devbox over SSH").slice(-300);
        const unreachable = { ok: false, detail };
        return { github: unreachable, claude: unreachable, codex: unreachable, brain: unreachable };
      }),
    );
    yield* Ref.set(checks, health);
  });

  const snapshot = Effect.gen(function* () {
    const current = yield* Ref.get(aws);
    return {
      aws: current.aws,
      instance: current.instance,
      sshAlias: DEVBOX.sshAlias,
      job: yield* Ref.get(job),
      checks: yield* Ref.get(checks),
    } satisfies DesktopDevboxState;
  });

  const managedInstance = Effect.gen(function* () {
    yield* refreshAws;
    const current = yield* Ref.get(aws);
    if (!current.aws.ok) {
      return yield* Effect.fail(new DevboxStepError(current.aws.detail));
    }
    return current.instance;
  });

  const requireInstance = managedInstance.pipe(
    Effect.flatMap((instance) =>
      instance === null
        ? Effect.fail(new DevboxStepError("No devbox exists yet."))
        : Effect.succeed(instance),
    ),
  );

  const writeSshConfig = (instanceId: string | null) =>
    Effect.gen(function* () {
      const existing = yield* fs.readFileString(sshConfigPath).pipe(Effect.orElseSucceed(() => ""));
      const next = upsertSshConfigBlock(
        existing,
        instanceId === null ? null : buildSshConfigBlock(instanceId),
      );
      if (next === existing) return;
      yield* fs.makeDirectory(path.dirname(sshConfigPath), { recursive: true });
      if (existing.length > 0) {
        yield* fs.writeFileString(`${sshConfigPath}.t3-devbox.bak`, existing);
      }
      yield* fs.writeFileString(sshConfigPath, next);
      yield* log(
        instanceId === null
          ? `Removed ${DEVBOX.sshAlias} from ~/.ssh/config`
          : `~/.ssh/config: ${DEVBOX.sshAlias} → ${instanceId} over SSM`,
      );
    }).pipe(
      Effect.mapError((error) => new DevboxStepError(`Updating ~/.ssh/config failed: ${error}`)),
    );

  const waitFor = (what: string, timeout: Duration.Duration, probe: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      yield* log(`Waiting for ${what}…`);
      const deadline = Date.now() + Duration.toMillis(timeout);
      while (!(yield* probe)) {
        if (Date.now() > deadline) {
          return yield* Effect.fail(new DevboxStepError(`Timed out waiting for ${what}.`));
        }
        // AWS offers no push notification for SSM registration, so this polls.
        yield* Effect.sleep(Duration.seconds(10));
      }
      yield* log(`${what}: ready`);
    });

  const setup = (instance: DevboxInstance) =>
    Effect.gen(function* () {
      if (instance.state !== "running") {
        return yield* Effect.fail(
          new DevboxStepError(`The devbox is ${instance.state}; start it first.`),
        );
      }
      yield* writeSshConfig(instance.instanceId);
      yield* waitFor(
        "SSM agent",
        SSM_ONLINE_TIMEOUT,
        runCommand(
          "aws",
          awsArgs(
            "ssm",
            "describe-instance-information",
            "--filters",
            `Key=InstanceIds,Values=${instance.instanceId}`,
          ),
        ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.includes('"Online"'))),
      );
      // cloud-init installs the key shortly after SSM registers; retry until it lands.
      yield* waitFor(
        "SSH login",
        SSH_READY_TIMEOUT,
        ssh(["true"], {}).pipe(Effect.map((result) => result.exitCode === 0)),
      );

      yield* log("Installing packages, Claude Code, and Codex…");
      yield* require(yield* ssh(["bash", "-s"], {
        stdin: DEVBOX_BOOTSTRAP_SCRIPT,
        echo: true,
      }), "Bootstrap");

      yield* log("Signing GitHub in with this Mac's gh credential…");
      const token = yield* require(yield* runCommand("gh", [
        "auth",
        "token",
      ]), "Reading the local gh token");
      yield* require(yield* ssh(["gh auth login -h github.com --with-token && gh auth setup-git"], {
        stdin: `${token.trim()}\n`,
      }), "GitHub login on the devbox");

      yield* log("Setting up the brain vault…");
      yield* require(yield* ssh(["bash", "-s"], {
        stdin: DEVBOX_BRAIN_SCRIPT,
        echo: true,
      }), "Brain setup");
      yield* refreshChecks;
    });

  const launch = Effect.gen(function* () {
    const existing = yield* managedInstance;
    if (existing !== null) {
      return yield* Effect.fail(
        new DevboxStepError(`A devbox already exists (${existing.instanceId}, ${existing.state}).`),
      );
    }
    const publicKey = yield* fs
      .readFileString(`${path.join(home, ".ssh", "id_ed25519")}.pub`)
      .pipe(Effect.mapError(() => new DevboxStepError("~/.ssh/id_ed25519.pub is missing.")));
    const parameter = (yield* awsJson(
      awsArgs("ssm", "get-parameter", "--name", DEVBOX.amiParameter),
      "Resolving the Amazon Linux AMI",
    )) as { Parameter?: { Value?: string } };
    const amiId = parameter.Parameter?.Value;
    if (!amiId) {
      return yield* Effect.fail(new DevboxStepError("The Amazon Linux AMI parameter was empty."));
    }
    yield* log(`Launching ${DEVBOX.instanceType} from ${amiId}…`);
    const launched = (yield* awsJson(
      runInstancesArgs({ amiId, userData: buildUserData(publicKey) }),
      "Launching the instance",
    )) as { Instances?: Array<{ InstanceId?: string }> };
    const instanceId = launched.Instances?.[0]?.InstanceId;
    if (!instanceId) {
      return yield* Effect.fail(new DevboxStepError("run-instances returned no instance id."));
    }
    yield* log(`Launched ${instanceId}; waiting for it to run…`);
    yield* require(yield* runCommand(
      "aws",
      awsArgs("ec2", "wait", "instance-running", "--instance-ids", instanceId),
    ), "Waiting for the instance");
    yield* setup(yield* requireInstance);
  });

  const changePower = (verb: "start" | "stop" | "terminate") =>
    Effect.gen(function* () {
      const instance = yield* requireInstance;
      yield* log(`${verb} ${instance.instanceId}…`);
      yield* require(yield* runCommand(
        "aws",
        awsArgs("ec2", `${verb}-instances`, "--instance-ids", instance.instanceId),
      ), `${verb} instance`);
      const waiter = {
        start: "instance-running",
        stop: "instance-stopped",
        terminate: "instance-terminated",
      }[verb];
      yield* require(yield* runCommand(
        "aws",
        awsArgs("ec2", "wait", waiter, "--instance-ids", instance.instanceId),
      ), `Waiting for ${waiter}`);
      if (verb === "terminate") {
        yield* writeSshConfig(null);
      }
      yield* Ref.set(checks, null);
    });

  const actions: Record<DesktopDevboxAction, Effect.Effect<void, DevboxStepError>> = {
    "aws-login": runCommand("aws", ["sso", "login", "--profile", DEVBOX.awsProfile], {
      echo: true,
    }).pipe(
      Effect.flatMap((result) => require(result, "AWS SSO login")),
      Effect.asVoid,
    ),
    launch,
    setup: requireInstance.pipe(Effect.flatMap(setup)),
    start: changePower("start"),
    stop: changePower("stop"),
    terminate: changePower("terminate"),
  };

  const run = (action: DesktopDevboxAction) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(job);
      if (current?.running) {
        return yield* snapshot;
      }
      yield* Ref.set(job, { action, running: true, log: [], error: null });
      yield* actions[action].pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Ref.update(job, (value) => value && { ...value, running: false, error: error.message }),
          onSuccess: () =>
            log("Done.").pipe(
              Effect.andThen(Ref.update(job, (value) => value && { ...value, running: false })),
            ),
        }),
        Effect.ensuring(refreshAws),
        Effect.forkIn(layerScope),
      );
      return yield* snapshot;
    });

  const getState = (options: DesktopDevboxStateOptions = {}) =>
    Effect.gen(function* () {
      if (options.refresh || options.checkHealth) {
        yield* refreshAws;
      }
      if (options.checkHealth) {
        yield* refreshChecks;
      }
      return yield* snapshot;
    });

  return DesktopDevbox.of({ getState, run });
});

export const layer = Layer.effect(DesktopDevbox, make);
