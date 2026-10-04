import { useTokenRate } from "../../hooks/useTokenRate";
import { cn } from "~/lib/utils";

/**
 * Tiny tok/s readout for a thread's own stream. Renders nothing until a rate
 * has been measured; while idle it keeps the last measured rate, dimmed.
 */
export function TokenRateLabel(props: {
  readonly tokenUsage: { readonly usedTokens: number } | null | undefined;
  readonly resetKey: string | null;
  readonly className?: string | undefined;
}) {
  const { rate, live, text } = useTokenRate(props.tokenUsage, props.resetKey);
  if (text === null) return null;
  return (
    <span
      className={cn(
        "shrink-0 text-2xs leading-none tabular-nums",
        live ? "text-secondary-label" : "text-secondary-label/50",
        props.className,
      )}
      aria-label="Tokens per second"
      title={rate !== null ? `${Math.round(rate)} tokens per second` : undefined}
    >
      {text}
    </span>
  );
}
