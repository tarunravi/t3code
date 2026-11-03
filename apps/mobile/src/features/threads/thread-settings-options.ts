import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

export function runtimeModeChoicesForSupportedModes(
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  return supportedRuntimeModes !== undefined
    ? RUNTIME_MODE_CHOICES.filter((choice) => supportedRuntimeModes.includes(choice.mode))
    : RUNTIME_MODE_CHOICES;
}

export type RuntimeModeChoice = (typeof RUNTIME_MODE_CHOICES)[number] & {
  /** Set when a target environment's managed policy caps runtime modes below this one. */
  readonly disabledReason?: string;
};

/**
 * Marks modes above a managed runtime ceiling. A control acting on several environments is
 * managed when any of them is, so the first target that refuses a mode supplies its reason.
 */
export function withManagedRuntimeModeLimits(
  choices: ReadonlyArray<RuntimeModeChoice>,
  policies: ReadonlyArray<ManagedPolicySummary | undefined>,
): ReadonlyArray<RuntimeModeChoice> {
  return choices.map((choice) => {
    const reason = policies
      .map((policy) => managedRuntimeModeDenial(policy, choice.mode))
      .find((denial) => denial !== undefined);
    return reason === undefined ? choice : { ...choice, disabledReason: reason };
  });
}

/** Legacy drafts select Full access; managed denial remains visible instead of choosing a narrower mode. */
export function resolveNewThreadRuntimeMode(
  _draftMode: RuntimeMode | undefined,
  _defaultMode: RuntimeMode,
  _policy: ManagedPolicySummary | undefined,
): RuntimeMode {
  return "full-access";
}

export function compatibleRuntimeModeForChoices(
  _runtimeMode: RuntimeMode,
  _choices: ReadonlyArray<{ readonly mode: RuntimeMode }>,
): RuntimeMode {
  return "full-access";
}

export { selectableProviderOptionChoices as selectableChoices } from "@t3tools/client-runtime/model-traits";
