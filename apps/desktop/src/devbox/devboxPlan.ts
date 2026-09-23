// Pure pieces of the devbox control panel: the AWS launch template, the
// ssh_config block that reaches the box over SSM, and the scripts run on it.
// Nothing here spawns processes, so every piece is testable in isolation.

export const DEVBOX = {
  awsProfile: "shift",
  awsRegion: "us-gov-west-1",
  instanceType: "m5.2xlarge",
  subnetId: "subnet-01848ab0c59660fcd",
  securityGroupId: "sg-02e5d9a5575e4abba",
  instanceProfile: "DevBox-SSM-Role",
  amiParameter: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  rootVolumeGiB: 100,
  name: "t3-devbox",
  sshAlias: "t3-devbox",
  sshUser: "ec2-user",
  identityFile: "~/.ssh/id_ed25519",
  managedTagKey: "t3-managed",
  brainRepo: "tarunravi/brain",
} as const;

// Electron launched from Finder inherits a minimal PATH; aws and the SSM
// session plugin usually live in one of these.
export const DEVBOX_EXTRA_PATH = ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];

export function devboxPath(homeDir: string, currentPath: string | undefined): string {
  const extra = DEVBOX_EXTRA_PATH.map((entry) => entry.replace(/^~/u, homeDir));
  return [...extra, ...(currentPath ? [currentPath] : [])].join(":");
}

export function awsArgs(...args: string[]): string[] {
  return [
    ...args,
    "--profile",
    DEVBOX.awsProfile,
    "--region",
    DEVBOX.awsRegion,
    "--output",
    "json",
  ];
}

const managedFilter = `Name=tag:${DEVBOX.managedTagKey},Values=true`;
const liveStatesFilter = "Name=instance-state-name,Values=pending,running,stopping,stopped";

export const describeManagedInstanceArgs = () =>
  awsArgs("ec2", "describe-instances", "--filters", managedFilter, liveStatesFilter);

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

export function runInstancesArgs(input: { readonly amiId: string; readonly userData: string }) {
  const tags = [
    { Key: "Name", Value: DEVBOX.name },
    { Key: "Owner", Value: "tarun" },
    { Key: "Purpose", Value: "devbox" },
    { Key: DEVBOX.managedTagKey, Value: "true" },
  ];
  return awsArgs(
    "ec2",
    "run-instances",
    "--image-id",
    input.amiId,
    "--instance-type",
    DEVBOX.instanceType,
    "--subnet-id",
    DEVBOX.subnetId,
    "--security-group-ids",
    DEVBOX.securityGroupId,
    "--iam-instance-profile",
    `Name=${DEVBOX.instanceProfile}`,
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

export function buildSshConfigBlock(instanceId: string): string {
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
    "    StrictHostKeyChecking accept-new",
    "    ServerAliveInterval 30",
    `    ProxyCommand sh -lc 'PATH="${path}:$PATH" AWS_PROFILE=${DEVBOX.awsProfile} AWS_REGION=${DEVBOX.awsRegion} aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p'`,
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
sudo dnf install -y -q git tmux jq tar gzip unzip python3 >/dev/null
if ! command -v gh >/dev/null; then
  sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null
  sudo dnf install -y -q gh >/dev/null
fi
if ! command -v node >/dev/null; then
  sudo dnf install -y -q nodejs22 nodejs22-npm >/dev/null || sudo dnf install -y -q nodejs npm >/dev/null
  sudo alternatives --set node /usr/bin/node-22 >/dev/null 2>&1 || true
fi
sudo loginctl enable-linger "$USER"

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

/** Prints one JSON object describing auth on the box. */
export const DEVBOX_HEALTH_SCRIPT = String.raw`export PATH="$HOME/.local/bin:$PATH"
json() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'; }
gh_login="$(gh api user --jq .login 2>&1 | head -1)"
claude_status="$(claude auth status 2>&1)"
codex_status="$(codex login status 2>&1 | head -1)"
brain_head="$(git -C "$HOME/brain" log --oneline -1 2>&1 | head -1)"
printf '{"github":%s,"claude":%s,"codex":%s,"brain":%s}\n' \
  "$(printf '%s' "$gh_login" | json)" \
  "$(printf '%s' "$claude_status" | json)" \
  "$(printf '%s' "$codex_status" | json)" \
  "$(printf '%s' "$brain_head" | json)"
`;

export interface DevboxHealth {
  readonly github: { readonly ok: boolean; readonly detail: string };
  readonly claude: { readonly ok: boolean; readonly detail: string };
  readonly codex: { readonly ok: boolean; readonly detail: string };
  readonly brain: { readonly ok: boolean; readonly detail: string };
}

export function parseDevboxHealth(stdout: string): DevboxHealth {
  const line = stdout
    .trim()
    .split("\n")
    .findLast((entry) => entry.startsWith("{"));
  if (!line) {
    throw new Error("The devbox health check printed no result.");
  }
  const raw = JSON.parse(line) as Record<"github" | "claude" | "codex" | "brain", string>;
  const claudeLoggedIn = /"loggedIn"\s*:\s*true/u.test(raw.claude);
  const claudeEmail = /"email"\s*:\s*"([^"]+)"/u.exec(raw.claude)?.[1];
  return {
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
