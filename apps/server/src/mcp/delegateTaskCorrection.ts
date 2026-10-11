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
  const roster = capabilities.threadRoster;
  if (roster !== undefined) {
    const entry = roster.entries.find((candidate) => candidate.available);
    if (entry === undefined) return undefined;
    const options = selectionsToRecord(entry.target.options);
    return {
      providerInstanceId: entry.target.providerInstanceId,
      model: entry.target.model,
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
  const roster = capabilities.threadRoster;
  const omittedTarget =
    roster === undefined
      ? "Without a thread roster, omit target to inherit this thread's provider, model, and options."
      : "With a thread roster, omitting target uses its first matching entry in preference order; targets outside the roster are not allowed. Use an available roster target if the first entry is unavailable.";
  const lines = [
    `How to fix: pass a non-empty \`task\`, choose target.providerInstanceId and target.model from the targets below, set target.options only to listed ids and values, and use mode 'async' or 'wait'. ${omittedTarget}`,
  ];
  if (roster !== undefined) {
    lines.push("This thread's subagents (use only these):");
    for (const entry of roster.entries) {
      const model = capabilities.providers
        .find((provider) => provider.providerInstanceId === entry.target.providerInstanceId)
        ?.models.find((candidate) => candidate.id === entry.target.model);
      const options = model?.options?.map(describeOption) ?? [];
      const details = entry.available ? [] : ["unavailable"];
      const suffix = details.length === 0 ? "" : ` [${details.join(", ")}]`;
      const description = entry.description === null ? "" : ` — ${entry.description}`;
      const optionList = options.length === 0 ? "" : ` (options: ${options.join("; ")})`;
      lines.push(
        `- ${entry.target.providerInstanceId} / ${entry.target.model}${suffix}${optionList}${description}`,
      );
    }
  }
  if (roster === undefined) {
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
  }
  const target = exampleTarget(capabilities);
  if (target !== undefined) {
    lines.push(
      `Example: ${JSON.stringify({
        task: "...",
        target,
        mode: "async",
      })}`,
    );
  } else if (roster !== undefined) {
    lines.push(
      "No available thread-roster target can run this task; check orchestrator_capabilities.",
    );
  }
  return lines.join("\n");
}
