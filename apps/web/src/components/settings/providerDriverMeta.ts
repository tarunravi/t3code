import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  OmpSettings,
  ProviderDriverKind,
  ZCodeSettings,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  {
    driverKind: ProviderDriverKind.make("zcode"),
    label: "ZCode",
    badgeLabel: "Early Access",
    settingsSchema: ZCodeSettings,
    hasDefaultInstance: false,
    environmentFields: [
      {
        name: "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
        label: "Personal provider config",
        description:
          "Optional. Absolute path to the ZCode provider_config.json this instance uses.",
        placeholder: "/path/to/provider_config.json",
      },
      {
        name: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
        label: "Built-in provider config",
        description: "Optional. Overrides ZCode's bundled provider catalog.",
      },
    ],
  },
  {
    driverKind: ProviderDriverKind.make("omp"),
    label: "oh-my-pi",
    settingsSchema: OmpSettings,
    hasDefaultInstance: false,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
