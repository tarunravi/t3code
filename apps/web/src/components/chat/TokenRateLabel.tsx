import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import { useTokenRate } from "../../hooks/useTokenRate";
import { cn } from "~/lib/utils";

/**
 * Completed-turn output throughput; never presents context growth as live speed.
 */
export function TokenRateLabel(props: {
  readonly providerTurn: OrchestrationV2ProviderTurn | null | undefined;
  readonly className?: string | undefined;
}) {
  const { text } = useTokenRate(props.providerTurn);
  if (text === null) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-2xs leading-none tabular-nums",
        "text-secondary-label/50",
        props.className,
      )}
      aria-label="Average output tokens per second over completed turn"
      aria-description="Completed-turn average output throughput, including reasoning and tool waits; not live generation speed"
    >
      {text}
    </span>
  );
}
