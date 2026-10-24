import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vite-plus/test";

const mobileRoot = path.resolve(import.meta.dirname, "..");
const keychainGroups = ["$(AppIdentifierPrefix)com.t3tools.t3code"];
const compose = `
const { compileModsAsync } = require("expo/config-plugins");
const { getConfig } = require("expo/config");
(async () => {
  const { exp } = getConfig(process.cwd(), { isModdedConfig: true });
  const result = await compileModsAsync(
    { ...exp, mods: { ios: { entitlements: exp.mods.ios.entitlements } } },
    { projectRoot: process.argv[1], platforms: ["ios"], introspect: true, ignoreExistingNativeFiles: true },
  );
  console.log("T3_ENTITLEMENTS=" + JSON.stringify({
    personalTeam: exp.extra.iosPersonalTeamBuild,
    entitlements: result.ios.entitlements,
  }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

function regenerateEntitlements(personalTeam) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-personal-entitlements-"));
  try {
    // Expo caches dynamic config imports, so each variant needs a fresh process.
    const output = execFileSync(process.execPath, ["--eval", compose, root], {
      cwd: mobileRoot,
      env: {
        ...process.env,
        APP_VARIANT: "production",
        T3CODE_IOS_PERSONAL_TEAM: personalTeam ? "1" : "0",
        T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.tarun.t3code",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    const result = JSON.parse(
      output
        .split("\n")
        .find((line) => line.startsWith("T3_ENTITLEMENTS="))
        .slice(16),
    );
    console.log(JSON.stringify(result));
    expect(result.personalTeam).toBe(personalTeam);
    return result.entitlements;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("registered iOS Personal Team capabilities", () => {
  it("omits unsupported capabilities without changing keychain groups", () => {
    const entitlements = regenerateEntitlements(true);
    expect(entitlements["aps-environment"]).toBeUndefined();
    expect(entitlements["com.apple.developer.applesignin"]).toBeUndefined();
    expect(entitlements["com.apple.security.application-groups"]).toBeUndefined();
    expect(entitlements["keychain-access-groups"]).toEqual(keychainGroups);
  });

  it("retains the non-Personal production capabilities and keychain groups", () => {
    const entitlements = regenerateEntitlements(false);
    // Preserve the existing non-Personal composition, including its APNs mode.
    expect(entitlements["aps-environment"]).toBe("development");
    expect(entitlements["com.apple.developer.applesignin"]).toEqual(["Default"]);
    expect(entitlements["com.apple.security.application-groups"]).toContain(
      "group.com.t3tools.t3code",
    );
    expect(entitlements["keychain-access-groups"]).toEqual(keychainGroups);
  });
});
