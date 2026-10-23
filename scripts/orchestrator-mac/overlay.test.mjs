import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const read = (root, name) => readFileSync(path.join(root, name), "utf8");
const packagePath = "apps/desktop/package.json";
const brandingPath = "apps/desktop/src/app/DesktopEnvironment.ts";
const buildPath = "scripts/build-desktop-artifact.ts";
const userDataPath = "apps/desktop/src/app/DesktopUserData.ts";

for (const flavor of ["normal", "orchestrator"]) {
  test(`${flavor} overlay applies without changing unrelated build configuration`, () => {
    const patchName = flavor === "normal" ? "normal-overlay.patch" : "overlay.patch";
    const patch = read(repo, `scripts/orchestrator-mac/${patchName}`);
    const targets = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
    const fixture = mkdtempSync(path.join(tmpdir(), "t3-overlay-"));
    const home = "/fixture/backend-home";
    try {
      for (const name of new Set([...targets, userDataPath])) {
        assert.ok(!path.isAbsolute(name) && !name.split("/").includes(".."));
        mkdirSync(path.dirname(path.join(fixture, name)), { recursive: true });
        copyFileSync(path.join(repo, name), path.join(fixture, name));
      }
      const before = new Map([...new Set([...targets, userDataPath])].map((name) => [name, read(fixture, name)]));
      const apply = (...args) => {
        const result = spawnSync("git", ["apply", ...args, "-"], {
          cwd: fixture,
          input: patch.replaceAll("__T3CODE_HOME__", home),
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: path.dirname(fixture) },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
      };
      apply("--check");
      for (const [name, original] of before) assert.equal(read(fixture, name), original);
      apply();

      const orchestrator = flavor === "orchestrator";
      assert.equal(JSON.parse(read(fixture, packagePath)).productName, orchestrator ? "T3Code" : "T3 Code");
      assert.equal(
        read(fixture, brandingPath),
        before.get(brandingPath).replace(
          "displayName: `${APP_BASE_NAME} (${stageLabel})`,",
          'displayName: stageLabel === "Beta" ? ' +
            (orchestrator ? '"T3Code"' : "APP_BASE_NAME") +
            ' : `${APP_BASE_NAME} (${stageLabel})`,',
        ),
      );
      const environment = `        LSEnvironment: {\n          T3CODE_HOME: "${home}",\n          T3CODE_DISABLE_AUTO_UPDATE: "true",\n        },\n`;
      let expectedBuild = before.get(buildPath).replace("        NSCameraUsageDescription:\n", `${environment}        NSCameraUsageDescription:\n`);
      if (orchestrator) {
        expectedBuild = expectedBuild.replace('const DESKTOP_APP_ID = "com.t3tools.t3code";', 'const DESKTOP_APP_ID = "com.t3tools.t3code.orchestrator";');
      } else {
        assert.deepEqual(targets, [packagePath, brandingPath, buildPath]);
        assert.equal(read(fixture, packagePath), before.get(packagePath).replace('"productName": "T3 Code (Beta)"', '"productName": "T3 Code"'));
        assert.equal(read(fixture, userDataPath), before.get(userDataPath));
      }
      // Exact equality preserves camera/microphone, signing, passkey and publish guards.
      assert.equal(read(fixture, buildPath), expectedBuild);
      assert.equal(read(fixture, buildPath).split("LSEnvironment:").length - 1, 1);
      assert.match(read(fixture, userDataPath), orchestrator ? /current: "t3code-pr-2829"/ : /current: "t3code-v2"/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
