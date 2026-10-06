// @effect-diagnostics globalErrorInEffectFailure:off anyUnknownInErrorContext:off preferSchemaOverJson:off globalDateInEffect:off - AWS/SSH CLI failures surface as plain messages in the devbox panel.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- login ids need only uniqueness; this layer does not require Crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import {
  DesktopDevboxConfigSchema,
  type DesktopAwsLoginGuardInput,
  type DesktopAwsLoginStatus,
  type DesktopAwsProfile,
  type DesktopDevboxAction,
  type DesktopDevboxActionInput,
  type DesktopDevboxConfig,
  type DesktopDevboxEnableInput,
  type DesktopDevboxLogin,
  type DesktopDevboxLoginProvider,
  type DesktopDevboxLoginTarget,
  type DesktopSignInAwsProfileInput,
  type DesktopDevboxLoginStart,
  type DesktopDevboxState,
  type DesktopDevboxStateOptions,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  CODEX_CALLBACK_PORT,
  DEVBOX,
  DEVBOX_BOOTSTRAP_SCRIPT,
  DEVBOX_BRAIN_SCRIPT,
  MERGE_AWS_CONFIG_SCRIPT,
  awsArgs,
  awsProfileSections,
  buildHealthScript,
  buildUserData,
  describeManagedInstanceArgs,
  describeTemplateInstanceArgs,
  devboxPath,
  extractCodes,
  extractLinks,
  loginCommand,
  MAC_TARGET,
  nextDevboxName,
  parseAwsProfiles,
  parseDevboxHealth,
  parseLaunchTemplate,
  parseManagedInstances,
  runInstancesArgs,
  sshBlockAliases,
  ssoSessionExpiry,
  stripTerminal,
  syncSshConfigHosts,
  validateAwsProfileName,
  validateDevboxName,
  type DevboxHealth,
  type DevboxInstance,
} from "./devboxPlan.ts";

const MAX_LOG_LINES = 400;
const MAX_LOGIN_OUTPUT = 4_000;
const LOGIN_TIMEOUT = Duration.minutes(10);
const SSM_ONLINE_TIMEOUT = Duration.minutes(10);
const SSH_READY_TIMEOUT = Duration.minutes(5);
const AWS_LOGIN_CHECK_TIMEOUT = Duration.seconds(20);

type Job = DesktopDevboxState["jobs"][number];

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

class DevboxStepError extends Error {}

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopDevboxConfigSchema));

