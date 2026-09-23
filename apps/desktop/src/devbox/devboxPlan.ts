import type {
  DesktopAwsProfile,
  DesktopDevboxConfig,
  DesktopDevboxLoginProvider,
  DesktopDevboxLoginTarget,
} from "@t3tools/contracts";

// Pure pieces of the devbox control panel: the AWS launch template, the
// ssh_config block that reaches the box over SSM, and the scripts run on it.
// Nothing here spawns processes, so every piece is testable in isolation.

export const DEVBOX = {
  amiParameter: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  rootVolumeGiB: 100,
  name: "t3-devbox",
  sshAlias: "t3-devbox",
  sshUser: "ec2-user",
  identityFile: "~/.ssh/id_ed25519",
  managedTagKey: "t3-managed",
  brainRepo: "tarunravi/brain",
  teleportProxy: "teleport.scalegov.com",
  teleportVersion: "18.7.4",
} as const;

/** Only the profile is chosen by hand; the network comes from an existing devbox in that account. */
export const DEFAULT_DEVBOX_INSTANCE_TYPE = "m5.2xlarge";

// Electron launched from Finder inherits a minimal PATH; aws and the SSM
// session plugin usually live in one of these.
export const DEVBOX_EXTRA_PATH = ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];

export function devboxPath(homeDir: string, currentPath: string | undefined): string {
  const extra = DEVBOX_EXTRA_PATH.map((entry) => entry.replace(/^~/u, homeDir));
  return [...extra, ...(currentPath ? [currentPath] : [])].join(":");
}

export function awsArgs(config: AwsTarget, ...args: string[]): string[] {
  return [
    ...args,
    "--profile",
    config.awsProfile,
    "--region",
    config.awsRegion,
    "--output",
    "json",
  ];
}

interface AwsTarget {
  readonly awsProfile: string;
  readonly awsRegion: string;
}

const managedFilter = `Name=tag:${DEVBOX.managedTagKey},Values=true`;
const liveStatesFilter = "Name=instance-state-name,Values=pending,running,stopping,stopped";

export const describeManagedInstanceArgs = (config: AwsTarget) =>
  awsArgs(config, "ec2", "describe-instances", "--filters", managedFilter, liveStatesFilter);

/** Any existing devbox in the account; its network settings become the launch template. */
export const describeTemplateInstanceArgs = (config: AwsTarget) =>
  awsArgs(
    config,
    "ec2",
    "describe-instances",
    "--filters",
    "Name=tag:Purpose,Values=devbox",
    liveStatesFilter,
  );

export function parseLaunchTemplate(
  json: string,
): Omit<DesktopDevboxConfig, "awsProfile" | "awsRegion"> | null {
  const parsed = JSON.parse(json) as {
    Reservations?: Array<{
      Instances?: Array<{
        InstanceType?: string;
        SubnetId?: string;
        SecurityGroups?: Array<{ GroupId?: string }>;
        IamInstanceProfile?: { Arn?: string };
      }>;
    }>;
  };
  for (const instance of (parsed.Reservations ?? []).flatMap((entry) => entry.Instances ?? [])) {
    const securityGroupId = instance.SecurityGroups?.[0]?.GroupId;
    const instanceProfile = instance.IamInstanceProfile?.Arn?.split("/").at(-1);
    if (instance.SubnetId && securityGroupId && instanceProfile) {
      return {
        instanceType: instance.InstanceType ?? DEFAULT_DEVBOX_INSTANCE_TYPE,
        subnetId: instance.SubnetId,
        securityGroupId,
        instanceProfile,
      };
    }
  }
  return null;
}

/** Profiles from ~/.aws/config, with each one's region when set. */
export function parseAwsProfiles(configText: string): DesktopAwsProfile[] {
  const profiles: DesktopAwsProfile[] = [];
  let current: { name: string; region: string | null } | null = null;
  for (const raw of configText.split(/\r?\n/u)) {
    const line = raw.trim();
    const section = /^\[(?:profile\s+)?([^\]]+)\]$/u.exec(line);
    if (section) {
      current =
        line.startsWith("[sso-session") || line.startsWith("[services")
          ? null
          : { name: section[1]!.trim(), region: null };
      if (current) profiles.push(current);
      continue;
    }
    const region = /^region\s*=\s*(\S+)/u.exec(line);
    if (current && region) current.region = region[1]!;
  }
  return profiles;
}

