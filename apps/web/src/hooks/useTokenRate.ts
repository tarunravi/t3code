import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import { completedTurnTokenRate, formatTokenRate } from "../lib/tokenRate";

/** Derived from the current turn, with no client-clock history to leak across turns. */
export function useTokenRate(providerTurn: OrchestrationV2ProviderTurn | null | undefined): {
  readonly rate: number | null;
  readonly text: string | null;
} {
  const rate = completedTurnTokenRate(providerTurn);
  return { rate, text: formatTokenRate(rate) };
}
