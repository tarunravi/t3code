// Signs a packaged app with @electron/osx-sign: nested code first, then the
// bundle, with hardened runtime and Electron's default entitlements.
//
//   T3_OSX_SIGN_MODULE=<path to @electron/osx-sign 1.x> \
//   T3_SIGNING_IDENTITY=<SHA-1 or name> node sign-app.cjs <App.app>
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { signAsync } = require(process.env.T3_OSX_SIGN_MODULE);

const identity = process.env.T3_SIGNING_IDENTITY;
if (!identity || identity === "-") {
  console.error("Refusing ad hoc signing: set T3_SIGNING_IDENTITY to a real identity.");
  process.exit(1);
}

// Apple's timestamp service only countersigns Apple-issued certificates, so a
// local self-signed identity signs without a timestamp.
const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
  encoding: "utf8",
});
const identityLine = identities.split("\n").find((line) => line.includes(identity)) ?? "";
const isAppleIssued = /"(Developer ID Application|Apple Development|Apple Distribution):/.test(
  identityLine,
);

const macho = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);

// Binary resources such as .pak locales are sealed by their bundle; signing
// them as code fails.
function ignoreResource(file) {
  if (fs.statSync(file).isDirectory()) return false;
  const fd = fs.openSync(file, "r");
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(fd, magic, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  return !macho.has(magic.toString("hex"));
}

signAsync({
  app: process.argv[2],
  identity,
  platform: "darwin",
  type: "distribution",
  preAutoEntitlements: false,
  ignore: ignoreResource,
  optionsForFile: () => ({
    hardenedRuntime: true,
    ...(isAppleIssued ? {} : { timestamp: "none" }),
  }),
}).then(
  () => console.log(`Signed with ${identity}`),
  (error) => {
    console.error(error.message);
    process.exitCode = 1;
  },
);