/**
 * The profile's section and its sso-session section, copied to the devbox so
 * `aws sso login` works there without hand-editing ~/.aws/config.
 */
export function awsProfileSections(configText: string, profile: string): string {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of configText.split(/\r?\n/u)) {
    const header = /^\s*\[([^\]]+)\]\s*$/u.exec(raw);
    if (header) {
      current = [raw.trim()];
      sections.set(header[1]!.trim(), current);
    } else if (current && raw.trim().length > 0) {
      // Keep indentation: nested keys such as `s3 =` continue on indented lines.
      current.push(raw.trimEnd());
    }
  }
  const profileSection =
    sections.get(profile === "default" ? "default" : `profile ${profile}`) ?? sections.get(profile);
  if (!profileSection) return "";
  const session = profileSection
    .map((line) => /^sso_session\s*=\s*(\S+)/u.exec(line)?.[1])
    .find((value) => value !== undefined);
  const sessionSection = session ? sections.get(`sso-session ${session}`) : undefined;
  return [profileSection, ...(sessionSection ? [sessionSection] : [])]
    .map((lines) => lines.join("\n"))
    .join("\n\n");
}

export interface DevboxInstance {
  readonly instanceId: string;
  readonly state: string;
  readonly instanceType: string;
  readonly launchedAt: string | null;
}

/** Newest live managed instance from `describe-instances` JSON. */
export function parseManagedInstance(json: string): DevboxInstance | null {
  const parsed = JSON.parse(json) as {
    Reservations?: Array<{
      Instances?: Array<{
        InstanceId?: string;
        State?: { Name?: string };
        InstanceType?: string;
        LaunchTime?: string;
      }>;
    }>;
  };
  const instances = (parsed.Reservations ?? [])
    .flatMap((reservation) => reservation.Instances ?? [])
    .flatMap((instance) =>
      instance.InstanceId && instance.State?.Name
        ? [
            {
              instanceId: instance.InstanceId,
              state: instance.State.Name,
              instanceType: instance.InstanceType ?? "",
              launchedAt: instance.LaunchTime ?? null,
            },
          ]
        : [],
    )
    .toSorted((left, right) => (right.launchedAt ?? "").localeCompare(left.launchedAt ?? ""));
  return instances[0] ?? null;
}

/** cloud-init for the first boot: authorize the Mac's key for ec2-user. */
export function buildUserData(publicKey: string): string {
  const key = publicKey.trim();
  if (!/^ssh-(ed25519|rsa) \S+/u.test(key) || key.includes("\n")) {
    throw new Error("Expected a single-line OpenSSH public key.");
  }
  return `#cloud-config\nssh_authorized_keys:\n  - ${key}\n`;
}

export function runInstancesArgs(input: {
  readonly config: DesktopDevboxConfig;
  readonly amiId: string;
  readonly userData: string;
}) {
  const { config } = input;
  const tags = [
    { Key: "Name", Value: DEVBOX.name },
    { Key: "Owner", Value: "tarun" },
    { Key: "Purpose", Value: "devbox" },
    { Key: DEVBOX.managedTagKey, Value: "true" },
  ];
  return awsArgs(
    config,
    "ec2",
    "run-instances",
    "--image-id",
    input.amiId,
    "--instance-type",
    config.instanceType,
    "--subnet-id",
    config.subnetId,
    "--security-group-ids",
    config.securityGroupId,
    "--iam-instance-profile",
    `Name=${config.instanceProfile}`,
    "--block-device-mappings",
    JSON.stringify([
      {
        DeviceName: "/dev/xvda",
        Ebs: { VolumeSize: DEVBOX.rootVolumeGiB, VolumeType: "gp3", DeleteOnTermination: true },
      },
    ]),
    "--metadata-options",
    "HttpTokens=required,HttpEndpoint=enabled",
    "--tag-specifications",
    JSON.stringify([
      { ResourceType: "instance", Tags: tags },
      { ResourceType: "volume", Tags: tags },
    ]),
    "--user-data",
    input.userData,
    "--count",
    "1",
  );
}

const SSH_BLOCK_START = "# >>> t3 devbox (managed by T3 Code) >>>";
const SSH_BLOCK_END = "# <<< t3 devbox (managed by T3 Code) <<<";

