import type { DesktopAwsLoginStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { classifyAwsLogin, defaultAwsProfile, formatExpiresIn } from "./awsLogin";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const status = (patch: Partial<DesktopAwsLoginStatus>): DesktopAwsLoginStatus => ({
  awsProfile: "shift",
  ok: true,
  detail: "tarun",
  expiresAt: null,
  ...patch,
});

describe("classifyAwsLogin", () => {
  it("is off until a profile is watched", () => {
    expect(classifyAwsLogin(null, NOW)).toBe("off");
    expect(classifyAwsLogin(status({ awsProfile: null, ok: false }), NOW)).toBe("off");
  });

  it("is missing when the credential check fails or the session has lapsed", () => {
    expect(classifyAwsLogin(status({ ok: false, expiresAt: "2026-10-06T20:00:00Z" }), NOW)).toBe(
      "missing",
    );
    expect(classifyAwsLogin(status({ expiresAt: "2026-10-06T11:59:00Z" }), NOW)).toBe("missing");
  });

  it("warns within an hour of expiry", () => {
    expect(classifyAwsLogin(status({ expiresAt: "2026-10-06T12:59:00Z" }), NOW)).toBe("expiring");
    expect(classifyAwsLogin(status({ expiresAt: "2026-10-06T13:00:00Z" }), NOW)).toBe("ok");
  });

  it("is ok for credentials without a known SSO expiry", () => {
    expect(classifyAwsLogin(status({ expiresAt: null }), NOW)).toBe("ok");
    expect(classifyAwsLogin(status({ expiresAt: "garbage" }), NOW)).toBe("ok");
  });
});

describe("defaultAwsProfile", () => {
  const profiles = [
    { name: "shift", region: "us-gov-west-1" },
    { name: "sandbox", region: "us-west-2" },
  ];

  it("prefers the last-used profile, even a typed one missing from ~/.aws/config", () => {
    expect(defaultAwsProfile(profiles, "sandbox")).toBe("sandbox");
    expect(defaultAwsProfile(profiles, "typed-only")).toBe("typed-only");
  });

  it("falls back to the only profile, and never guesses between several", () => {
    expect(defaultAwsProfile([profiles[0]!], null)).toBe("shift");
    expect(defaultAwsProfile(profiles, null)).toBeNull();
    expect(defaultAwsProfile([], undefined)).toBeNull();
  });
});

describe("formatExpiresIn", () => {
  it("counts down in days, hours, or minutes", () => {
    expect(formatExpiresIn("2026-10-08T15:30:00Z", NOW)).toBe("expires in 2d 3h");
    expect(formatExpiresIn("2026-10-06T13:15:00Z", NOW)).toBe("expires in 1h 15m");
    expect(formatExpiresIn("2026-10-06T12:42:30Z", NOW)).toBe("expires in 42m");
    expect(formatExpiresIn("2026-10-06T11:00:00Z", NOW)).toBe("expired");
  });
});
