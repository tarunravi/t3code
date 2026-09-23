import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import {
  DesktopDevboxConfigSchema,
  type DesktopAwsProfile,
  type DesktopDevboxAction,
  type DesktopDevboxConfig,
  type DesktopDevboxEnableInput,
  type DesktopDevboxLogin,
  type DesktopDevboxLoginInput,
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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  DEVBOX,
  DEVBOX_BOOTSTRAP_SCRIPT,
  DEVBOX_BRAIN_SCRIPT,
  MERGE_AWS_CONFIG_SCRIPT,
  awsArgs,
  awsProfileSections,
  buildHealthScript,
  buildSshConfigBlock,
  buildUserData,
  describeManagedInstanceArgs,
  describeTemplateInstanceArgs,
  devboxPath,
  extractCodes,
  extractLinks,
  loginCommand,
  parseAwsProfiles,
  parseDevboxHealth,
  parseLaunchTemplate,
  parseManagedInstance,
  runInstancesArgs,
  stripTerminal,
  upsertSshConfigBlock,
  type DevboxHealth,
  type DevboxInstance,
} from "./devboxPlan.ts";

const MAX_LOG_LINES = 400;
const MAX_LOGIN_OUTPUT = 4_000;
const LOGIN_TIMEOUT = Duration.minutes(10);
const SSM_ONLINE_TIMEOUT = Duration.minutes(10);
const SSH_READY_TIMEOUT = Duration.minutes(5);

