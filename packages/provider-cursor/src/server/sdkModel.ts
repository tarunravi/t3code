import type { ModelSelection as CursorSdkModelSelection, ModelParameterValue } from "@cursor/sdk";
import type { ModelSelection } from "@t3tools/contracts";

const CURSOR_SDK_PARAMETER_TO_PROVIDER_OPTION: Readonly<Record<string, string>> = {
  context: "contextWindow",
  fast: "fastMode",
};

const PROVIDER_OPTION_TO_CURSOR_SDK_PARAMETER: Readonly<Record<string, string>> = {
  contextWindow: "context",
  fastMode: "fast",
};

export function cursorSdkProviderOptionId(parameterId: string): string {
  return CURSOR_SDK_PARAMETER_TO_PROVIDER_OPTION[parameterId] ?? parameterId;
}

function cursorSdkParameterId(providerOptionId: string): string {
  return PROVIDER_OPTION_TO_CURSOR_SDK_PARAMETER[providerOptionId] ?? providerOptionId;
}

export function cursorSdkParameterPriority(parameterId: string): number {
  switch (parameterId) {
    case "effort":
    case "reasoning":
      return 0;
    case "context":
      return 1;
    case "fast":
      return 2;
    case "thinking":
      return 3;
    default:
      return 4;
  }
}

const GROK_47_DEFAULT_CONTEXT_TOKENS = 500_000;

function contextWindowOption(modelSelection: ModelSelection): string | undefined {
  const value = modelSelection.options?.find((option) => option.id === "contextWindow")?.value;
  return typeof value === "string" ? value : undefined;
}

/** Catalog labels such as `500k` and `1m`. Decimal, matching the picker, not 1024-based. */
function parseCursorContextWindowTokens(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([km])$/.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return Math.round(amount * (match[2] === "m" ? 1_000_000 : 1_000));
}

/**
 * Window the handoff budget should trust. An explicit `contextWindow` option wins.
 * Grok 4.7 with no option still runs at 500k: the run endpoint rejects that parameter,
 * and Cursor applies the long-context default.
 */
export function cursorModelContextWindowTokens(modelSelection: ModelSelection): number | undefined {
  const selected = contextWindowOption(modelSelection);
  if (selected !== undefined) return parseCursorContextWindowTokens(selected);
  return modelSelection.model === "grok-4.7" ? GROK_47_DEFAULT_CONTEXT_TOKENS : undefined;
}

export function cursorSdkModelSelection(modelSelection: ModelSelection): CursorSdkModelSelection {
  // Cursor's live catalog currently advertises an explicit 500k context variant for Grok 4.7,
  // but the run endpoint rejects that parameter. Omitting it lets Cursor apply the model's
  // server-side default (which is the same long-context variant) while keeping the other options.
  const options = modelSelection.options?.filter(
    (option) =>
      !(
        modelSelection.model === "grok-4.7" &&
        option.id === "contextWindow" &&
        String(option.value).toLowerCase() === "500k"
      ),
  );
  return {
    id: modelSelection.model === "auto" ? "default" : modelSelection.model,
    ...(options === undefined || options.length === 0
      ? {}
      : {
          params: options.map((option): ModelParameterValue => ({
            id: cursorSdkParameterId(option.id),
            value: String(option.value),
          })),
        }),
  };
}
