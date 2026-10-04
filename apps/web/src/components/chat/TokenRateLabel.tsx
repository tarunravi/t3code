import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import { useTokenRate } from "../../hooks/useTokenRate";
import { tokenRateExplanation } from "../../lib/tokenRate";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * Completed-turn output throughput; never presents context growth as live speed.
 */
export function TokenRateLabel(props: {
  readonly providerTurn: OrchestrationV2ProviderTurn | null | undefined;
  readonly className?: string | undefined;
}) {
  const { text } = useTokenRate(props.providerTurn);
  const explanation = tokenRateExplanation(props.providerTurn);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className={cn(
          "shrink-0 text-2xs leading-none tabular-nums",
          "text-secondary-label/50",
          props.className,
        )}
        aria-label={
          text === null
            ? "Output token rate unavailable"
            : "Average output tokens per second over completed turn"
        }
        aria-description={explanation}
      >
        {text ?? "tok/s —"}
      </TooltipTrigger>
      <TooltipPopup>{explanation}</TooltipPopup>
    </Tooltip>
  );
}
