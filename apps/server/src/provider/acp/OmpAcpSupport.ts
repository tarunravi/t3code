/**
 * oh-my-pi (`omp`) runs as a local ACP agent (`omp acp`). Its sessions
 * advertise model and thinking-level config options, which the ACP Registry
 * discovery turns into T3's model picker and per-model options. This module
 * holds what is specific to omp: its launch command, how it reports token
 * usage, and its one-shot print mode for text generation.
 */
import {
  AcpRegistrySettings,
  ProviderDriverKind,
  type OmpSettings,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

export const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");
export const OMP_DEFAULT_BINARY = "omp";

const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);

/** The local ACP command T3 runs for an omp instance: `<binary> acp <launch args>`. */
export function ompAcpRegistrySettings(settings: OmpSettings): AcpRegistrySettings {
  return decodeAcpRegistrySettings({
    source: "local",
    enabled: settings.enabled,
    commandPath: settings.binaryPath || OMP_DEFAULT_BINARY,
    commandArgs: ["acp", ...tokenizeCliArgs(settings.launchArgs)],
    customModels: [...settings.customModels],
  });
}

/**
 * omp's `session/prompt` usage is the turn's delta of its session totals, and
 * its input count excludes cache reads and writes. T3 normalizes input to
 * include both.
 */
export function ompPromptTurnTokenUsage(input: {
  readonly usage: EffectAcpSchema.Usage;
  readonly status: string;
  readonly hasSubagents: boolean;
}): TurnTokenUsage {
  const cachedInputTokens = input.usage.cachedReadTokens ?? 0;
  const cacheCreationTokens = input.usage.cachedWriteTokens ?? 0;
  return {
    usageScope: "main_agent",
    usageStatus: input.status === "completed" ? "complete" : "partial",
    inputTokens: input.usage.inputTokens + cachedInputTokens + cacheCreationTokens,
    outputTokens: input.usage.outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
    ...(input.usage.thoughtTokens == null ? {} : { reasoningTokens: input.usage.thoughtTokens }),
    hasSubagents: input.hasSubagents,
  };
}

// omp lets `--tools` override `--no-tools`, so the user's tool list must not
// reach a background helper that is meant to be read-only.
function withoutToolSelection(args: ReadonlyArray<string>): Array<string> {
  const kept: Array<string> = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--tools") {
      index++;
      continue;
    }
    if (arg.startsWith("--tools=")) continue;
    kept.push(arg);
  }
  return kept;
}

/**
 * Arguments for one ephemeral, tool-less `omp -p` run that reads its prompt
 * from stdin. Launch arguments still apply so `--model`, `--thinking`, and
 * config overlays match the instance; a picked model or thinking level wins.
 */
export function ompPrintArgs(input: {
  readonly launchArgs: string;
  readonly model: string;
  readonly thinking: string | undefined;
}): Array<string> {
  return [
    ...withoutToolSelection(tokenizeCliArgs(input.launchArgs)),
    ...(input.model === "default" ? [] : ["--model", input.model]),
    ...(input.thinking === undefined ? [] : ["--thinking", input.thinking]),
    "-p",
    "--no-session",
    "--no-tools",
    "--no-title",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-lsp",
  ];
}
