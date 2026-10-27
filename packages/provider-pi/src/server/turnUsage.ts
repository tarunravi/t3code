import type { TurnTokenUsage } from "@t3tools/contracts";
import { piRecordField, piRecordNumber, piRecordString } from "./rpc.ts";

export function piMessageUsage(usage: unknown): TurnTokenUsage {
  const count = (key: string) => {
    const value = piRecordNumber(usage, key);
    return value !== undefined && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : undefined;
  };
  const input = count("input");
  const output = count("output");
  if (input === undefined && output === undefined)
    return { usageStatus: "unavailable", usageScope: "main_agent", hasSubagents: false };
  const cached = count("cacheRead") ?? 0;
  const creation = count("cacheWrite") ?? 0;
  return {
    usageStatus: "partial",
    usageScope: "main_agent",
    hasSubagents: false,
    ...(input === undefined ? {} : { inputTokens: input + cached + creation }),
    ...(output === undefined ? {} : { outputTokens: output }),
    cachedInputTokens: cached,
    cacheCreationTokens: creation,
    ...(count("reasoning") === undefined
      ? {}
      : { reasoningTokens: Math.min(output ?? 0, count("reasoning")!) }),
  };
}

export function piServedModel(message: unknown): string | undefined {
  const provider = piRecordString(message, "provider")?.trim();
  const model = (
    piRecordString(message, "responseModel") ?? piRecordString(message, "model")
  )?.trim();
  return provider && model ? `${provider}/${model}` : undefined;
}

export function piReportedCost(usage: unknown, local: boolean): number | undefined {
  const cost = piRecordNumber(piRecordField(usage, "cost"), "total");
  return cost !== undefined && Number.isFinite(cost) && (cost > 0 || (local && cost === 0))
    ? cost
    : undefined;
}
