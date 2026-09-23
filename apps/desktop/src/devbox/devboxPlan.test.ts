import { describe, expect, it } from "vite-plus/test";

import {
  buildSshConfigBlock,
  buildUserData,
  parseDevboxHealth,
  parseManagedInstance,
  runInstancesArgs,
  upsertSshConfigBlock,
} from "./devboxPlan.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample tarun@mac";

describe("upsertSshConfigBlock", () => {
  const block = buildSshConfigBlock("i-0abc123");

  it("prepends so a later Host * cannot shadow the devbox", () => {
    const next = upsertSshConfigBlock("Host *\n    User nobody\n", block);
    expect(next.indexOf("Host t3-devbox")).toBeLessThan(next.indexOf("Host *"));
    expect(next).toContain("Host *\n    User nobody\n");
  });

  it("replaces the managed block in place and keeps the rest", () => {
    const first = upsertSshConfigBlock("Host devbox\n    HostName i-old\n", block);
    const second = upsertSshConfigBlock(first, buildSshConfigBlock("i-0def456"));
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
    expect(() => buildSshConfigBlock("i-0abc\nHost evil")).toThrow();
  });
});

describe("launch arguments", () => {
  it("authorizes exactly the given public key", () => {
    expect(buildUserData(`${KEY}\n`)).toBe(`#cloud-config\nssh_authorized_keys:\n  - ${KEY}\n`);
    expect(() => buildUserData("-----BEGIN OPENSSH PRIVATE KEY-----")).toThrow();
  });

  it("tags the instance as managed so discovery finds it", () => {
    const args = runInstancesArgs({ amiId: "ami-1", userData: buildUserData(KEY) });
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
      github: "tarunravi",
      claude: '{ "loggedIn": true, "email": "tarun@example.com" }',
      codex: "Logged in using ChatGPT",
      brain: "4b2f5ff brain: sync",
    });
    const health = parseDevboxHealth(`motd noise\n${line}\n`);
    expect(health.github).toEqual({ ok: true, detail: "tarunravi" });
    expect(health.claude).toEqual({ ok: true, detail: "tarun@example.com" });
    expect(health.codex.ok).toBe(true);
    expect(health.brain.ok).toBe(true);
  });

  it("reports logged-out tools", () => {
    const line = JSON.stringify({
      github: "error connecting to api.github.com",
      claude: '{ "loggedIn": false }',
      codex: "Not logged in",
      brain: "fatal: not a git repository",
    });
    const health = parseDevboxHealth(line);
    expect(Object.values(health).every((check) => !check.ok)).toBe(true);
  });
});
