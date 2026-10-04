import type {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpProviderCapability,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";

const MAX_MODELS_PER_PROVIDER = 12;

type CorrectionCapabilities = Pick<
  OrchestratorMcpCapabilitiesResult,
  "inheritedProviderInstanceId" | "inheritedModel" | "providers" | "threadRoster"
>;
type ModelCapability = OrchestratorMcpProviderCapability["models"][number];

function describeOption(descriptor: ProviderOptionDescriptor): string {
  return descriptor.type === "boolean"
    ? `${descriptor.id}=true|false`
    : `${descriptor.id}=${descriptor.options.map((choice) => choice.id).join("|")}`;
}

function describeModel(model: ModelCapability): string {
  const options = model.options ?? [];
  return options.length === 0
    ? model.id
    : `${model.id} (${options.map(describeOption).join("; ")})`;
}

/** A select option the agent is most likely to vary, set to its default value. */
function exampleOptions(model: ModelCapability | undefined): Record<string, string> | undefined {
  const descriptor = model?.options?.find(
    (candidate) => candidate.type === "select" && candidate.options.length > 0,
  );
  if (descriptor === undefined || descriptor.type !== "select") return undefined;
  const value =
    descriptor.currentValue ??
    descriptor.options.find((choice) => choice.isDefault === true)?.id ??
    descriptor.options[0]!.id;
  return { [descriptor.id]: value };
}

function selectionsToRecord(
  selections: ReadonlyArray<ProviderOptionSelection> | undefined,
): Record<string, string | boolean> | undefined {
  if (selections === undefined || selections.length === 0) return undefined;
  return Object.fromEntries(selections.map((selection) => [selection.id, selection.value]));
}

function exampleTarget(capabilities: CorrectionCapabilities): Record<string, unknown> | undefined {
  const rosterEntries = capabilities.threadRoster?.entries.filter((entry) => entry.available);
  const rosterEntry =
    rosterEntries?.find((entry) => entry.role === "default") ?? rosterEntries?.[0];
  if (rosterEntry !== undefined) {
    const options = selectionsToRecord(rosterEntry.target.options);
    return {
      providerInstanceId: rosterEntry.target.providerInstanceId,
      model: rosterEntry.target.model,
      ...(options === undefined ? {} : { options }),
    };
  }
  const runnable = capabilities.providers.filter(
    (provider) => provider.canRunChildTask && provider.models.length > 0,
  );
  const provider =
    runnable.find(
      (candidate) => candidate.providerInstanceId === capabilities.inheritedProviderInstanceId,
    ) ?? runnable[0];
  if (provider === undefined) return undefined;
  const model =
    provider.models.find((candidate) => candidate.id === capabilities.inheritedModel) ??
    provider.models[0]!;
  const options = exampleOptions(model);
  return {
    providerInstanceId: provider.providerInstanceId,
    model: model.id,
    ...(options === undefined ? {} : { options }),
  };
}

/**
 * Explains how to call delegate_task correctly with values that are actually
 * available right now, so an agent can retry without another discovery call.
 */
export function delegateTaskCorrection(capabilities: CorrectionCapabilities): string {
  const lines = [
    "How to fix: pass a non-empty `task`, choose target.providerInstanceId and target.model from the targets below, set target.options only to listed ids and values, and use mode 'async' or 'wait'. Omit target to inherit this thread's model.",
  ];
  const roster = capabilities.threadRoster;
  if (roster !== undefined) {
    lines.push("This thread's subagents (use only these):");
    for (const entry of roster.entries) {
      const details = [
        ...(entry.role === null ? [] : [entry.role]),
        ...(entry.available ? [] : ["unavailable"]),
      ];
      const suffix = details.length === 0 ? "" : ` [${details.join(", ")}]`;
      const description = entry.description === null ? "" : ` — ${entry.description}`;
      lines.push(
        `- ${entry.target.providerInstanceId} / ${entry.target.model}${suffix}${description}`,
      );
    }
  }
  const runnable = capabilities.providers.filter(
    (provider) => provider.canRunChildTask && provider.models.length > 0,
  );
  if (runnable.length === 0) {
    lines.push("No provider can run a subagent right now; check orchestrator_capabilities.");
  } else {
    lines.push("Available targets (providerInstanceId: model (options)):");
    for (const provider of runnable) {
      const shown = provider.models.slice(0, MAX_MODELS_PER_PROVIDER).map(describeModel);
      const hidden = provider.models.length - shown.length;
      lines.push(
        `- ${provider.providerInstanceId}: ${shown.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`,
      );
    }
  }
  const target = exampleTarget(capabilities);
  lines.push(
    `Example: ${JSON.stringify({
      task: "...",
      ...(target === undefined ? {} : { target }),
      mode: "async",
    })}`,
  );
  return lines.join("\n");
}
