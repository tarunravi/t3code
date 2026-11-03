import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeChildProcess from "node:child_process";
import * as NodeTest from "node:test";

const here = import.meta.dirname;
const build = NodeFS.readFileSync(NodePath.join(here, "build.sh"), "utf8");
const packaging = NodeFS.readFileSync(
  NodePath.join(here, "../build-desktop-artifact.ts"),
  "utf8",
);

function loadCacheHook(
  env = {},
  verificationStatus = 0,
  cacheResult = { status: 0 },
) {
  const calls = [];
  const module = { exports: {} };
  const fakeFS = {
    mkdtempSync: () => "/tmp/cache-state",
    writeFileSync: () => {},
    rmSync: () => {},
  };
  const require = (id) => {
    if (id === "node:child_process") {
      return {
        spawnSync: (executable, args, options) => {
          calls.push({ executable, args, options });
          return executable === "/bin/bash"
            ? { status: verificationStatus }
            : cacheResult;
        },
      };
    }
    return { "node:path": NodePath, "node:fs": fakeFS, "node:os": NodeOS }[id];
  };
  NodeVM.runInNewContext(
    NodeFS.readFileSync(
      NodePath.join(here, "../prepare-server-compile-cache.cjs"),
      "utf8",
    ),
    {
      module,
      require,
      __dirname: NodePath.dirname(here),
      console: { log() {} },
      process: { platform: "darwin", arch: "arm64", env },
    },
  );
  return { hook: module.exports, calls };
}

NodeTest.test(
  "external Mac signing defers the pre-sign cache hook without executing the app",
  async () => {
    const { hook, calls } = loadCacheHook({
      T3CODE_DESKTOP_DEFER_MAC_VALIDATION: "1",
    });
    await hook({
      electronPlatformName: "darwin",
      arch: 3,
      appOutDir: "/output",
      packager: { appInfo: { productFilename: "T3Code" } },
    });
    NodeAssert.deepEqual(calls, []);
  },
);

NodeTest.test(
  "the signed cache entry point refuses a failed signature or policy check",
  async () => {
    const { hook, calls } = loadCacheHook({}, 1);
    await NodeAssert.rejects(
      hook.prepareMacApp(
        "/output/T3Code.app",
        "com.t3tools.t3code.orchestrator",
        "arm64",
      ),
      /verification/,
    );
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(calls[0].executable, "/bin/bash");
  },
);

NodeTest.test(
  "the signed cache entry point verifies before executing with isolated state",
  async () => {
    const { hook, calls } = loadCacheHook({
      NODE_OPTIONS: "bad",
      T3CODE_HOME: "/live",
      T3CODE_TEST: "bad",
    });
    await hook.prepareMacApp(
      "/output/T3Code.app",
      "com.t3tools.t3code.orchestrator",
      "arm64",
    );
    NodeAssert.equal(calls[0].executable, "/bin/bash");
    NodeAssert.equal(
      calls[1].executable,
      "/output/T3Code.app/Contents/MacOS/T3Code",
    );
    NodeAssert.equal(calls[1].options.env.T3CODE_HOME, "/tmp/cache-state");
    NodeAssert.equal(calls[1].options.env.ELECTRON_RUN_AS_NODE, "1");
    NodeAssert.equal(calls[1].options.env.NODE_OPTIONS, undefined);
    NodeAssert.equal(calls[1].options.env.T3CODE_TEST, undefined);
  },
);

NodeTest.test(
  "cache generation failure is fatal, not a successful optimization skip",
  async () => {
    const { hook, calls } = loadCacheHook({}, 0, {
      status: null,
      signal: "SIGKILL",
    });
    await NodeAssert.rejects(
      hook.prepareMacApp(
        "/output/T3Code.app",
        "com.t3tools.t3code.orchestrator",
        "arm64",
      ),
      /SIGKILL/,
    );
    NodeAssert.equal(calls.length, 2);
  },
);

NodeTest.test(
  "work-Mac verification enforces the real signature, company Team, and Santa policy",
  () => {
    function verify(overrides = {}) {
      return NodeChildProcess.spawnSync(
        "/bin/bash",
        [
          "-c",
          `
      codesign() {
        case "$1" in
          --verify) return "\${MOCK_INVALID_SIGNATURE:-0}" ;;
          -dvv) printf 'Identifier=com.t3tools.t3code.orchestrator\\nSignature=%s\\nTeamIdentifier=%s\\n' "$MOCK_SIGNATURE" "$MOCK_TEAM" ;;
          -dr) echo 'designated => identifier "com.t3tools.t3code.orchestrator" and anchor apple generic' ;;
          *) return 99 ;;
        esac
      }
      scutil() { echo SGMD6RQH4RH6J; }
      santactl() { echo "$MOCK_RULE"; }
      defaults() { echo T3Code; }
      export -f codesign scutil santactl defaults
      exec /bin/bash "$1" /fake/T3Code.app com.t3tools.t3code.orchestrator
    `,
          "test",
          NodePath.join(here, "verify-signature.sh"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MOCK_SIGNATURE: "real",
            MOCK_TEAM: "5ZL939ZR9U",
            MOCK_RULE: "Allowed (TeamID)",
            ...overrides,
          },
        },
      );
    }
    NodeAssert.equal(verify().status, 0);
    NodeAssert.notEqual(verify({ MOCK_SIGNATURE: "adhoc" }).status, 0);
    NodeAssert.notEqual(verify({ MOCK_TEAM: "WRONGTEAM" }).status, 0);
    NodeAssert.notEqual(verify({ MOCK_RULE: "None" }).status, 0);
    NodeAssert.notEqual(verify({ MOCK_INVALID_SIGNATURE: "1" }).status, 0);
  },
);

