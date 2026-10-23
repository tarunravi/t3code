import type {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpProviderCapability,
  OrchestratorMcpModelOption,
} from "@t3tools/contracts";

const MAX_MODELS_PER_PROVIDER = 12;

type CorrectionCapabilities = Pick<
  OrchestratorMcpCapabilitiesResult,
  "inheritedProviderInstanceId" | "inheritedModel" | "providers"
>;
type ModelCapability = OrchestratorMcpProviderCapability["models"][number];

function describeOption(descriptor: OrchestratorMcpModelOption): string {
  return `${descriptor.id}=${descriptor.values.join("|")}`;
}

function describeModel(model: ModelCapability): string {
  const options = model.options ?? [];
  return options.length === 0
    ? model.id
    : `${model.id} (${options.map(describeOption).join("; ")})`;
}

/** Show one advertised option, preferring its default when it is an allowed value. */
function exampleOptions(
  model: ModelCapability | undefined,
): Record<string, string | boolean> | undefined {
  const descriptor = model?.options?.find((candidate) => candidate.values.length > 0);
  if (descriptor === undefined) return undefined;
  const value =
    descriptor.default !== undefined && descriptor.values.includes(descriptor.default)
      ? descriptor.default
      : descriptor.values[0]!;
  return { [descriptor.id]: value };
}

function exampleTarget(capabilities: CorrectionCapabilities): Record<string, unknown> | undefined {
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
