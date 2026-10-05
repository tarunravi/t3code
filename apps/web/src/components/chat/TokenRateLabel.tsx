import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { useTokenRate } from "../../hooks/useTokenRate";
import {
  LIVE_TOKEN_RATE_EXPLANATION,
  latestTokenRateTurn,
  tokenRateExplanation,
} from "../../lib/tokenRate";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * Live estimated output speed while a run streams; completed-turn average when idle.
 */
export function TokenRateLabel(props: {
  readonly projection:
    | Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns" | "turnItems">
    | null
    | undefined;
  readonly className?: string | undefined;
}) {
  const { live, text } = useTokenRate(props.projection);
  const explanation = live
    ? LIVE_TOKEN_RATE_EXPLANATION
    : tokenRateExplanation(latestTokenRateTurn(props.projection));
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className={cn(
          "shrink-0 text-2xs leading-none tabular-nums",
          live ? "text-secondary-label/80" : "text-secondary-label/50",
          props.className,
        )}
        aria-label={
          text === null
            ? "Output token rate unavailable"
            : live
              ? "Estimated live output tokens per second"
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