NodeTest.test(
  "fork finalization signs, verifies, caches, reseals, and validates the final payload",
  () => {
    NodeAssert.match(build, /T3CODE_DESKTOP_DEFER_MAC_VALIDATION=1/);
    NodeAssert.match(packaging, /deferMacValidation \? \{ identity: null \}/);
    NodeAssert.match(
      build,
      /sign_app\n[\s\S]*verify-signature\.sh[\s\S]*prepare-server-compile-cache\.cjs[\s\S]*sign_app\n[\s\S]*verify-signature\.sh[\s\S]*--validate-mac-app[\s\S]*verify-signature\.sh[\s\S]*BUILD-INFO/,
    );
    NodeAssert.match(
      packaging,
      /!deferMacValidation[\s\S]*validateMacPackagedPayload/,
    );
    NodeAssert.match(
      packaging,
      /--validate-mac-app[\s\S]*verify-signature\.sh[\s\S]*verifyPackagedBundleIsSelfContained/,
    );
    NodeAssert.match(packaging, /pnpmJs \? process\.execPath : "vp"/);
    NodeAssert.match(
      packaging,
      /pnpmJs\s*\?\s*\["--filter", "@t3tools\/desktop", "exec"\]/,
    );
  },
);

NodeTest.test(
  "the pinned toolchain rejects native-dispatch pnpm before invoking it",
  () => {
    const temp = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-toolchain-test-"),
    );
    try {
      NodeFS.mkdirSync(NodePath.join(temp, "bin"));
      NodeFS.writeFileSync(
        NodePath.join(temp, "package.json"),
        JSON.stringify({
          engines: { node: process.versions.node },
          packageManager: "pnpm@12.14.0",
          name: "pnpm",
          version: "12.14.0",
        }),
      );
      const marker = NodePath.join(temp, "executed");
      const launcher = NodePath.join(temp, "bin/pnpm.mjs");
      NodeFS.writeFileSync(
        launcher,
        `// native-binary.mjs\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad');\n`,
      );
      const configure = build.match(
        /^configure_toolchain\(\) \{[\s\S]*?^\}/m,
      )?.[0];
      NodeAssert.ok(
        configure,
        "toolchain selection must be testable without building",
      );
      const result = NodeChildProcess.spawnSync(
        "/bin/bash",
        [
          "-c",
          `set -euo pipefail\ndie() { echo "$*" >&2; exit 1; }\n${configure}\nconfigure_toolchain`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            T3_NODE: process.execPath,
            T3_PNPM_JS: launcher,
            repo: temp,
            machine: "SGMD6RQH4RH6J",
          },
        },
      );
      NodeAssert.notEqual(result.status, 0);
      NodeAssert.match(result.stderr, /native/);
      NodeAssert.equal(NodeFS.existsSync(marker), false);
      NodeFS.writeFileSync(launcher, "console.log('12.14.0');\n");
      const accepted = NodeChildProcess.spawnSync(
        "/bin/bash",
        [
          "-c",
          `set -euo pipefail\ndie() { echo "$*" >&2; exit 1; }\n${configure}\nconfigure_toolchain`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            T3_NODE: process.execPath,
            T3_PNPM_JS: launcher,
            repo: temp,
            machine: "SGMD6RQH4RH6J",
          },
        },
      );
      NodeAssert.equal(accepted.status, 0, accepted.stderr);
      NodeFS.writeFileSync(launcher, "console.log('1.2.3');\n");
      const wrongVersion = NodeChildProcess.spawnSync(
        "/bin/bash",
        [
          "-c",
          `set -euo pipefail\ndie() { echo "$*" >&2; exit 1; }\n${configure}\nconfigure_toolchain`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            T3_NODE: process.execPath,
            T3_PNPM_JS: launcher,
            repo: temp,
            machine: "SGMD6RQH4RH6J",
          },
        },
      );
      NodeAssert.notEqual(wrongVersion.status, 0);
      NodeAssert.match(wrongVersion.stderr, /packageManager=pnpm@12.14.0/);
    } finally {
      NodeFS.rmSync(temp, { recursive: true, force: true });
    }
  },
);
