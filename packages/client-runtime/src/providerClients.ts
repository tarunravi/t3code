import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  OmpSettings,
  ZCodeSettings,
  isProviderDriverKind,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@t3tools/provider-core/client";
import { modelShortName } from "@t3tools/provider-core/modelShortName";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { fxClient } from "@t3tools/provider-fx/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { dshClient } from "@t3tools/provider-dsh/client";
import { piClient } from "@t3tools/provider-pi/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    modelFamilies: ["GPT-", "GPT "],
    acpRegistryAgentIds: ["codex-acp"],
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    modelFamilies: ["Claude "],
    acpRegistryAgentIds: ["claude-acp"],
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  fxClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    modelFamilies: ["Gemini "],
    acpRegistryAgentIds: ["antigravity-acp"],
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
        description: "Optional. Absolute path to provider_config.json.",
        placeholder: "/path/to/provider_config.json",
      },
      {
        name: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
        label: "Built-in provider config",
        description: "Optional. Overrides the bundled provider catalog.",
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
  dshClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

export function resolveModelShortName(
  model: { readonly name: string; readonly shortName?: string | undefined },
  driverKind: ProviderDriverKind | null | undefined,
): string | undefined {
  if (model.shortName) return model.shortName;
  const families = driverKind ? providerClients.get(driverKind)?.modelFamilies : undefined;
  return modelShortName(model.name, families ?? []);
}
