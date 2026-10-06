import { describe, expect, it } from "vite-plus/test";

import {
  awsProfileSections,
  buildUserData,
  extractCodes,
  extractLinks,
  loginCommand,
  nextDevboxName,
  parseAwsProfiles,
  parseDevboxHealth,
  parseLaunchTemplate,
  parseManagedInstances,
  runInstancesArgs,
  sshBlockAliases,
  ssoSessionExpiry,
  syncSshConfigHosts,
  validateAwsProfileName,
  validateDevboxName,
} from "./devboxPlan.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample tarun@mac";
const CONFIG = {
  awsProfile: "shift",
  awsRegion: "us-gov-west-1",
  instanceType: "m5.2xlarge",
  subnetId: "subnet-1",
  securityGroupId: "sg-1",
  instanceProfile: "DevBox-SSM-Role",
};

describe("syncSshConfigHosts", () => {
  const devbox1 = { name: "devbox1", instanceId: "i-0abc123" };
  const devbox2 = { name: "devbox2", instanceId: "i-0def456" };
  const fleetBlock = [
    "# >>> sandbox1-devboxes (commercial Sandbox-1, us-west-2)",
    "Host devbox0",
    "    HostName i-0aaa000",
    "    User ec2-user",
    "",
    "Host devbox1",
    "    HostName i-0abc123",
    "    User ec2-user",
    "# gateway notes",
    "",
    "# <<< sandbox1-devboxes",
    "",
    "Host *",
    "    User nobody",
    "",
  ].join("\n");

  it("prepends a new block so a later Host * cannot shadow the devboxes", () => {
    const next = syncSshConfigHosts("Host *\n    User nobody\n", CONFIG, [devbox1]);
    expect(next.indexOf("Host devbox1")).toBeLessThan(next.indexOf("Host *"));
    expect(next.startsWith("# >>> sandbox1-devboxes ")).toBe(true);
    expect(next).toContain("# <<< sandbox1-devboxes\n\nHost *\n    User nobody\n");
  });

  it("rewrites managed hosts in place and keeps hand-written ones", () => {
    const next = syncSshConfigHosts(fleetBlock, CONFIG, [devbox1, devbox2]);
    expect(next).toContain(
      "Host devbox0\n    HostName i-0aaa000\n    User ec2-user\n\nHost devbox1\n",
    );
    expect(next.match(/^Host devbox1$/gmu)).toHaveLength(1);
    expect(next).toContain("aws ssm start-session --target %h");
    expect(next).toMatch(/portNumber=%p'\n# gateway notes\n\nHost devbox2\n/u);
    expect(next.indexOf("Host devbox2")).toBeLessThan(next.indexOf("# <<< sandbox1-devboxes"));
    expect(next.startsWith("# >>> sandbox1-devboxes (commercial Sandbox-1, us-west-2)\n")).toBe(
      true,
    );
    expect(next.endsWith("# <<< sandbox1-devboxes\n\nHost *\n    User nobody\n")).toBe(true);
  });

  it("is idempotent", () => {
    const once = syncSshConfigHosts(fleetBlock, CONFIG, [devbox1, devbox2]);
    expect(syncSshConfigHosts(once, CONFIG, [devbox1, devbox2])).toBe(once);
  });

  it("finds a renamed host by its instance id", () => {
    const next = syncSshConfigHosts(fleetBlock, CONFIG, [
      { name: "work1", instanceId: "i-0abc123" },
    ]);
    expect(next).toContain("Host work1\n    HostName i-0abc123");
    expect(next).not.toMatch(/^Host devbox1$/mu);
  });

  it("removes only the terminated instance's host", () => {
    const next = syncSshConfigHosts(fleetBlock, CONFIG, [], ["i-0abc123"]);
    expect(next).not.toContain("devbox1");
    expect(next).toContain("Host devbox0\n    HostName i-0aaa000");
    expect(next).toContain("Host *\n    User nobody\n");
  });

  it("drops the single-devbox block the panel used to write", () => {
    const legacy = [
      "# >>> t3 devbox (managed by T3 Code) >>>",
      "Host t3-devbox",
      "    HostName i-0old",
      "# <<< t3 devbox (managed by T3 Code) <<<",
      "",
      fleetBlock,
    ].join("\n");
    const next = syncSshConfigHosts(legacy, CONFIG, [devbox1]);
    expect(next).not.toContain("t3-devbox");
    expect(next.startsWith("# >>> sandbox1-devboxes (commercial")).toBe(true);
  });

  it("leaves a similarly named block alone", () => {
    const other =
      "# >>> sandbox1-devbox (old)\nHost sbdevbox\n    HostName i-0abc123\n# <<< sandbox1-devbox\n";
    const next = syncSshConfigHosts(other, CONFIG, [devbox1]);
    expect(next.endsWith(other)).toBe(true);
    expect(sshBlockAliases(next)).toEqual(["devbox1"]);
  });

  it("lists the aliases in the shared block", () => {
    expect(sshBlockAliases(fleetBlock)).toEqual(["devbox0", "devbox1"]);
    expect(sshBlockAliases("Host devbox1\n")).toEqual([]);
  });

  it("refuses values that would inject ssh_config lines", () => {
    expect(() =>
      syncSshConfigHosts("", CONFIG, [{ name: "devbox1", instanceId: "i-0abc\nHost evil" }]),
    ).toThrow();
    expect(() =>
      syncSshConfigHosts("", CONFIG, [{ name: "devbox1\nHost evil", instanceId: "i-0abc" }]),
    ).toThrow();
  });
});

describe("launch arguments", () => {
  it("authorizes exactly the given public key", () => {
    expect(buildUserData(`${KEY}\n`)).toBe(`#cloud-config\nssh_authorized_keys:\n  - ${KEY}\n`);
    expect(() => buildUserData("-----BEGIN OPENSSH PRIVATE KEY-----")).toThrow();
  });

  it("tags the instance with its name and as managed so discovery finds it", () => {
    const args = runInstancesArgs({
      config: CONFIG,
      name: "devbox3",
      amiId: "ami-1",
      userData: buildUserData(KEY),
    });
    const tags = JSON.parse(args[args.indexOf("--tag-specifications") + 1]!) as Array<{
      Tags: Array<{ Key: string; Value: string }>;
    }>;
    expect(tags[0]!.Tags).toContainEqual({ Key: "t3-managed", Value: "true" });
    expect(tags[0]!.Tags).toContainEqual({ Key: "Name", Value: "devbox3" });
    expect(args).toContain("--profile");
    expect(args).toContain("HttpTokens=required,HttpEndpoint=enabled");
  });
});

describe("devbox names", () => {
  it("offers the first free devboxN", () => {
    expect(nextDevboxName([])).toBe("devbox1");
    expect(nextDevboxName(["devbox0", "devbox1", "devbox2"])).toBe("devbox3");
    expect(nextDevboxName(["devbox2"])).toBe("devbox1");
  });

  it("accepts only names usable as ssh aliases", () => {
    expect(validateDevboxName("devbox3")).toBeNull();
    expect(validateDevboxName("mac")).not.toBeNull();
    expect(validateDevboxName("3box")).not.toBeNull();
    expect(validateDevboxName("dev box")).not.toBeNull();
    expect(validateDevboxName("box;rm")).not.toBeNull();
  });
});

describe("parseManagedInstances", () => {
  const instance = (id: string, name: string | null, launched: string) => ({
    InstanceId: id,
    State: { Name: "running" },
    InstanceType: "m5.2xlarge",
    LaunchTime: launched,
    ...(name === null ? {} : { Tags: [{ Key: "Name", Value: name }] }),
  });

  it("lists every instance by name", () => {
    const json = JSON.stringify({
      Reservations: [
        { Instances: [instance("i-2", "devbox10", "2026-10-05T00:00:00Z")] },
        { Instances: [instance("i-1", "devbox2", "2026-10-01T00:00:00Z")] },
      ],
    });
    expect(parseManagedInstances(json).map((entry) => entry.name)).toEqual(["devbox2", "devbox10"]);
    expect(parseManagedInstances(JSON.stringify({ Reservations: [] }))).toEqual([]);
  });

  it("falls back to the instance id for missing, unusable, or duplicate names", () => {
    const json = JSON.stringify({
      Reservations: [
        {
          Instances: [
            instance("i-new", "devbox1", "2026-10-05T00:00:00Z"),
            instance("i-old", "devbox1", "2026-10-01T00:00:00Z"),
            instance("i-bad", "bad name", "2026-10-02T00:00:00Z"),
            instance("i-none", null, "2026-10-03T00:00:00Z"),
          ],
        },
      ],
    });
    expect(parseManagedInstances(json).map((entry) => [entry.instanceId, entry.name])).toEqual([
      ["i-old", "devbox1"],
      ["i-bad", "i-bad"],
      ["i-new", "i-new"],
      ["i-none", "i-none"],
    ]);
  });
});

describe("parseDevboxHealth", () => {
  it("keeps each sign-in's status and expiry", () => {
    const line = JSON.stringify({
      aws: { ok: true, detail: "tarun@example.com", expiresAt: "2026-09-24T01:02:00Z" },
      teleport: { ok: true, detail: "tarun@example.com", expiresAt: "2026-09-24T01:31:13-04:00" },
      github: { ok: true, detail: "tarunravi", expiresAt: null },
      claude: { ok: false, detail: "Not logged in", expiresAt: null },
      codex: { ok: true, detail: "Logged in using ChatGPT", expiresAt: "2026-09-28T17:37:00Z" },
      brain: { ok: true, detail: "4b2f5ff brain: sync", expiresAt: null },
    });
    const health = parseDevboxHealth(`motd noise\n${line}\n`);
    expect(health.aws).toEqual({
      ok: true,
      detail: "tarun@example.com",
      expiresAt: "2026-09-24T01:02:00Z",
    });
    expect(health.claude.ok).toBe(false);
    expect(health.github.expiresAt).toBeNull();
  });

  it("treats a missing or malformed entry as signed out", () => {
    const health = parseDevboxHealth(JSON.stringify({ aws: { ok: "yes" } }));
    expect(health.aws.ok).toBe(false);
    expect(health.teleport).toEqual({ ok: false, detail: "Unknown", expiresAt: null });
  });
});

describe("enabling from an AWS profile", () => {
  const awsConfig = [
    "[profile shift]",
    "sso_session = scale",
    "sso_account_id = 1",
    "region = us-gov-west-1",
    "s3 =",
    "  max_concurrent_requests = 2",
    "",
    "[sso-session scale]",
    "sso_start_url = https://start.us-gov-home.awsapps.com/directory/d-1",
    "sso_region = us-gov-west-1",
    "",
    "[default]",
    "region = us-west-2",
  ].join("\n");

  it("lists profiles with their regions", () => {
    expect(parseAwsProfiles(awsConfig)).toEqual([
      { name: "shift", region: "us-gov-west-1" },
      { name: "default", region: "us-west-2" },
    ]);
  });

  it("copies the profile and its SSO session to the devbox", () => {
    const sections = awsProfileSections(awsConfig, "shift");
    expect(sections).toContain("[profile shift]");
    expect(sections).toContain("[sso-session scale]");
    expect(sections).not.toContain("[default]");
    expect(sections).toContain("s3 =\n  max_concurrent_requests = 2");
  });

  it("copies the network from an existing devbox", () => {
    const json = JSON.stringify({
      Reservations: [
        {
          Instances: [
            {
              InstanceType: "m5.2xlarge",
              SubnetId: "subnet-9",
              SecurityGroups: [{ GroupId: "sg-9" }],
              IamInstanceProfile: { Arn: "arn:aws-us-gov:iam::1:instance-profile/DevBox-SSM-Role" },
            },
          ],
        },
      ],
    });
    expect(parseLaunchTemplate(json)).toEqual({
      instanceType: "m5.2xlarge",
      subnetId: "subnet-9",
      securityGroupId: "sg-9",
      instanceProfile: "DevBox-SSM-Role",
    });
  });
});

describe("sign-ins", () => {
  const base = { awsProfile: "shift", callbackPort: 50123 } as const;

  it("tunnels a devbox Teleport callback to the same local port", () => {
    const command = loginCommand({ ...base, target: "devbox2", provider: "teleport" });
    expect(command.command).toBe("ssh");
    expect(command.args).toContain("devbox2");
    expect(command.args).toContain("50123:127.0.0.1:50123");
    expect(command.args.at(-1)).toContain("--bind-addr=127.0.0.1:50123");
  });

  it("tunnels Codex's fixed callback port for the devbox", () => {
    const command = loginCommand({ ...base, target: "devbox1", provider: "codex" });
    expect(command.args).toContain("1455:127.0.0.1:1455");
  });

  it("streams the GitHub token on stdin, never on the command line", () => {
    const command = loginCommand({
      ...base,
      target: "devbox1",
      provider: "github",
      credential: "gho_secret",
    });
    expect(command.stdin).toBe("gho_secret\n");
    expect(command.args.join(" ")).not.toContain("gho_secret");
  });

  it("runs Mac sign-ins in a pseudo-terminal", () => {
    const command = loginCommand({ ...base, target: "mac", provider: "aws" });
    expect(command.command).toBe("python3");
    expect(command.args.at(-1)).toBe(
      "aws sso logout --profile 'shift' >/dev/null 2>&1 || true; aws sso login --profile 'shift' --no-browser",
    );
    expect(command.opensBrowser).toBe(false);
  });

  it("logs out before every sign-in so the new session is fresh", () => {
    for (const provider of ["aws", "teleport", "codex", "claude"] as const) {
      const command = loginCommand({ ...base, target: "mac", provider });
      expect(command.args.at(-1)).toMatch(/logout.*; .*login/u);
    }
  });

  it("copies this Mac's Claude session to the devbox instead of a paste-back login", () => {
    const command = loginCommand({
      ...base,
      target: "devbox1",
      provider: "claude",
      credential: '{"claudeAiOauth":{}}',
    });
    expect(command.stdin).toBe('{"claudeAiOauth":{}}\n');
    expect(command.args.join(" ")).toContain(".credentials.json");
    expect(command.args.join(" ")).not.toContain("claudeAiOauth");
  });

  it("finds approval links and device codes in terminal output", () => {
    const output =
      "\u001b[1mOpen\u001b[0m https://start.us-gov-home.awsapps.com/directory/d-1/#/device\r\nThen enter the code:\r\n\r\nWXYZ-ABCD\r\n";
    expect(extractLinks(output)).toEqual([
      "https://start.us-gov-west-1.us-gov-home.awsapps.com/directory/d-1/#/device",
    ]);
    expect(
      extractLinks(
        "Starting server on http://localhost:1455.\nOpen https://auth.openai.com/oauth/authorize?x=1\n",
      ),
    ).toEqual(["https://auth.openai.com/oauth/authorize?x=1", "http://localhost:1455"]);
    expect(extractCodes(output)).toEqual(["WXYZ-ABCD"]);
  });
});

describe("ssoSessionExpiry", () => {
  const config = [
    "[profile shift]",
    "sso_session = scale",
    "region = us-gov-west-1",
    "[profile legacy]",
    "sso_start_url = https://legacy.awsapps.com/start",
    "[profile keys]",
    "region = us-east-1",
    "[sso-session scale]",
    "sso_start_url = https://scale.awsapps.com/start",
  ].join("\n");
  const token = (startUrl: string, expiresAt: string) =>
    JSON.stringify({ startUrl, accessToken: "secret", expiresAt });

  it("reads the latest token for the profile's sso-session start URL", () => {
    expect(
      ssoSessionExpiry(config, "shift", [
        token("https://scale.awsapps.com/start", "2026-10-06T10:00:00Z"),
        token("https://scale.awsapps.com/start", "2026-10-06T18:00:00Z"),
        token("https://legacy.awsapps.com/start", "2026-10-07T00:00:00Z"),
        // Client registrations share the directory but carry no access token.
        JSON.stringify({
          startUrl: "https://scale.awsapps.com/start",
          expiresAt: "2027-01-01T00:00:00Z",
        }),
        "not json",
      ]),
    ).toBe("2026-10-06T18:00:00Z");
  });

  it("supports legacy profiles that set the start URL directly", () => {
    expect(
      ssoSessionExpiry(config, "legacy", [
        token("https://legacy.awsapps.com/start", "2026-10-07T00:00:00Z"),
      ]),
    ).toBe("2026-10-07T00:00:00Z");
  });

  it("is unknown for profiles without SSO or without a cached token", () => {
    expect(
      ssoSessionExpiry(config, "keys", [
        token("https://scale.awsapps.com/start", "2026-10-07T00:00:00Z"),
      ]),
    ).toBeNull();
    expect(ssoSessionExpiry(config, "shift", [])).toBeNull();
    expect(ssoSessionExpiry(config, "missing", [])).toBeNull();
  });
});

describe("validateAwsProfileName", () => {
  it("accepts typical profile names and rejects shell metacharacters", () => {
    expect(validateAwsProfileName("shift-admin.prod_1")).toBeNull();
    expect(validateAwsProfileName("shift'; rm -rf ~")).toMatch(/Unexpected AWS profile name/u);
    expect(validateAwsProfileName("")).not.toBeNull();
  });
});