type Job = NonNullable<DesktopDevboxState["job"]>;

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
    readonly run: (action: DesktopDevboxAction) => Effect.Effect<DesktopDevboxState>;
    readonly listAwsProfiles: Effect.Effect<readonly DesktopAwsProfile[]>;
    readonly setEnabled: (
      input: DesktopDevboxEnableInput,
    ) => Effect.Effect<DesktopDevboxState, Error>;
    readonly startLogin: (
      input: DesktopDevboxLoginStart,
    ) => Effect.Effect<DesktopDevboxState, Error>;
    readonly sendLoginInput: (input: DesktopDevboxLoginInput) => Effect.Effect<DesktopDevboxState>;
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
  const job = yield* Ref.make<Job | null>(null);
  const aws = yield* Ref.make<{
    readonly aws: DesktopDevboxState["aws"];
    readonly instance: DevboxInstance | null;
  }>({ aws: { ok: false, detail: "Not checked yet" }, instance: null });
  const checks = yield* Ref.make<DesktopDevboxState["checks"]>({ mac: null, devbox: null });
  const logins = yield* Ref.make<ReadonlyArray<DesktopDevboxLogin>>([]);
  const loginInputs = new Map<string, Queue.Queue<string>>();

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
    remote: readonly string[],
    options: { readonly stdin?: string; readonly echo?: boolean },
  ) =>
    runCommand(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=60", DEVBOX.sshAlias, ...remote],
      options,
    );

  const refreshAws = Effect.gen(function* () {
    const current = yield* Ref.get(config);
    if (current === null) {
      yield* Ref.set(aws, { aws: { ok: false, detail: "Devbox panel is off" }, instance: null });
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
        instance: null,
      });
      return;
    }
    const arn = (JSON.parse(identity.stdout) as { Arn?: string }).Arn ?? current.awsProfile;
    const described = yield* runCommand("aws", describeManagedInstanceArgs(current));
    yield* Ref.set(aws, {
      aws: { ok: true, detail: arn.split("/").at(-1) ?? arn },
      instance: described.exitCode === 0 ? parseManagedInstance(described.stdout) : null,
    });
  });

  const readHealth = (result: CommandResult, fallback: string): DevboxHealth => {
    try {
      return parseDevboxHealth(result.stdout);
    } catch {
      const check = { ok: false, detail: (result.stderr || fallback).slice(-300) };
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

  const refreshChecks = Effect.gen(function* () {
    const current = yield* Ref.get(config);
    if (current === null) return;
    const script = buildHealthScript(current.awsProfile);
    const instance = (yield* Ref.get(aws)).instance;
    const [mac, devbox] = yield* Effect.all(
      [
        runCommand("bash", ["-s"], { stdin: script }).pipe(
          Effect.map((result) => readHealth(result, "The local health check failed")),
        ),
        instance?.state === "running"
          ? ssh(["bash", "-s"], { stdin: script }).pipe(
              Effect.map((result) => readHealth(result, "Could not reach the devbox over SSH")),
            )
          : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    );
    yield* Ref.set(checks, { mac, devbox });
  });

  const snapshot = Effect.gen(function* () {
    const current = yield* Ref.get(aws);
    return {
      config: yield* Ref.get(config),
      aws: current.aws,
      instance: current.instance,
      sshAlias: DEVBOX.sshAlias,
      job: yield* Ref.get(job),
      checks: yield* Ref.get(checks),
      logins: yield* Ref.get(logins),
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
      const current = yield* requireConfig;
      const existing = yield* fs.readFileString(sshConfigPath).pipe(Effect.orElseSucceed(() => ""));
      const next = upsertSshConfigBlock(
        existing,
        instanceId === null ? null : buildSshConfigBlock(current, instanceId),
      );
      if (next === existing) return;
      yield* fs.makeDirectory(path.dirname(sshConfigPath), { recursive: true }).pipe(Effect.orDie);
      if (existing.length > 0) {
        yield* fs.writeFileString(`${sshConfigPath}.t3-devbox.bak`, existing).pipe(Effect.orDie);
      }
      yield* fs.writeFileString(sshConfigPath, next).pipe(Effect.orDie);
      yield* log(
        instanceId === null
          ? `Removed ${DEVBOX.sshAlias} from ~/.ssh/config`
          : `~/.ssh/config: ${DEVBOX.sshAlias} → ${instanceId} over SSM`,
      );
    });

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

  const githubToken = runCommand("gh", ["auth", "token"]).pipe(
    Effect.flatMap((result) => require(result, "Reading this Mac's gh credential")),
    Effect.map((token) => token.trim()),
  );

  const copyAwsProfile = (profile: string) =>
    Effect.gen(function* () {
      const text = yield* fs.readFileString(awsConfigPath).pipe(Effect.orElseSucceed(() => ""));
      const sections = awsProfileSections(text, profile);
      if (sections.length === 0) return;
      yield* require(yield* ssh([MERGE_AWS_CONFIG_SCRIPT], {
        stdin: sections,
      }), "Copying the AWS profile");
    });

  const setup = (instance: DevboxInstance) =>
    Effect.gen(function* () {
      const current = yield* requireConfig;
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
        "SSH login",
        SSH_READY_TIMEOUT,
        ssh(["true"], {}).pipe(Effect.map((result) => result.exitCode === 0)),
      );

      yield* log("Installing packages, Teleport, Claude Code, and Codex…");
      yield* require(yield* ssh(["bash", "-s"], {
        stdin: DEVBOX_BOOTSTRAP_SCRIPT,
        echo: true,
      }), "Bootstrap");

      yield* log(`Copying the ${current.awsProfile} AWS profile…`);
      yield* copyAwsProfile(current.awsProfile);

      yield* log("Signing GitHub in with this Mac's gh credential…");
      yield* require(yield* ssh(["gh auth login -h github.com --with-token && gh auth setup-git"], {
        stdin: `${yield* githubToken}\n`,
      }), "GitHub login on the devbox");

      yield* log("Setting up the brain vault…");
      yield* require(yield* ssh(["bash", "-s"], {
        stdin: DEVBOX_BRAIN_SCRIPT,
        echo: true,
      }), "Brain setup");
      yield* refreshChecks;
    });

  const launch = Effect.gen(function* () {
    const current = yield* requireConfig;
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
      awsArgs(current, "ssm", "get-parameter", "--name", DEVBOX.amiParameter),
      "Resolving the Amazon Linux AMI",
    )) as { Parameter?: { Value?: string } };
    const amiId = parameter.Parameter?.Value;
    if (!amiId) {
      return yield* Effect.fail(new DevboxStepError("The Amazon Linux AMI parameter was empty."));
    }
    yield* log(`Launching ${current.instanceType} from ${amiId}…`);
    const launched = (yield* awsJson(
      runInstancesArgs({ config: current, amiId, userData: buildUserData(publicKey) }),
      "Launching the instance",
    )) as { Instances?: Array<{ InstanceId?: string }> };
    const instanceId = launched.Instances?.[0]?.InstanceId;
    if (!instanceId) {
      return yield* Effect.fail(new DevboxStepError("run-instances returned no instance id."));
    }
    yield* log(`Launched ${instanceId}; waiting for it to run…`);
    yield* require(yield* runCommand(
      "aws",
      awsArgs(current, "ec2", "wait", "instance-running", "--instance-ids", instanceId),
    ), "Waiting for the instance");
    yield* setup(yield* requireInstance);
  });

  const changePower = (verb: "start" | "stop" | "terminate") =>
    Effect.gen(function* () {
      const current = yield* requireConfig;
      const instance = yield* requireInstance;
      yield* log(`${verb} ${instance.instanceId}…`);
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
        yield* writeSshConfig(null);
      }
      yield* Ref.update(checks, (value) => ({ ...value, devbox: null }));
    });

  const actions: Record<DesktopDevboxAction, Effect.Effect<void, DevboxStepError>> = {
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

  const listAwsProfiles = fs.readFileString(awsConfigPath).pipe(
    Effect.map(parseAwsProfiles),
    Effect.orElseSucceed(() => []),
  );

  const setEnabled = (input: DesktopDevboxEnableInput) =>
    Effect.gen(function* () {
      if (input === null) {
        yield* fs.remove(configPath).pipe(Effect.ignore);
        yield* Ref.set(config, null);
        yield* Ref.set(checks, { mac: null, devbox: null });
        yield* refreshAws;
        return yield* snapshot;
      }
      const profile = (yield* listAwsProfiles).find((entry) => entry.name === input.awsProfile);
      if (!profile) {
        return yield* Effect.fail(
          new Error(`AWS profile ${input.awsProfile} is not in ~/.aws/config.`),
        );
      }
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
      yield* Ref.set(config, next);
      yield* refreshAws;
      return yield* snapshot;
    });

  const updateLogin = (id: string, update: (login: DesktopDevboxLogin) => DesktopDevboxLogin) =>
    Ref.update(logins, (all) => all.map((login) => (login.id === id ? update(login) : login)));

  const startLogin = (input: DesktopDevboxLoginStart) =>
    Effect.gen(function* () {
      const saved = yield* Ref.get(config);
      const awsProfile = saved?.awsProfile ?? input.awsProfile;
      if (awsProfile === undefined || (saved === null && input.target === "devbox")) {
        return yield* Effect.fail(
          new DevboxStepError("Turn on the devbox panel in Settings → General first."),
        );
      }
      const existing = (yield* Ref.get(logins)).find(
        (login) =>
          login.target === input.target &&
          login.provider === input.provider &&
          login.status === "running",
      );
      if (existing) return yield* snapshot;
      if (input.target === "devbox" && input.provider === "aws") {
        yield* copyAwsProfile(awsProfile);
      }
      const command = loginCommand({
        target: input.target,
        provider: input.provider,
        awsProfile,
        callbackPort: yield* freePort,
        ...(input.target === "devbox" && input.provider === "github"
          ? { githubToken: yield* githubToken }
          : {}),
      });
      const id = NodeCrypto.randomUUID();
      const inputs = yield* Queue.unbounded<string>();
      if (command.stdin !== undefined) yield* Queue.offer(inputs, command.stdin);
      loginInputs.set(id, inputs);
      yield* Ref.update(logins, (all) => [
        ...all.filter(
          (login) => login.target !== input.target || login.provider !== input.provider,
        ),
        {
          id,
          target: input.target,
          provider: input.provider,
          status: "running" as const,
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
          yield* updateLogin(id, (login) => ({
            ...login,
            links: extractLinks(output),
            codes: extractCodes(output),
            output: stripTerminal(output).slice(-MAX_LOGIN_OUTPUT),
          }));
        });
      const session = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command.command, [...command.args], {
              env: { ...commandEnv, GH_NO_UPDATE_NOTIFIER: "1" },
              extendEnv: true,
              stdin: { stream: Stream.encodeText(Stream.fromQueue(inputs)), endOnDone: false },
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
        Effect.flatMap((exitCode) =>
          updateLogin(id, (login) => ({
            ...login,
            status: exitCode === 0 ? "succeeded" : "failed",
            output: stripTerminal(output).slice(-MAX_LOGIN_OUTPUT),
          })),
        ),
        Effect.ensuring(
          Effect.sync(() => loginInputs.delete(id)).pipe(Effect.andThen(refreshChecks)),
        ),
      );
      yield* Effect.forkIn(session, layerScope);
      return yield* snapshot;
    }).pipe(Effect.mapError(toError));

  const sendLoginInput = (input: DesktopDevboxLoginInput) =>
    Effect.gen(function* () {
      const inputs = loginInputs.get(input.id);
      if (inputs) yield* Queue.offer(inputs, `${input.text.trim()}\r`);
      return yield* snapshot;
    });

  return DesktopDevbox.of({
    getState,
    run,
    listAwsProfiles,
    setEnabled: (input) => setEnabled(input).pipe(Effect.mapError(toError)),
    startLogin,
    sendLoginInput,
  });
});

export const layer = Layer.effect(DesktopDevbox, make);
