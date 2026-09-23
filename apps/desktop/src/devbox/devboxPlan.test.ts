import { describe, expect, it } from "vite-plus/test";

import {
  awsProfileSections,
  buildSshConfigBlock,
  buildUserData,
  extractCodes,
  extractLinks,
  loginCommand,
  parseAwsProfiles,
  parseDevboxHealth,
  parseLaunchTemplate,
  parseManagedInstance,
  runInstancesArgs,
  upsertSshConfigBlock,
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

describe("upsertSshConfigBlock", () => {
  const block = buildSshConfigBlock(CONFIG, "i-0abc123");

  it("prepends so a later Host * cannot shadow the devbox", () => {
    const next = upsertSshConfigBlock("Host *\n    User nobody\n", block);
    expect(next.indexOf("Host t3-devbox")).toBeLessThan(next.indexOf("Host *"));
    expect(next).toContain("Host *\n    User nobody\n");
  });

  it("replaces the managed block in place and keeps the rest", () => {
    const first = upsertSshConfigBlock("Host devbox\n    HostName i-old\n", block);
    const second = upsertSshConfigBlock(first, buildSshConfigBlock(CONFIG, "i-0def456"));
    expect(second).not.toContain("i-0abc123");
    expect(second.match(/Host t3-devbox/gu)).toHaveLength(1);
    expect(second).toContain("Host devbox\n    HostName i-old\n");
  });

  it("removes only the managed block", () => {
    const original = "Host devbox\n    HostName i-old\n";
    expect(upsertSshConfigBlock(upsertSshConfigBlock(original, block), null)).toBe(original);
  });

  it("routes the alias through SSM", () => {
    expect(block).toContain("HostName i-0abc123");
    expect(block).toContain("aws ssm start-session --target %h");
    expect(block).toContain("PubkeyAcceptedAlgorithms +ssh-ed25519");
    expect(() => buildSshConfigBlock(CONFIG, "i-0abc\nHost evil")).toThrow();
  });
});

describe("launch arguments", () => {
  it("authorizes exactly the given public key", () => {
    expect(buildUserData(`${KEY}\n`)).toBe(`#cloud-config\nssh_authorized_keys:\n  - ${KEY}\n`);
    expect(() => buildUserData("-----BEGIN OPENSSH PRIVATE KEY-----")).toThrow();
  });

  it("tags the instance as managed so discovery finds it", () => {
    const args = runInstancesArgs({ config: CONFIG, amiId: "ami-1", userData: buildUserData(KEY) });
    const tags = JSON.parse(args[args.indexOf("--tag-specifications") + 1]!) as Array<{
      Tags: Array<{ Key: string; Value: string }>;
    }>;
    expect(tags[0]!.Tags).toContainEqual({ Key: "t3-managed", Value: "true" });
    expect(args).toContain("--profile");
    expect(args).toContain("HttpTokens=required,HttpEndpoint=enabled");
  });
});

describe("parseManagedInstance", () => {
  it("picks the newest instance", () => {
    const json = JSON.stringify({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-old",
              State: { Name: "stopped" },
              InstanceType: "m5.2xlarge",
              LaunchTime: "2026-09-01T00:00:00Z",
            },
          ],
        },
        {
          Instances: [
            {
              InstanceId: "i-new",
              State: { Name: "running" },
              InstanceType: "m5.2xlarge",
              LaunchTime: "2026-09-23T00:00:00Z",
            },
          ],
        },
      ],
    });
    expect(parseManagedInstance(json)?.instanceId).toBe("i-new");
    expect(parseManagedInstance(JSON.stringify({ Reservations: [] }))).toBeNull();
  });
});

describe("parseDevboxHealth", () => {
  it("reads each tool's status from the health line", () => {
    const line = JSON.stringify({
      aws: "arn:aws-us-gov:sts::1:assumed-role/Admin/tarun@example.com",
      teleport:
        "> Profile URL: https://teleport  Logged in as: tarun@example.com  Valid until: 2026-09-24 [valid for 11h0m0s]",
      github: "tarunravi",
      claude: '{ "loggedIn": true, "email": "tarun@example.com" }',
      codex: "Logged in using ChatGPT",
      brain: "4b2f5ff brain: sync",
    });
    const health = parseDevboxHealth(`motd noise\n${line}\n`);
    expect(health.aws).toEqual({ ok: true, detail: "tarun@example.com" });
    expect(health.teleport).toEqual({ ok: true, detail: "tarun@example.com" });
    expect(health.github).toEqual({ ok: true, detail: "tarunravi" });
    expect(health.claude).toEqual({ ok: true, detail: "tarun@example.com" });
    expect(health.codex.ok).toBe(true);
    expect(health.brain.ok).toBe(true);
  });

  it("reports logged-out tools", () => {
    const line = JSON.stringify({
      aws: "Error when retrieving token from sso: Token has expired and refresh failed",
      teleport: "Not logged in.",
      github: "error connecting to api.github.com",
      claude: '{ "loggedIn": false }',
      codex: "Not logged in",
      brain: "fatal: not a git repository",
    });
    const health = parseDevboxHealth(line);
    expect(Object.values(health).every((check) => !check.ok)).toBe(true);
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
    const command = loginCommand({ ...base, target: "devbox", provider: "teleport" });
    expect(command.command).toBe("ssh");
    expect(command.args).toContain("50123:127.0.0.1:50123");
    expect(command.args.at(-1)).toContain("--bind-addr=127.0.0.1:50123");
  });

  it("tunnels Codex's fixed callback port for the devbox", () => {
    const command = loginCommand({ ...base, target: "devbox", provider: "codex" });
    expect(command.args).toContain("1455:127.0.0.1:1455");
  });

  it("streams the GitHub token on stdin, never on the command line", () => {
    const command = loginCommand({
      ...base,
      target: "devbox",
      provider: "github",
      githubToken: "gho_secret",
    });
    expect(command.stdin).toBe("gho_secret\n");
    expect(command.args.join(" ")).not.toContain("gho_secret");
  });

  it("runs Mac sign-ins in a pseudo-terminal", () => {
    const command = loginCommand({ ...base, target: "mac", provider: "aws" });
    expect(command.command).toBe("script");
    expect(command.args.at(-1)).toBe("aws sso login --profile 'shift' --no-browser");
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
