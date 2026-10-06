import type {
  DesktopAwsProfile,
  DesktopDevboxConfig,
  DesktopDevboxLoginProvider,
  DesktopDevboxLoginTarget,
} from "@t3tools/contracts";

// Pure pieces of the devbox control panel: the AWS launch template, the
// ssh_config block that reaches each box over SSM, and the scripts run on them.
// Nothing here spawns processes, so every piece is testable in isolation.

export const DEVBOX = {
  amiParameter: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  rootVolumeGiB: 100,
  namePrefix: "devbox",
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

/** Profile names the panel accepts; they are interpolated into the health script. */
export function validateAwsProfileName(profile: string): string | null {
  return /^[A-Za-z0-9_.-]+$/u.test(profile)
    ? null
    : `Unexpected AWS profile name: ${profile}. Use letters, digits, '.', '_' or '-'.`;
}

/**
 * When the profile's SSO session lapses, read from the AWS CLI's token cache
 * (the contents of ~/.aws/sso/cache/*.json); null when the profile has no SSO
 * start URL or no cached token.
 */
export function ssoSessionExpiry(
  configText: string,
  profile: string,
  cacheFiles: readonly string[],
): string | null {
  // An sso-session section follows its profile, so its start URL wins, as in the CLI.
  const startUrl = [
    ...awsProfileSections(configText, profile).matchAll(/^\s*sso_start_url\s*=\s*(\S+)/gmu),
  ].at(-1)?.[1];
  if (startUrl === undefined) return null;
  let latest: { readonly ms: number; readonly expiresAt: string } | null = null;
  for (const text of cacheFiles) {
    let entry: { startUrl?: unknown; accessToken?: unknown; expiresAt?: unknown };
    try {
      entry = JSON.parse(text) as typeof entry;
    } catch {
      continue;
    }
    if (entry.startUrl !== startUrl || typeof entry.accessToken !== "string") continue;
    if (typeof entry.expiresAt !== "string") continue;
    const ms = Date.parse(entry.expiresAt);
    if (Number.isFinite(ms) && (latest === null || ms > latest.ms)) {
      latest = { ms, expiresAt: entry.expiresAt };
    }
  }
  return latest?.expiresAt ?? null;
}

export interface DevboxInstance {
  readonly instanceId: string;
  /** The Name tag, or the instance id when the tag is missing or unusable as an ssh alias. */
  readonly name: string;
  readonly state: string;
  readonly instanceType: string;
  readonly launchedAt: string | null;
}

/** Sign-ins use this target for the local machine, so no devbox may be named it. */
export const MAC_TARGET = "mac";

const DEVBOX_NAME = /^[A-Za-z][A-Za-z0-9-]{0,62}$/u;

/** Devbox names become ssh aliases and appear in shell commands. */
export function validateDevboxName(name: string): string | null {
  if (!DEVBOX_NAME.test(name)) {
    return "Use letters, digits, and dashes, starting with a letter.";
  }
  return name === MAC_TARGET ? `"${MAC_TARGET}" is reserved for this Mac.` : null;
}

/** Every live managed instance from `describe-instances` JSON, ordered by name. */
export function parseManagedInstances(json: string): DevboxInstance[] {
  const parsed = JSON.parse(json) as {
    Reservations?: Array<{
      Instances?: Array<{
        InstanceId?: string;
        State?: { Name?: string };
        InstanceType?: string;
        LaunchTime?: string;
        Tags?: Array<{ Key?: string; Value?: string }>;
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
              tagName: instance.Tags?.find((tag) => tag.Key === "Name")?.Value ?? "",
              state: instance.State.Name,
              instanceType: instance.InstanceType ?? "",
              launchedAt: instance.LaunchTime ?? null,
            },
          ]
        : [],
    )
    // Oldest first, so an existing box keeps its alias when a duplicate Name appears.
    .toSorted((left, right) => (left.launchedAt ?? "").localeCompare(right.launchedAt ?? ""));
  const taken = new Set<string>();
  return instances
    .map(({ tagName, ...instance }) => {
      const name =
        validateDevboxName(tagName) === null && !taken.has(tagName) ? tagName : instance.instanceId;
      taken.add(name);
      return { ...instance, name };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
}

/** The first `devboxN` (from 1) that no instance or ssh host already uses. */
export function nextDevboxName(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let index = 1; ; index += 1) {
    const name = `${DEVBOX.namePrefix}${index}`;
    if (!used.has(name)) return name;
  }
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
  readonly name: string;
  readonly amiId: string;
  readonly userData: string;
}) {
  const { config } = input;
  const tags = [
    { Key: "Name", Value: input.name },
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

/**
 * One ssh_config block holds every devbox alias. It is shared with the
 * hand-maintained Sandbox-1 fleet block of the same name: the panel owns the
 * Host entries that point at t3-managed instances and keeps every other entry
 * in the block (such as the LLM gateway) exactly as written.
 */
const SSH_BLOCK_NAME = "sandbox1-devboxes";
const SSH_BLOCK_START = `# >>> ${SSH_BLOCK_NAME}`;
const SSH_BLOCK_END = `# <<< ${SSH_BLOCK_NAME}`;
const NEW_SSH_BLOCK_START = `${SSH_BLOCK_START} (Host entries for t3-managed instances are written by T3 Code's devbox panel)`;
// Written by the single-devbox panel; replaced by the shared block.
const LEGACY_SSH_BLOCK_START = "# >>> t3 devbox (managed by T3 Code) >>>";
const LEGACY_SSH_BLOCK_END = "# <<< t3 devbox (managed by T3 Code) <<<";

const isMarker = (line: string, marker: string) => line === marker || line.startsWith(`${marker} `);

export interface DevboxSshHost {
  readonly name: string;
  readonly instanceId: string;
}

export function buildSshHostEntry(config: AwsTarget, host: DevboxSshHost): string[] {
  if (!/^i-[0-9a-f]+$/u.test(host.instanceId)) {
    throw new Error(`Unexpected instance id: ${host.instanceId}`);
  }
  if (host.name !== host.instanceId && validateDevboxName(host.name) !== null) {
    throw new Error(`Unexpected devbox name: ${host.name}`);
  }
  const path = DEVBOX_EXTRA_PATH.map((entry) => entry.replace(/^~/u, "$HOME")).join(":");
  return [
    `Host ${host.name}`,
    `    HostName ${host.instanceId}`,
    `    User ${DEVBOX.sshUser}`,
    `    IdentityFile ${DEVBOX.identityFile}`,
    "    IdentitiesOnly yes",
    // This Mac's global ssh_config leaves ed25519 out of the accepted key types.
    "    PubkeyAcceptedAlgorithms +ssh-ed25519",
    "    StrictHostKeyChecking accept-new",
    "    ServerAliveInterval 30",
    `    ProxyCommand sh -lc 'PATH="${path}:$PATH" AWS_PROFILE=${config.awsProfile} AWS_REGION=${config.awsRegion} aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p'`,
  ];
}

interface SshEntry {
  readonly aliases: readonly string[];
  readonly hostName: string | null;
  readonly lines: readonly string[];
}

function parseSshEntries(lines: readonly string[]): { preamble: string[]; entries: SshEntry[] } {
  const preamble: string[] = [];
  const entries: Array<{ aliases: string[]; hostName: string | null; lines: string[] }> = [];
  for (const line of lines) {
    const host = /^\s*(Host|Match)\s+(.*)$/iu.exec(line);
    if (host) {
      entries.push({
        aliases: host[1]!.toLowerCase() === "host" ? host[2]!.trim().split(/\s+/u) : [],
        hostName: null,
        lines: [line],
      });
      continue;
    }
    const current = entries.at(-1);
    if (!current) {
      preamble.push(line);
      continue;
    }
    current.lines.push(line);
    const hostName = /^\s*HostName\s+(\S+)/iu.exec(line);
    if (hostName) current.hostName = hostName[1]!;
  }
  return { preamble, entries };
}

function findBlock(lines: readonly string[], start: string, end: string) {
  const from = lines.findIndex((line) => isMarker(line, start));
  const to =
    from === -1 ? -1 : lines.findIndex((line, index) => index > from && isMarker(line, end));
  return from === -1 || to === -1 ? null : { from, to };
}

function removeBlock(lines: string[], start: string, end: string): string[] {
  const block = findBlock(lines, start, end);
  if (!block) return lines;
  let to = block.to + 1;
  while (to < lines.length && lines[to] === "") to += 1;
  return [...lines.slice(0, block.from), ...lines.slice(to)];
}

/** Aliases in the shared block, so a new devbox never takes a hand-written host's name. */
export function sshBlockAliases(existing: string): string[] {
  const lines = existing.split("\n");
  const block = findBlock(lines, SSH_BLOCK_START, SSH_BLOCK_END);
  if (!block) return [];
  return parseSshEntries(lines.slice(block.from + 1, block.to)).entries.flatMap(
    (entry) => entry.aliases,
  );
}

/**
 * Writes `hosts` into the shared block, replacing entries with the same alias
 * or instance id in place and appending new ones. Entries for `removed`
 * instance ids are dropped; every other line is kept. A new block is
 * prepended because ssh_config uses the first matching value, so a later
 * `Host *` or stale alias must not shadow it.
 */
export function syncSshConfigHosts(
  existing: string,
  config: AwsTarget,
  hosts: readonly DevboxSshHost[],
  removed: readonly string[] = [],
): string {
  let lines = removeBlock(existing.split("\n"), LEGACY_SSH_BLOCK_START, LEGACY_SSH_BLOCK_END);
  const block = findBlock(lines, SSH_BLOCK_START, SSH_BLOCK_END);
  const { preamble, entries } = parseSshEntries(block ? lines.slice(block.from + 1, block.to) : []);
  const pending = new Map(hosts.map((host) => [host.name, host]));
  const byInstance = new Map(hosts.map((host) => [host.instanceId, host]));
  const body = [...preamble];
  for (const entry of entries) {
    const owner =
      entry.aliases.map((alias) => pending.get(alias)).find((host) => host !== undefined) ??
      (entry.hostName === null ? undefined : byInstance.get(entry.hostName));
    if (owner) {
      if (pending.delete(owner.name)) {
        // Blank lines and comments after the last option introduce the next entry; keep them.
        const lastOption = entry.lines.findLastIndex((line) => !/^\s*(#.*)?$/u.test(line));
        body.push(...buildSshHostEntry(config, owner), ...entry.lines.slice(lastOption + 1));
      }
      continue;
    }
    if (entry.hostName !== null && removed.includes(entry.hostName)) continue;
    body.push(...entry.lines);
  }
  for (const host of pending.values()) body.push(...buildSshHostEntry(config, host));

  const startLine = block ? lines[block.from]! : NEW_SSH_BLOCK_START;
  const next = [startLine, ...body, block ? lines[block.to]! : SSH_BLOCK_END];
  if (block) {
    lines = [...lines.slice(0, block.from), ...next, ...lines.slice(block.to + 1)];
  } else {
    while (lines.length > 0 && lines[0] === "") lines.shift();
    lines = lines.length === 0 ? [...next, ""] : [...next, "", ...lines];
  }
  return lines.join("\n");
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

/**
 * Prints one JSON object with each sign-in's status and expiry; runs unchanged
 * on the Mac and the devbox. Secrets are read only to find expiry times and
 * are never printed.
 */
export function buildHealthScript(awsProfile: string | null): string {
  const invalid = awsProfile === null ? null : validateAwsProfileName(awsProfile);
  if (invalid !== null) throw new Error(invalid);
  return String.raw`export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
T3_AWS_PROFILE='${awsProfile ?? ""}' python3 - <<'PY'
import base64, configparser, datetime, glob, json, os, pathlib, re, subprocess, sys
home = pathlib.Path.home()

def run(cmd, timeout=20):
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return done.returncode, (done.stdout + done.stderr).strip()
    except FileNotFoundError:
        return 127, cmd[0] + " is not installed"
    except subprocess.TimeoutExpired:
        return 124, cmd[0] + " timed out"

def check(ok, detail, expires=None):
    return {"ok": bool(ok), "detail": (detail or "")[-200:], "expiresAt": expires if ok else None}

def jwt_exp(token):
    try:
        payload = token.split(".")[1]
        exp = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"]
        return datetime.datetime.fromtimestamp(exp, datetime.timezone.utc).isoformat()
    except Exception:
        return None

def ms_iso(value):
    try:
        return datetime.datetime.fromtimestamp(int(value) / 1000, datetime.timezone.utc).isoformat()
    except Exception:
        return None

out = {}
profile = os.environ.get("T3_AWS_PROFILE", "")
if profile:
    code, text = run(["aws", "sts", "get-caller-identity", "--profile", profile, "--query", "Arn", "--output", "text"])
    ok = code == 0 and text.startswith("arn:")
    config = configparser.RawConfigParser()
    config.read(home / ".aws" / "config")
    section = "default" if profile == "default" else "profile " + profile
    start = config.get(section, "sso_start_url", fallback=None) if config.has_section(section) else None
    session = config.get(section, "sso_session", fallback=None) if config.has_section(section) else None
    if session and config.has_section("sso-session " + session):
        start = config.get("sso-session " + session, "sso_start_url", fallback=start)
    expires = None
    for path in glob.glob(str(home / ".aws" / "sso" / "cache" / "*.json")):
        try:
            cached = json.load(open(path))
        except Exception:
            continue
        if cached.get("startUrl") == start and cached.get("accessToken") and cached.get("expiresAt"):
            expires = max(expires or "", cached["expiresAt"])
    if ok:
        detail = text.split("/")[-1]
    elif re.search("expired|sso|token", text, re.I):
        detail = "SSO session expired"
    else:
        detail = text
    out["aws"] = check(ok, detail, expires or None)
else:
    out["aws"] = check(False, "Choose an AWS profile")

code, text = run(["tsh", "status"])
valid = re.search(r"Valid until:\s*(.+?)\s*\[valid for", text)
user = re.search(r"Logged in as:\s*(\S+)", text)
expires = None
if valid:
    try:
        expires = datetime.datetime.strptime(valid.group(1).rsplit(" ", 1)[0], "%Y-%m-%d %H:%M:%S %z").isoformat()
    except Exception:
        pass
ok = bool(valid) and "EXPIRED" not in text
out["teleport"] = check(ok, (user.group(1) if user else "Logged in") if ok else ("tsh is not installed" if code == 127 else "Not logged in"), expires)

code, text = run(["gh", "api", "user", "--jq", ".login"])
login = text.splitlines()[0] if text else ""
out["github"] = check(code == 0 and re.fullmatch(r"[A-Za-z0-9-]+", login), login or "Not logged in")

code, text = run(["codex", "login", "status"])
first = text.splitlines()[0] if text else "codex is not installed"
expires = None
try:
    expires = jwt_exp(json.load(open(home / ".codex" / "auth.json"))["tokens"]["access_token"])
except Exception:
    pass
out["codex"] = check(first.startswith("Logged in"), first, expires)

code, text = run(["claude", "auth", "status"])
try:
    status = json.loads(text)
except Exception:
    status = {}
expires = None
try:
    if sys.platform == "darwin":
        _, secret = run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-a", os.environ.get("USER", ""), "-w"])
        expires = ms_iso(json.loads(secret)["claudeAiOauth"]["expiresAt"])
    else:
        expires = ms_iso(json.load(open(home / ".claude" / ".credentials.json"))["claudeAiOauth"]["expiresAt"])
except Exception:
    pass
out["claude"] = check(status.get("loggedIn"), status.get("email") or "Logged in" if status.get("loggedIn") else "Not logged in", expires)

brain = home / "brain" if (home / "brain" / ".git").exists() else home / "Documents" / "brain"
code, text = run(["git", "-C", str(brain), "log", "--oneline", "-1"])
out["brain"] = check(code == 0 and re.match(r"^[0-9a-f]{7,} ", text), text or "Not cloned")
print(json.dumps(out))
PY
`;
}

type Check = { readonly ok: boolean; readonly detail: string; readonly expiresAt: string | null };

export interface DevboxHealth {
  readonly aws: Check;
  readonly teleport: Check;
  readonly github: Check;
  readonly claude: Check;
  readonly codex: Check;
  readonly brain: Check;
}

const HEALTH_KEYS = ["aws", "teleport", "github", "claude", "codex", "brain"] as const;

export function parseDevboxHealth(stdout: string): DevboxHealth {
  const line = stdout
    .trim()
    .split("\n")
    .findLast((entry) => entry.startsWith("{"));
  if (!line) {
    throw new Error("The health check printed no result.");
  }
  const raw = JSON.parse(line) as Record<string, Partial<Check> | undefined>;
  const read = (key: (typeof HEALTH_KEYS)[number]): Check => ({
    ok: raw[key]?.ok === true,
    detail: typeof raw[key]?.detail === "string" ? raw[key].detail : "Unknown",
    expiresAt: typeof raw[key]?.expiresAt === "string" ? raw[key].expiresAt : null,
  });
  return {
    aws: read("aws"),
    teleport: read("teleport"),
    github: read("github"),
    claude: read("claude"),
    codex: read("codex"),
    brain: read("brain"),
  };
}

/** Codex's browser callback is fixed to localhost:1455, so only one Codex sign-in can run at a time. */
export const CODEX_CALLBACK_PORT = 1455;

/** How a sign-in runs. Devbox sign-ins tunnel their browser callback back to this Mac. */
export interface LoginCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to stdin first, e.g. a streamed credential. */
  readonly stdin?: string;
  /** The CLI opens the browser itself, so the panel must not open a second tab. */
  readonly opensBrowser: boolean;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// BSD `script` needs a terminal on stdin; Python's pty module relays a pipe instead.
const PTY_RUNNER =
  "import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(['sh', '-lc', sys.argv[1]])))";

/** Runs the command in a pseudo-terminal on the Mac so CLIs print their interactive prompts. */
function macPty(shellCommand: string): Omit<LoginCommand, "opensBrowser"> {
  return { command: "python3", args: ["-c", PTY_RUNNER, shellCommand] };
}

function devboxPty(
  sshAlias: string,
  shellCommand: string,
  forwardPort?: number,
): Omit<LoginCommand, "opensBrowser"> {
  return {
    command: "ssh",
    args: [
      "-tt",
      "-o",
      "ConnectTimeout=60",
      "-o",
      "ExitOnForwardFailure=yes",
      ...(forwardPort === undefined ? [] : ["-L", `${forwardPort}:127.0.0.1:${forwardPort}`]),
      sshAlias,
      `bash -lc ${shellQuote(`export PATH="$HOME/.local/bin:$PATH"; ${shellCommand}`)}`,
    ],
  };
}

/**
 * A fresh sign-in: each command logs out first so the new session gets its
 * full lifetime. Devbox sign-ins forward their browser callback to the Mac;
 * GitHub and Claude on the devbox reuse this Mac's credential over stdin.
 */
export function loginCommand(input: {
  /** `mac`, or the devbox's ssh alias. */
  readonly target: DesktopDevboxLoginTarget;
  readonly provider: DesktopDevboxLoginProvider;
  readonly awsProfile: string;
  /** A free local port, used when a devbox callback must be tunneled. */
  readonly callbackPort: number;
  /** This Mac's credential for providers the devbox copies instead of signing in. */
  readonly credential?: string;
}): LoginCommand {
  const onMac = input.target === MAC_TARGET;
  const run = (
    shellCommand: string,
    options: { forwardPort?: number; opensBrowser?: boolean } = {},
  ) => ({
    ...(onMac ? macPty(shellCommand) : devboxPty(input.target, shellCommand, options.forwardPort)),
    opensBrowser: onMac && options.opensBrowser === true,
  });
  const profile = shellQuote(input.awsProfile);
  const quietly = (command: string) => `${command} >/dev/null 2>&1 || true`;
  const fromMac = (remote: string): LoginCommand => {
    if (!input.credential) {
      throw new Error(
        `Sign ${input.provider} in on this Mac first; the devbox reuses that session.`,
      );
    }
    return {
      command: "ssh",
      args: [
        "-o",
        "ConnectTimeout=60",
        input.target,
        `bash -lc ${shellQuote(`export PATH="$HOME/.local/bin:$PATH"; ${remote}`)}`,
      ],
      stdin: `${input.credential.trim()}\n`,
      opensBrowser: false,
    };
  };
  switch (input.provider) {
    case "aws":
      return run(
        `${quietly(`aws sso logout --profile ${profile}`)}; aws sso login --profile ${profile} --no-browser`,
      );
    case "teleport":
      return onMac
        ? run(`${quietly("tsh logout")}; tsh login --proxy=${DEVBOX.teleportProxy} --browser=none`)
        : run(
            `${quietly("tsh logout")}; tsh login --proxy=${DEVBOX.teleportProxy} --browser=none --bind-addr=127.0.0.1:${input.callbackPort}`,
            { forwardPort: input.callbackPort },
          );
    case "github":
      return onMac
        ? run(
            `${quietly('gh auth logout --hostname github.com --user "$(gh api user --jq .login)"')}; gh auth login --hostname github.com --web --git-protocol https`,
            { opensBrowser: true },
          )
        : fromMac(
            `${quietly("gh auth logout --hostname github.com")}; gh auth login --hostname github.com --with-token && gh auth setup-git && gh api user --jq .login`,
          );
    case "codex":
      return run(`${quietly("codex logout")}; codex login`, {
        opensBrowser: true,
        ...(onMac ? {} : { forwardPort: CODEX_CALLBACK_PORT }),
      });
    case "claude":
      return onMac
        ? run(`${quietly("claude auth logout")}; claude auth login`, { opensBrowser: true })
        : // Claude's remote login only offers a paste-back code, so the devbox gets this Mac's session.
          fromMac(String.raw`umask 077; mkdir -p ~/.claude; cat > ~/.claude/.credentials.json; python3 -c '
import json, pathlib
path = pathlib.Path.home() / ".claude.json"
data = json.loads(path.read_text()) if path.exists() else {}
data.pop("primaryApiKey", None)
data["hasCompletedOnboarding"] = True
path.write_text(json.dumps(data, indent=2))
'; claude auth status`);
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
