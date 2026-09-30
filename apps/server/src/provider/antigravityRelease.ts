const ANTIGRAVITY_RELEASE_VERSION = "1.2.1";

export interface AntigravityReleaseAsset {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly executable: {
    readonly name: string;
    readonly bytes: number;
  };
  readonly harness: {
    readonly name: string;
    readonly bytes: number;
  };
}

// URLs come from the official registry. Hashes and sizes were checked on 2026-09-30.
// 1.2.1 reports agentInfo.version as plain semver, and it parses stringified tool
// arguments that 1.1.1 rejected in the reader loop.
// https://github.com/agentclientprotocol/registry/blob/3ee7f11/antigravity-acp/agent.json
const releaseAssets = new Map<string, AntigravityReleaseAsset>([
  [
    "darwin-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip",
      sha256: "0fab9938812e6b32b3b543e65e4f3a0025ceef755413db13542d9a9b81ea803c",
      archiveBytes: 111_725_488,
      executable: { name: "agy_acp_server.par", bytes: 276_920_768 },
      harness: { name: "localharness_external", bytes: 120_663_872 },
    },
  ],
  [
    "linux-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip",
      sha256: "9fbf0bd584a26478161f637cabd75113f72541c842d148f578ef1a6a9edcb843",
      archiveBytes: 333_590_110,
      executable: { name: "agy_acp_server.par", bytes: 919_951_920 },
      harness: { name: "localharness_external", bytes: 132_815_192 },
    },
  ],
  [
    "linux-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-arm64.zip",
      sha256: "7e7ef4088bc185e1af4204029e0f4ec4210af20724f3ff262186ac0bcea6aa0e",
      archiveBytes: 321_280_184,
      executable: { name: "agy_acp_server.par", bytes: 921_424_555 },
      harness: { name: "localharness_external", bytes: 125_568_904 },
    },
  ],
  [
    "win32-x64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-x86_64.zip",
      sha256: "9b82493819bc14613baa76264d55ad307ddd8ab4a8d6e110edb32da35498c07b",
      archiveBytes: 124_869_770,
      executable: { name: "agy_acp_server.exe", bytes: 81_231_712 },
      harness: { name: "localharness_external.exe", bytes: 147_063_448 },
    },
  ],
  [
    "win32-arm64",
    {
      version: ANTIGRAVITY_RELEASE_VERSION,
      url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-arm64.zip",
      sha256: "21db37ae246284053212f2670e05c4de8d6ee9488b000bf304e1fe4ea191f7b8",
      archiveBytes: 124_945_935,
      executable: { name: "agy_acp_server.exe", bytes: 85_647_280 },
      harness: { name: "localharness_external.exe", bytes: 137_181_336 },
    },
  ],
]);

export function resolveAntigravityReleaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): AntigravityReleaseAsset | null {
  return releaseAssets.get(`${platform}-${arch}`) ?? null;
}
