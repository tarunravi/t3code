/* oxlint-disable t3code/no-global-process-runtime -- Packaging must compare the build host with the executable target. */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

async function prepareCache({ appOutDir, electronPlatformName, arch, packager }) {
  // Linux packaging and relocated AppImage cache reuse still need native validation.
  if (electronPlatformName !== "darwin" && electronPlatformName !== "win32") {
    console.log(`[server-compile-cache] Skipping unsupported target ${electronPlatformName}`);
    return;
  }
  const targetArch = ["ia32", "x64", "armv7l", "arm64", "universal"][arch];
  const runsWithRosetta =
    electronPlatformName === "darwin" &&
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    targetArch === "x64";
  if (
    electronPlatformName !== process.platform ||
    (targetArch !== process.arch && !runsWithRosetta)
  ) {
    console.log(
      `[server-compile-cache] Skipping unexecutable target ${electronPlatformName}/${targetArch}`,
    );
    return;
  }
  const product = packager.appInfo.productFilename;
  const resources =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${product}.app`, "Contents", "Resources")
      : path.join(appOutDir, "resources");
  const executable =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${product}.app`, "Contents", "MacOS", product)
      : path.join(
          appOutDir,
          electronPlatformName === "win32" ? `${product}.exe` : packager.executableName,
        );
  const helper = path.join(
    resources,
    "app.asar",
    "apps/desktop/dist-electron/serverCompileCache.cjs",
  );
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("NODE_") || name.startsWith("T3CODE_")) delete env[name];
  }
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "t3-release-cache-"));
  env.T3CODE_HOME = state;
  let result;
  try {
    // Run a script file, not -e: -e defines a global __filename of "[eval]", which
    // @effect/platform-node passes to createRequire and fails on.
    const runner = path.join(state, "prepare-server-compile-cache-runner.cjs");
    fs.writeFileSync(
      runner,
      `require(${JSON.stringify(helper)}).generatePreparedServerCache(${JSON.stringify(resources)}).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`,
    );
    result = spawnSync(executable, [runner], { env, encoding: "utf8", timeout: 120000 });
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
  if (result.status !== 0)
    throw new Error(
      `Server compile cache generation failed: ${result.error || result.signal || result.stderr}`,
    );
  console.log("[server-compile-cache] Prepared server bytecode with packaged Electron");
}

module.exports = async (context) => {
  // Managed Macs must sign their own app before any packaged-engine execution.
  if (
    context.electronPlatformName === "darwin" &&
    process.env.T3CODE_DESKTOP_DEFER_MAC_VALIDATION === "1"
  ) {
    console.log(
      "[server-compile-cache] Deferred to external Mac signing; artifact is not yet validated",
    );
    return;
  }
  return prepareCache(context);
};

module.exports.prepareMacApp = async (app, bundleId, targetArch) => {
  if (
    process.platform !== "darwin" ||
    !["arm64", "x64"].includes(targetArch) ||
    (process.arch !== targetArch && !(process.arch === "arm64" && targetArch === "x64"))
  )
    throw new Error("Signed Mac cache generation requires a runnable macOS target");
  const verified = spawnSync(
    "/bin/bash",
    [path.join(__dirname, "orchestrator-mac/verify-signature.sh"), app, bundleId],
    { encoding: "utf8" },
  );
  if (verified.status !== 0)
    throw new Error(
      `Mac signature/policy verification failed: ${verified.error || verified.stderr}`,
    );
  await prepareCache({
    appOutDir: path.dirname(app),
    electronPlatformName: "darwin",
    arch: targetArch === "arm64" ? 3 : 1,
    packager: { appInfo: { productFilename: path.basename(app, ".app") } },
  });
};

if (require.main === module) {
  const [app, bundleId, targetArch] = process.argv.slice(2);
  if (!app || !bundleId || !targetArch)
    throw new Error(
      "usage: prepare-server-compile-cache.cjs <App.app> <bundle-id> <arm64|x64>",
    );
  module.exports.prepareMacApp(app, bundleId, targetArch).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