export function buildSshConfigBlock(config: AwsTarget, instanceId: string): string {
  if (!/^i-[0-9a-f]+$/u.test(instanceId)) {
    throw new Error(`Unexpected instance id: ${instanceId}`);
  }
  const path = DEVBOX_EXTRA_PATH.map((entry) => entry.replace(/^~/u, "$HOME")).join(":");
  return [
    SSH_BLOCK_START,
    `Host ${DEVBOX.sshAlias}`,
    `    HostName ${instanceId}`,
    `    User ${DEVBOX.sshUser}`,
    `    IdentityFile ${DEVBOX.identityFile}`,
    "    IdentitiesOnly yes",
    // This Mac's global ssh_config leaves ed25519 out of the accepted key types.
    "    PubkeyAcceptedAlgorithms +ssh-ed25519",
    "    StrictHostKeyChecking accept-new",
    "    ServerAliveInterval 30",
    `    ProxyCommand sh -lc 'PATH="${path}:$PATH" AWS_PROFILE=${config.awsProfile} AWS_REGION=${config.awsRegion} aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p'`,
    SSH_BLOCK_END,
  ].join("\n");
}

/**
 * Replaces the managed block, or prepends it: ssh_config uses the first
 * matching value, so a later `Host *` must not shadow the devbox settings.
 * Passing null removes the block. Everything outside the markers is kept.
 */
export function upsertSshConfigBlock(existing: string, block: string | null): string {
  const start = existing.indexOf(SSH_BLOCK_START);
  const end = existing.indexOf(SSH_BLOCK_END);
  const withoutBlock =
    start !== -1 && end > start
      ? existing.slice(0, start) + existing.slice(end + SSH_BLOCK_END.length).replace(/^\n+/u, "")
      : existing;
  if (block === null) {
    return withoutBlock;
  }
  return withoutBlock.length === 0 ? `${block}\n` : `${block}\n\n${withoutBlock}`;
}

/**
 * Idempotent first-boot setup, piped to `bash -s` over SSH. Credentials never
 * appear here; GitHub auth is streamed separately on stdin.
 */
export const DEVBOX_BOOTSTRAP_SCRIPT = String.raw`set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
step() { printf '\n==> %s\n' "$1"; }

step "System packages"
sudo dnf install -y -q git tmux jq tar gzip unzip python3 cronie libatomic >/dev/null
# The brain vault schedules its sync with cron.
sudo systemctl enable --now crond >/dev/null 2>&1 || true
if ! command -v gh >/dev/null; then
  sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null
  sudo dnf install -y -q gh >/dev/null
fi
if ! command -v node >/dev/null; then
  sudo dnf install -y -q nodejs22 nodejs22-npm >/dev/null || sudo dnf install -y -q nodejs npm >/dev/null
  sudo alternatives --set node /usr/bin/node-22 >/dev/null 2>&1 || true
fi
sudo loginctl enable-linger "$USER"

step "Teleport"
if ! command -v tsh >/dev/null; then
  TSH_TMP="$(mktemp -d)"
  curl -fsSL "https://cdn.teleport.dev/teleport-v${DEVBOX.teleportVersion}-linux-amd64-bin.tar.gz" -o "$TSH_TMP/teleport.tgz"
  tar -xzf "$TSH_TMP/teleport.tgz" -C "$TSH_TMP"
  sudo install -m 0755 "$TSH_TMP/teleport/tsh" /usr/local/bin/tsh
  rm -rf "$TSH_TMP"
fi
tsh version --client 2>/dev/null | head -1 || true

step "Claude Code"
command -v claude >/dev/null || curl -fsSL https://claude.ai/install.sh | bash

step "Codex"
if ! command -v codex >/dev/null; then
  mkdir -p "$HOME/.local"
  npm install -g --prefix "$HOME/.local" @openai/codex >/dev/null
fi

step "Documents"
mkdir -p "$HOME/Documents"
claude --version || true
codex --version || true
`;

/**
 * Runs after GitHub auth. The vault's own setup-workbox.sh owns the work-only
 * sparse clone and the Claude/Codex wiring, so it is fetched and run as-is.
 */
export const DEVBOX_BRAIN_SCRIPT = String.raw`set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
gh api -H "Accept: application/vnd.github.raw" \
  "repos/${DEVBOX.brainRepo}/contents/scripts/setup-workbox.sh" | bash
ln -sfn "$HOME/brain" "$HOME/Documents/brain"
ln -sfn "$HOME/brain/AGENT.md" "$HOME/Documents/AGENTS.md"
test ! -e "$HOME/brain/personal"
git -C "$HOME/brain" log --oneline -1
`;