const freePort = Effect.callback<number>((resume) => {
  const server = NodeNet.createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

export class DesktopDevbox extends Context.Service<
  DesktopDevbox,
  {
    readonly getState: (options?: DesktopDevboxStateOptions) => Effect.Effect<DesktopDevboxState>;
    readonly run: (input: DesktopDevboxActionInput) => Effect.Effect<DesktopDevboxState, Error>;
    readonly listAwsProfiles: Effect.Effect<readonly DesktopAwsProfile[]>;
    readonly setEnabled: (
      input: DesktopDevboxEnableInput,
    ) => Effect.Effect<DesktopDevboxState, Error>;
    readonly startLogin: (
      input: DesktopDevboxLoginStart,
    ) => Effect.Effect<DesktopDevboxState, Error>;
    readonly setSignInAwsProfile: (
      input: DesktopSignInAwsProfileInput,
    ) => Effect.Effect<DesktopDevboxState>;
    readonly getAwsLoginStatus: Effect.Effect<DesktopAwsLoginStatus>;
    readonly setAwsLoginGuard: (
      input: DesktopAwsLoginGuardInput,
    ) => Effect.Effect<DesktopAwsLoginStatus, Error>;
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
  const awsConfigPath = path.join(home, ".aws", "config");
  // Machine-local on purpose: a personal Mac never shows the panel unless it is turned on there.
  const configPath = path.join(environment.stateDir, "devbox.json");

  const savedConfig = yield* fs.readFileString(configPath).pipe(
    Effect.map((text) => Option.getOrNull(decodeConfig(text))),
    Effect.orElseSucceed(() => null),
  );
  const config = yield* Ref.make<DesktopDevboxConfig | null>(savedConfig);
  const jobs = yield* Ref.make<ReadonlyMap<string, Job>>(new Map());
  const aws = yield* Ref.make<{
    readonly aws: DesktopDevboxState["aws"];
    readonly instances: readonly DevboxInstance[];
    /** Hand-written hosts in the shared ssh_config block, which new devboxes must not reuse. */
    readonly sshAliases: readonly string[];
  }>({ aws: { ok: false, detail: "Not checked yet" }, instances: [], sshAliases: [] });
  const checks = yield* Ref.make<DesktopDevboxState["checks"]>({});
  const checking = yield* Ref.make(0);
  // Sign-ins on a Mac without a devbox still need a profile for AWS SSO.
  const machinesPath = path.join(environment.stateDir, "machines.json");
  const readSavedAwsProfile = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => {
        const value = (JSON.parse(text) as { awsProfile?: unknown }).awsProfile;
        return typeof value === "string" ? value : null;
      }),
      Effect.orElseSucceed(() => null),
    );
  const machinesAwsProfile = yield* Ref.make<string | null>(
    yield* readSavedAwsProfile(machinesPath),
  );
  // "Require AWS login" is machine-local and off unless this file exists.
  const awsLoginPath = path.join(environment.stateDir, "aws-login.json");
  const awsLoginProfile = yield* Ref.make<string | null>(yield* readSavedAwsProfile(awsLoginPath));
  const signInAwsProfile = Effect.gen(function* () {
    return (yield* Ref.get(config))?.awsProfile ?? (yield* Ref.get(machinesAwsProfile));
  });
  const logins = yield* Ref.make<ReadonlyArray<DesktopDevboxLogin>>([]);
  // Teleport callback ports held by running devbox sign-ins, so two never pick the same one.
  const callbackPorts = yield* Ref.make<ReadonlySet<number>>(new Set());

  const updateJob = (devbox: string, update: (job: Job) => Job) =>
    Ref.update(jobs, (all) => {
      const current = all.get(devbox);
      return current === undefined ? all : new Map(all).set(devbox, update(current));
    });

  const log = (devbox: string, line: string) =>
    updateJob(devbox, (current) => ({
      ...current,
      log: [...current.log, line].slice(-MAX_LOG_LINES),
    }));

  /** Runs a local command; `echo` streams its output into that devbox's job log. */
  const runCommand = (
    command: string,
    args: readonly string[],
    options: { readonly stdin?: string; readonly echo?: string } = {},
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
              options.echo === undefined
                ? Effect.void
                : Effect.forEach(lines, (line) => log(options.echo!, line), { discard: true }),
            ),
          );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return {
          exitCode: Number(exitCode),
          stdout: stdout.join("\n"),
          stderr: stderr.join("\n"),
        };
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

  const requireConfig = Ref.get(config).pipe(
    Effect.flatMap((current) =>
      current === null
        ? Effect.fail(new DevboxStepError("Turn on the devbox panel in Settings → General first."))
        : Effect.succeed(current),
    ),
  );

  const awsJson = (args: string[], what: string) =>
    runCommand("aws", args).pipe(
      Effect.flatMap((result) => require(result, what)),
      Effect.map((stdout) => JSON.parse(stdout) as unknown),
    );

  const ssh = (
    devbox: string,
    remote: readonly string[],
    options: { readonly stdin?: string; readonly echo?: string } = {},
  ) =>
    runCommand(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=60", devbox, ...remote],
      options,
    );

  const readSshConfig = fs.readFileString(sshConfigPath).pipe(Effect.orElseSucceed(() => ""));

  const refreshAws = Effect.gen(function* () {
    const current = yield* Ref.get(config);
    const sshAliases = sshBlockAliases(yield* readSshConfig);
    if (current === null) {
      yield* Ref.set(aws, {
        aws: { ok: false, detail: "Devbox panel is off" },
        instances: [],
        sshAliases,
      });
      return;
    }
    const identity = yield* runCommand("aws", awsArgs(current, "sts", "get-caller-identity"));
    if (identity.exitCode !== 0) {
      const expired = /sso|token|expired|login/iu.test(identity.stderr);
      yield* Ref.set(aws, {
        aws: {
          ok: false,
          detail: expired
            ? `AWS SSO session for ${current.awsProfile} expired`
            : identity.stderr.slice(-300) || "aws CLI unavailable",
        },
        instances: [],
        sshAliases,
      });
      return;
    }
    const arn = (JSON.parse(identity.stdout) as { Arn?: string }).Arn ?? current.awsProfile;
    const described = yield* runCommand("aws", describeManagedInstanceArgs(current));
    yield* Ref.set(aws, {
      aws:
        described.exitCode === 0
          ? { ok: true, detail: arn.split("/").at(-1) ?? arn }
          : { ok: false, detail: described.stderr.slice(-300) || "Could not list instances" },
      instances: described.exitCode === 0 ? parseManagedInstances(described.stdout) : [],
      sshAliases,
    });
  });

  const readHealth = (result: CommandResult, fallback: string): DevboxHealth => {
    try {
      return parseDevboxHealth(result.stdout);
    } catch {
      const check = { ok: false, detail: (result.stderr || fallback).slice(-300), expiresAt: null };
      return {
        aws: check,
        teleport: check,
        github: check,
        claude: check,
        codex: check,
        brain: check,
      };
    }
  };

  /** Re-reads sign-in health on one machine, or on this Mac and every devbox when no target is given. */
  const refreshChecks = (target?: DesktopDevboxLoginTarget) =>
    Effect.gen(function* () {
      const script = buildHealthScript(yield* signInAwsProfile);
      const targets = [
        MAC_TARGET,
        ...(yield* Ref.get(aws)).instances.map((instance) => instance.name),
      ].filter((name) => target === undefined || name === target);
      const running = new Set(
        (yield* Ref.get(aws)).instances
          .filter((instance) => instance.state === "running")
          .map((instance) => instance.name),
      );
      const read = (name: string): Effect.Effect<DevboxHealth | null> =>
        name === MAC_TARGET
          ? runCommand("bash", ["-s"], { stdin: script }).pipe(
              Effect.map((result) => readHealth(result, "The local health check failed")),
            )
          : running.has(name)
            ? ssh(name, ["bash", "-s"], { stdin: script }).pipe(
                Effect.map((result) => readHealth(result, `Could not reach ${name} over SSH`)),
              )
            : Effect.succeed(null);
      const results = yield* Effect.forEach(
        targets,
        (name) => read(name).pipe(Effect.map((health) => [name, health] as const)),
        { concurrency: "unbounded" },
      );
      yield* Ref.update(checks, (current) => ({ ...current, ...Object.fromEntries(results) }));
    }).pipe(Effect.ensuring(Ref.update(checking, (count) => count - 1)), (effect) =>
      Ref.update(checking, (count) => count + 1).pipe(Effect.andThen(effect)),
    );

  const snapshot = Effect.gen(function* () {
    const current = yield* Ref.get(aws);
    const currentJobs = [...(yield* Ref.get(jobs)).values()];
    return {
      config: yield* Ref.get(config),
      aws: current.aws,
      instances: current.instances,
      nextName: nextDevboxName([
        ...current.instances.map((instance) => instance.name),
        ...current.sshAliases,
        ...currentJobs.map((job) => job.devbox),
      ]),
      jobs: currentJobs,
      checks: yield* Ref.get(checks),
      signInAwsProfile: yield* signInAwsProfile,
      checking: (yield* Ref.get(checking)) > 0,
      logins: yield* Ref.get(logins),
    } satisfies DesktopDevboxState;
  });

  const managedInstances = Effect.gen(function* () {
    yield* refreshAws;
    const current = yield* Ref.get(aws);
    if (!current.aws.ok) {
      return yield* Effect.fail(new DevboxStepError(current.aws.detail));
    }
    return current.instances;
  });

  const requireInstance = (devbox: string) =>
    managedInstances.pipe(
      Effect.flatMap((instances) => {
        const instance = instances.find((entry) => entry.name === devbox);
        return instance === undefined
          ? Effect.fail(new DevboxStepError(`No devbox named ${devbox}.`))
          : Effect.succeed(instance);
      }),
    );

  /** Adds or refreshes one devbox's alias, or drops it once the instance is terminated. */
  const writeSshConfig = (instance: DevboxInstance, change: "upsert" | "remove") =>
    Effect.gen(function* () {
      const current = yield* requireConfig;
      const existing = yield* readSshConfig;
      const next =
        change === "upsert"
          ? syncSshConfigHosts(existing, current, [instance])
          : syncSshConfigHosts(existing, current, [], [instance.instanceId]);
      if (next === existing) return;
      yield* fs.makeDirectory(path.dirname(sshConfigPath), { recursive: true }).pipe(Effect.orDie);
      if (existing.length > 0) {
        yield* fs.writeFileString(`${sshConfigPath}.t3-devbox.bak`, existing).pipe(Effect.orDie);
      }
      yield* fs.writeFileString(sshConfigPath, next).pipe(Effect.orDie);
      yield* log(
        instance.name,
        change === "remove"
          ? `Removed ${instance.name} from ~/.ssh/config`
          : `~/.ssh/config: ${instance.name} → ${instance.instanceId} over SSM`,
      );
    });

  const waitFor = (
    devbox: string,
    what: string,
    timeout: Duration.Duration,
    probe: Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      yield* log(devbox, `Waiting for ${what}…`);
      const deadline = Date.now() + Duration.toMillis(timeout);
      while (!(yield* probe)) {
        if (Date.now() > deadline) {
          return yield* Effect.fail(new DevboxStepError(`Timed out waiting for ${what}.`));
        }
        // AWS offers no push notification for SSM registration, so this polls.
        yield* Effect.sleep(Duration.seconds(10));
      }
      yield* log(devbox, `${what}: ready`);
    });

  const githubToken = runCommand("gh", ["auth", "token"]).pipe(
    Effect.flatMap((result) => require(result, "Reading this Mac's gh credential")),
    Effect.map((token) => token.trim()),
  );

  const copyAwsProfile = (devbox: string, profile: string) =>
    Effect.gen(function* () {
      const text = yield* fs.readFileString(awsConfigPath).pipe(Effect.orElseSucceed(() => ""));
      const sections = awsProfileSections(text, profile);
      if (sections.length === 0) return;
      yield* require(yield* ssh(devbox, [MERGE_AWS_CONFIG_SCRIPT], {
        stdin: sections,
      }), "Copying the AWS profile");
    });

  const setup = (instance: DevboxInstance) =>
    Effect.gen(function* () {
      const current = yield* requireConfig;
      const devbox = instance.name;
      if (instance.state !== "running") {
        return yield* Effect.fail(
          new DevboxStepError(`${devbox} is ${instance.state}; start it first.`),
        );
      }
      yield* writeSshConfig(instance, "upsert");
      yield* waitFor(
        devbox,
        "SSM agent",
        SSM_ONLINE_TIMEOUT,
        runCommand(
          "aws",
          awsArgs(
            current,
            "ssm",
            "describe-instance-information",
            "--filters",
            `Key=InstanceIds,Values=${instance.instanceId}`,
          ),
        ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.includes('"Online"'))),
      );
      // cloud-init installs the key shortly after SSM registers; retry until it lands.
      yield* waitFor(
        devbox,
        "SSH login",
        SSH_READY_TIMEOUT,
        ssh(devbox, ["true"]).pipe(Effect.map((result) => result.exitCode === 0)),
      );

      yield* log(devbox, "Installing packages, Teleport, Claude Code, and Codex…");
      yield* require(yield* ssh(devbox, ["bash", "-s"], {
        stdin: DEVBOX_BOOTSTRAP_SCRIPT,
        echo: devbox,
      }), "Bootstrap");

      yield* log(devbox, `Copying the ${current.awsProfile} AWS profile…`);
      yield* copyAwsProfile(devbox, current.awsProfile);

      yield* log(devbox, "Signing GitHub in with this Mac's gh credential…");
      yield* require(yield* ssh(
        devbox,
        ["gh auth login -h github.com --with-token && gh auth setup-git"],
        {
          stdin: `${yield* githubToken}\n`,
        },
      ), "GitHub login on the devbox");

      yield* log(devbox, "Setting up the brain vault…");
      yield* require(yield* ssh(devbox, ["bash", "-s"], {
        stdin: DEVBOX_BRAIN_SCRIPT,
        echo: devbox,
      }), "Brain setup");
      yield* refreshChecks(devbox);
    });

  const launch = (devbox: string) =>
    Effect.gen(function* () {
      const current = yield* requireConfig;
      const publicKey = yield* fs
        .readFileString(`${path.join(home, ".ssh", "id_ed25519")}.pub`)
        .pipe(Effect.mapError(() => new DevboxStepError("~/.ssh/id_ed25519.pub is missing.")));
      const parameter = (yield* awsJson(
        awsArgs(current, "ssm", "get-parameter", "--name", DEVBOX.amiParameter),
        "Resolving the Amazon Linux AMI",
      )) as { Parameter?: { Value?: string } };
      const amiId = parameter.Parameter?.Value;
      if (!amiId) {
        return yield* Effect.fail(new DevboxStepError("The Amazon Linux AMI parameter was empty."));
      }
      yield* log(devbox, `Launching ${devbox} (${current.instanceType}) from ${amiId}…`);
      const launched = (yield* awsJson(
        runInstancesArgs({
          config: current,
          name: devbox,
          amiId,
          userData: buildUserData(publicKey),
        }),
        "Launching the instance",
      )) as { Instances?: Array<{ InstanceId?: string }> };
      const instanceId = launched.Instances?.[0]?.InstanceId;
      if (!instanceId) {
        return yield* Effect.fail(new DevboxStepError("run-instances returned no instance id."));
      }
      yield* log(devbox, `Launched ${instanceId}; waiting for it to run…`);
      yield* require(yield* runCommand(
        "aws",
        awsArgs(current, "ec2", "wait", "instance-running", "--instance-ids", instanceId),
      ), "Waiting for the instance");
      yield* setup(yield* requireInstance(devbox));
    });

  const changePower = (verb: "start" | "stop" | "terminate", devbox: string) =>
    Effect.gen(function* () {
      const current = yield* requireConfig;
      const instance = yield* requireInstance(devbox);
      yield* log(devbox, `${verb} ${instance.instanceId}…`);
      yield* require(yield* runCommand(
        "aws",
        awsArgs(current, "ec2", `${verb}-instances`, "--instance-ids", instance.instanceId),
      ), `${verb} instance`);
      const waiter = {
        start: "instance-running",
        stop: "instance-stopped",
        terminate: "instance-terminated",
      }[verb];
      yield* require(yield* runCommand(
        "aws",
        awsArgs(current, "ec2", "wait", waiter, "--instance-ids", instance.instanceId),
      ), `Waiting for ${waiter}`);
      if (verb === "terminate") {
        yield* writeSshConfig(instance, "remove");
      }
      yield* Ref.update(checks, (value) => ({ ...value, [devbox]: null }));
    });

  const actions: Record<
    DesktopDevboxAction,
    (devbox: string) => Effect.Effect<void, DevboxStepError>
  > = {
    launch,
    setup: (devbox) => requireInstance(devbox).pipe(Effect.flatMap(setup)),
    start: (devbox) => changePower("start", devbox),
    stop: (devbox) => changePower("stop", devbox),
    terminate: (devbox) => changePower("terminate", devbox),
  };

  /** A new devbox's name must be free in AWS and in the shared ssh_config block. */
  const checkNewName = (devbox: string) =>
    Effect.gen(function* () {
      const invalid = validateDevboxName(devbox);
      if (invalid !== null) return yield* Effect.fail(new DevboxStepError(invalid));
      yield* managedInstances;
      const current = yield* Ref.get(aws);
      if (current.instances.some((instance) => instance.name === devbox)) {
        return yield* Effect.fail(new DevboxStepError(`A devbox named ${devbox} already exists.`));
      }
      if (current.sshAliases.includes(devbox)) {
        return yield* Effect.fail(
          new DevboxStepError(`~/.ssh/config already has a ${devbox} host; choose another name.`),
        );
      }
    });

  const run = ({ action, devbox }: DesktopDevboxActionInput) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(jobs)).get(devbox)?.running) {
        return yield* snapshot;
      }
      if (action === "launch") yield* checkNewName(devbox);
      yield* Ref.update(jobs, (all) =>
        new Map(all).set(devbox, { devbox, action, running: true, log: [], error: null }),
      );
      yield* actions[action](devbox).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            updateJob(devbox, (value) => ({ ...value, running: false, error: error.message })),
          onSuccess: () =>
            log(devbox, "Done.").pipe(
              Effect.andThen(updateJob(devbox, (value) => ({ ...value, running: false }))),
            ),
        }),
        Effect.ensuring(refreshAws),
        Effect.forkIn(layerScope),
      );
      return yield* snapshot;
    }).pipe(Effect.mapError(toError));

  const getState = (options: DesktopDevboxStateOptions = {}) =>
    Effect.gen(function* () {
      if (options.refresh || options.checkHealth) {
        yield* refreshAws;
      }
      if (options.checkHealth) {
        yield* refreshChecks();
      }
      return yield* snapshot;
    });

  const listAwsProfiles = fs.readFileString(awsConfigPath).pipe(
    Effect.map(parseAwsProfiles),
    Effect.orElseSucceed(() => []),
  );

  const setEnabled = (input: DesktopDevboxEnableInput) =>
    Effect.gen(function* () {
      if (input === null) {
        yield* fs.remove(configPath).pipe(Effect.ignore);
        yield* Ref.set(config, null);
        yield* Ref.set(checks, {});
        yield* refreshAws;
        return yield* snapshot;
      }
      const invalid = validateAwsProfileName(input.awsProfile);
      if (invalid !== null) return yield* Effect.fail(new Error(invalid));
      // A typed name may live only in ~/.aws/credentials, so it need not be listed.
      const profile = (yield* listAwsProfiles).find((entry) => entry.name === input.awsProfile) ?? {
        name: input.awsProfile,
        region: null,
      };
      const target = { awsProfile: profile.name, awsRegion: profile.region ?? "us-east-1" };
      const described = yield* runCommand("aws", describeTemplateInstanceArgs(target));
      if (described.exitCode !== 0) {
        return yield* Effect.fail(
          new Error(
            /sso|token|expired/iu.test(described.stderr)
              ? `Sign in to AWS first: aws sso login --profile ${profile.name}`
              : `Could not read EC2 in ${profile.name}: ${described.stderr.slice(-300)}`,
          ),
        );
      }
      const template = parseLaunchTemplate(described.stdout);
      if (template === null) {
        return yield* Effect.fail(
          new Error(
            `No instance tagged Purpose=devbox in ${profile.name} to copy the network from.`,
          ),
        );
      }
      const next = { ...target, ...template } satisfies DesktopDevboxConfig;
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true }).pipe(Effect.orDie);
      yield* fs.writeFileString(configPath, JSON.stringify(next, null, 2)).pipe(Effect.orDie);
      if ((yield* Ref.get(config))?.awsProfile !== next.awsProfile) yield* Ref.set(checks, {});
      yield* Ref.set(config, next);
      // Remembered so the picker offers it again after the panel is turned off.
      yield* setSignInAwsProfile({ awsProfile: next.awsProfile });
      yield* refreshAws;
      return yield* snapshot;
    });

  const updateLogin = (id: string, update: (login: DesktopDevboxLogin) => DesktopDevboxLogin) =>
    Ref.update(logins, (all) => all.map((login) => (login.id === id ? update(login) : login)));

  /** This Mac's credential for providers the devbox copies instead of signing in on its own. */
  const macCredential = (provider: DesktopDevboxLoginProvider) =>
    provider === "github"
      ? githubToken
      : provider === "claude"
        ? runCommand("security", [
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-a",
            process.env.USER ?? "",
            "-w",
          ]).pipe(Effect.flatMap((result) => require(result, "Reading this Mac's Claude session")))
        : Effect.succeed(undefined);

  const startLogin = (input: DesktopDevboxLoginStart) =>
    Effect.gen(function* () {
      if (input.awsProfile !== undefined && (yield* Ref.get(config)) === null) {
        yield* setSignInAwsProfile({ awsProfile: input.awsProfile });
      }
      const awsProfile = input.awsProfile ?? (yield* signInAwsProfile);
      // The health check reads the sign-in profile, so it cannot confirm another one.
      const verifiable = input.provider !== "aws" || awsProfile === (yield* signInAwsProfile);
      const onDevbox = input.target !== MAC_TARGET;
      if (onDevbox && (yield* Ref.get(config)) === null) {
        return yield* Effect.fail(
          new DevboxStepError("Turn on the devbox panel in Settings → General first."),
        );
      }
      if (
        onDevbox &&
        !(yield* Ref.get(aws)).instances.some(
          (instance) => instance.name === input.target && instance.state === "running",
        )
      ) {
        return yield* Effect.fail(new DevboxStepError(`${input.target} is not running.`));
      }
      if (input.provider === "aws" && awsProfile === null) {
        return yield* Effect.fail(new DevboxStepError("Choose an AWS profile first."));
      }
      const active = (yield* Ref.get(logins)).filter(
        (login) =>
          login.phase === "connecting" || login.phase === "approve" || login.phase === "verifying",
      );
      if (
        active.some((login) => login.target === input.target && login.provider === input.provider)
      ) {
        return yield* snapshot;
      }
      const codex = active.find((login) => login.provider === "codex");
      if (input.provider === "codex" && codex) {
        return yield* Effect.fail(
          new DevboxStepError(
            `The Codex sign-in on ${codex.target} is using port ${CODEX_CALLBACK_PORT}; finish it first.`,
          ),
        );
      }
      if (onDevbox && input.provider === "aws" && awsProfile !== null) {
        yield* copyAwsProfile(input.target, awsProfile);
      }
      const credential = onDevbox ? yield* macCredential(input.provider) : undefined;
      const reserved = yield* Ref.get(callbackPorts);
      let callbackPort = yield* freePort;
      while (reserved.has(callbackPort)) callbackPort = yield* freePort;
      const holdsPort = onDevbox && input.provider === "teleport";
      if (holdsPort) yield* Ref.update(callbackPorts, (ports) => new Set(ports).add(callbackPort));
      const releasePort = Ref.update(callbackPorts, (ports) => {
        const next = new Set(ports);
        next.delete(callbackPort);
        return next;
      });
      const command = loginCommand({
        target: input.target,
        provider: input.provider,
        awsProfile: awsProfile ?? "default",
        callbackPort,
        ...(credential === undefined ? {} : { credential }),
      });
      const id = NodeCrypto.randomUUID();
      const inputs = yield* Queue.unbounded<string>();
      yield* Ref.update(logins, (all) => [
        ...all.filter(
          (login) => login.target !== input.target || login.provider !== input.provider,
        ),
        {
          id,
          target: input.target,
          provider: input.provider,
          phase: "connecting" as const,
          opensBrowser: command.opensBrowser,
          links: [],
          codes: [],
          output: "",
        },
      ]);

      let output = "";
      const append = (chunk: string) =>
        Effect.gen(function* () {
          output = (output + chunk).slice(-MAX_LOGIN_OUTPUT * 4);
          // gh waits for Enter before it opens the device page.
          if (/Press Enter to open/iu.test(chunk)) yield* Queue.offer(inputs, "\n");
          const links = extractLinks(output);
          yield* updateLogin(id, (login) => ({
            ...login,
            phase: login.phase === "connecting" && links.length > 0 ? "approve" : login.phase,
            links,
            codes: extractCodes(output),
          }));
        });
      const session = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command.command, [...command.args], {
              env: { ...commandEnv, GH_NO_UPDATE_NOTIFIER: "1" },
              extendEnv: true,
              // A streamed credential is read to end of input; interactive CLIs keep stdin open.
              stdin:
                command.stdin === undefined
                  ? { stream: Stream.encodeText(Stream.fromQueue(inputs)), endOnDone: false }
                  : { stream: Stream.encodeText(Stream.make(command.stdin)), endOnDone: true },
              stdout: "pipe",
              stderr: "pipe",
            }),
          );
          const pump = (stream: Stream.Stream<Uint8Array, unknown>) =>
            stream.pipe(Stream.decodeText(), Stream.runForEach(append));
          const [, , exitCode] = yield* Effect.all(
            [pump(handle.stdout), pump(handle.stderr), handle.exitCode],
            { concurrency: "unbounded" },
          );
          return Number(exitCode);
        }),
      ).pipe(
        Effect.timeoutOption(LOGIN_TIMEOUT),
        Effect.map((exitCode) => Option.getOrElse(exitCode, () => 124)),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            output += `\n${Cause.pretty(cause)}`;
            return 1;
          }),
        ),
        // The CLI exits once the browser callback lands; confirm with a fresh health read.
        Effect.flatMap((exitCode) =>
          Effect.gen(function* () {
            const tail = stripTerminal(output).trim().slice(-MAX_LOGIN_OUTPUT);
            if (exitCode !== 0) {
              yield* updateLogin(id, (login) => ({ ...login, phase: "failed", output: tail }));
              return;
            }
            if (!verifiable) {
              yield* updateLogin(id, (login) => ({ ...login, phase: "done", output: tail }));
              return;
            }
            yield* updateLogin(id, (login) => ({ ...login, phase: "verifying", output: tail }));
            yield* refreshChecks(input.target);
            const result = (yield* Ref.get(checks))[input.target]?.[input.provider];
            yield* updateLogin(id, (login) => ({
              ...login,
              phase: result?.ok ? "done" : "failed",
              output: result?.ok ? tail : (result?.detail ?? tail),
            }));
          }),
        ),
      );
      yield* Effect.forkIn(
        holdsPort ? session.pipe(Effect.ensuring(releasePort)) : session,
        layerScope,
      );
      return yield* snapshot;
    }).pipe(Effect.mapError(toError));

  const setSignInAwsProfile = (input: DesktopSignInAwsProfileInput) =>
    Effect.gen(function* () {
      yield* fs
        .writeFileString(machinesPath, JSON.stringify({ awsProfile: input.awsProfile }, null, 2))
        .pipe(Effect.orDie);
      yield* Ref.set(machinesAwsProfile, input.awsProfile);
      return yield* snapshot;
    });

  const ssoCacheDir = path.join(home, ".aws", "sso", "cache");
  const readSsoExpiry = (profile: string) =>
    Effect.gen(function* () {
      const files = (yield* fs.readDirectory(ssoCacheDir)).filter((name) => name.endsWith(".json"));
      const cacheFiles = yield* Effect.forEach(files, (name) =>
        fs.readFileString(path.join(ssoCacheDir, name)).pipe(Effect.orElseSucceed(() => "")),
      );
      const configText = yield* fs.readFileString(awsConfigPath);
      return ssoSessionExpiry(configText, profile, cacheFiles);
    }).pipe(Effect.orElseSucceed(() => null));

  const getAwsLoginStatus = Effect.gen(function* () {
    const profile = yield* Ref.get(awsLoginProfile);
    if (profile === null) {
      return { awsProfile: null, ok: false, detail: "Off", expiresAt: null };
    }
    const [identity, expiresAt] = yield* Effect.all(
      [
        runCommand("aws", [
          "sts",
          "get-caller-identity",
          "--profile",
          profile,
          "--query",
          "Arn",
          "--output",
          "text",
        ]).pipe(
          Effect.timeoutOption(AWS_LOGIN_CHECK_TIMEOUT),
          Effect.map(
            Option.getOrElse(() => ({ exitCode: 124, stdout: "", stderr: "aws sts timed out" })),
          ),
        ),
        readSsoExpiry(profile),
      ],
      { concurrency: "unbounded" },
    );
    const arn = identity.stdout.trim();
    if (identity.exitCode === 0 && arn.startsWith("arn:")) {
      return { awsProfile: profile, ok: true, detail: arn.split("/").at(-1) ?? arn, expiresAt };
    }
    return {
      awsProfile: profile,
      ok: false,
      detail: /sso|token|expired|login/iu.test(identity.stderr)
        ? "SSO session expired or missing"
        : identity.stderr.slice(-300) || "aws CLI unavailable",
      expiresAt,
    };
  });

  const setAwsLoginGuard = (input: DesktopAwsLoginGuardInput) =>
    Effect.gen(function* () {
      if (input === null) {
        yield* fs.remove(awsLoginPath).pipe(Effect.ignore);
        yield* Ref.set(awsLoginProfile, null);
        return yield* getAwsLoginStatus;
      }
      const invalid = validateAwsProfileName(input.awsProfile);
      if (invalid !== null) return yield* Effect.fail(new Error(invalid));
      yield* fs.makeDirectory(path.dirname(awsLoginPath), { recursive: true }).pipe(Effect.orDie);
      yield* fs
        .writeFileString(awsLoginPath, JSON.stringify({ awsProfile: input.awsProfile }, null, 2))
        .pipe(Effect.orDie);
      yield* Ref.set(awsLoginProfile, input.awsProfile);
      return yield* getAwsLoginStatus;
    });

  return DesktopDevbox.of({
    getState,
    run,
    listAwsProfiles,
    setEnabled: (input) => setEnabled(input).pipe(Effect.mapError(toError)),
    startLogin,
    setSignInAwsProfile,
    getAwsLoginStatus,
    setAwsLoginGuard,
  });
});

export const layer = Layer.effect(DesktopDevbox, make);