/** Prints one JSON object describing sign-ins; runs unchanged on the Mac and the devbox. */
export function buildHealthScript(awsProfile: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(awsProfile)) {
    throw new Error(`Unexpected AWS profile name: ${awsProfile}`);
  }
  return String.raw`export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
json() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'; }
brain_dir="$HOME/brain"; [ -d "$brain_dir/.git" ] || brain_dir="$HOME/Documents/brain"
aws_arn="$(aws sts get-caller-identity --profile ${awsProfile} --query Arn --output text 2>&1 | tail -1)"
tsh_status="$(tsh status 2>&1 | grep -E 'Logged in as|Valid until|EXPIRED|Not logged in|not found' | tr '\n' ' ')"
gh_login="$(gh api user --jq .login 2>&1 | head -1)"
claude_status="$(claude auth status 2>&1)"
codex_status="$(codex login status 2>&1 | head -1)"
brain_head="$(git -C "$brain_dir" log --oneline -1 2>&1 | head -1)"
printf '{"aws":%s,"teleport":%s,"github":%s,"claude":%s,"codex":%s,"brain":%s}\n' \
  "$(printf '%s' "$aws_arn" | json)" \
  "$(printf '%s' "$tsh_status" | json)" \
  "$(printf '%s' "$gh_login" | json)" \
  "$(printf '%s' "$claude_status" | json)" \
  "$(printf '%s' "$codex_status" | json)" \
  "$(printf '%s' "$brain_head" | json)"
`;
}

type Check = { readonly ok: boolean; readonly detail: string };

export interface DevboxHealth {
  readonly aws: Check;
  readonly teleport: Check;
  readonly github: Check;
  readonly claude: Check;
  readonly codex: Check;
  readonly brain: Check;
}

export function parseDevboxHealth(stdout: string): DevboxHealth {
  const line = stdout
    .trim()
    .split("\n")
    .findLast((entry) => entry.startsWith("{"));
  if (!line) {
    throw new Error("The devbox health check printed no result.");
  }
  const raw = JSON.parse(line) as Record<keyof DevboxHealth, string>;
  const claudeLoggedIn = /"loggedIn"\s*:\s*true/u.test(raw.claude);
  const claudeEmail = /"email"\s*:\s*"([^"]+)"/u.exec(raw.claude)?.[1];
  const teleportValid = /valid for/u.test(raw.teleport) && !/EXPIRED/u.test(raw.teleport);
  const teleportUser = /Logged in as:\s*(\S+)/u.exec(raw.teleport)?.[1];
  return {
    aws: {
      ok: raw.aws.startsWith("arn:"),
      detail: raw.aws.startsWith("arn:")
        ? (raw.aws.split("/").at(-1) ?? raw.aws)
        : /expired|sso|token/iu.test(raw.aws)
          ? "SSO session expired"
          : raw.aws || "aws CLI unavailable",
    },
    teleport: {
      ok: teleportValid,
      detail: teleportValid
        ? (teleportUser ?? "Logged in")
        : /not found/u.test(raw.teleport)
          ? "tsh is not installed"
          : "Not logged in",
    },
    github: {
      ok: /^[A-Za-z0-9-]+$/u.test(raw.github),
      detail: raw.github || "gh is not installed",
    },
    claude: {
      ok: claudeLoggedIn,
      detail: claudeLoggedIn ? (claudeEmail ?? "Logged in") : "Not logged in",
    },
    codex: {
      ok: raw.codex.startsWith("Logged in"),
      detail: raw.codex || "codex is not installed",
    },
    brain: {
      ok: /^[0-9a-f]{7,} /u.test(raw.brain),
      detail: raw.brain || "Not cloned",
    },
  };
}

/** How a sign-in runs. Devbox sign-ins tunnel their browser callback back to this Mac. */
export interface LoginCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to stdin first, e.g. a streamed credential. */
  readonly stdin?: string;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Runs `script` in a pseudo-terminal on the Mac so CLIs print their interactive prompts. */
function macPty(shellCommand: string): LoginCommand {
  return { command: "script", args: ["-q", "/dev/null", "sh", "-lc", shellCommand] };
}

function devboxPty(shellCommand: string, forwardPort?: number): LoginCommand {
  return {
    command: "ssh",
    args: [
      "-tt",
      "-o",
      "ConnectTimeout=60",
      "-o",
      "ExitOnForwardFailure=yes",
      ...(forwardPort === undefined ? [] : ["-L", `${forwardPort}:127.0.0.1:${forwardPort}`]),
      DEVBOX.sshAlias,
      `bash -lc ${shellQuote(`export PATH="$HOME/.local/bin:$PATH"; ${shellCommand}`)}`,
    ],
  };
}

export function loginCommand(input: {
  readonly target: DesktopDevboxLoginTarget;
  readonly provider: DesktopDevboxLoginProvider;
  readonly awsProfile: string;
  /** A free local port, used when a devbox callback must be tunneled. */
  readonly callbackPort: number;
  readonly githubToken?: string;
}): LoginCommand {
  const onMac = input.target === "mac";
  const run = (shellCommand: string, forwardPort?: number) =>
    onMac ? macPty(shellCommand) : devboxPty(shellCommand, forwardPort);
  switch (input.provider) {
    case "aws":
      return run(`aws sso login --profile ${shellQuote(input.awsProfile)} --no-browser`);
    case "teleport":
      return onMac
        ? run(`tsh login --proxy=${DEVBOX.teleportProxy} --browser=none`)
        : run(
            `tsh login --proxy=${DEVBOX.teleportProxy} --browser=none --bind-addr=127.0.0.1:${input.callbackPort}`,
            input.callbackPort,
          );
    case "github":
      if (onMac) {
        return run(
          "GH_NO_UPDATE_NOTIFIER=1 gh auth login --hostname github.com --web --git-protocol https",
        );
      }
      if (!input.githubToken) {
        throw new Error("Sign GitHub in on this Mac first; the devbox reuses that credential.");
      }
      return {
        command: "ssh",
        args: [
          "-o",
          "ConnectTimeout=60",
          DEVBOX.sshAlias,
          "gh auth login -h github.com --with-token && gh auth setup-git && gh api user --jq .login",
        ],
        stdin: `${input.githubToken.trim()}\n`,
      };
    case "codex":
      // Codex's browser callback is fixed to localhost:1455.
      return run("codex login", onMac ? undefined : 1455);
    case "claude":
      return run("claude auth login");
  }
}

// oxlint-disable-next-line no-control-regex -- stripping terminal escape sequences
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;

export function stripTerminal(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r(?!\n)/gu, "\n")
    .replace(/\r/gu, "");
}

/** Approval links in sign-in output; GovCloud SSO device links need the region-qualified host. */
export function extractLinks(output: string): string[] {
  const links = (stripTerminal(output).match(/https?:\/\/[^\s"'<>)\]]+/gu) ?? []).map((link) =>
    link
      .replace(/[.,;:]+$/u, "")
      .replace(
        /^https:\/\/start\.us-gov-home\.awsapps\.com\//u,
        "https://start.us-gov-west-1.us-gov-home.awsapps.com/",
      ),
  );
  // The approval page first: device-code links, then any https page, then local callbacks.
  const rank = (link: string) =>
    /[?&](user_)?code=/u.test(link) ? 0 : link.startsWith("https://") ? 1 : 2;
  return [...new Set(links)].toSorted((left, right) => rank(left) - rank(right));
}

/** Device codes such as `ABCD-EFGH` printed by AWS and GitHub. */
export function extractCodes(output: string): string[] {
  return [...new Set(stripTerminal(output).match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/gu) ?? [])];
}

/** Replaces the given ~/.aws/config sections on the devbox; section text arrives on stdin. */
export const MERGE_AWS_CONFIG_SCRIPT = String.raw`python3 -c '
import configparser, os, pathlib, sys
incoming = configparser.RawConfigParser(); incoming.read_string(sys.stdin.read())
path = pathlib.Path.home() / ".aws" / "config"; path.parent.mkdir(mode=0o700, exist_ok=True)
config = configparser.RawConfigParser(); config.read(path)
for section in incoming.sections():
    if config.has_section(section): config.remove_section(section)
    config.add_section(section)
    for key, value in incoming.items(section): config.set(section, key, value)
with open(path, "w") as handle: config.write(handle)
os.chmod(path, 0o600)
print("merged", ", ".join(incoming.sections()))
'`;
