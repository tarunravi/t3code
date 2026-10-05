import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import { useThreadCostEstimate } from "../../state/threadCost";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

/** Estimated cost of the thread and its delegated subagents, at Usage page prices. */
export function ThreadCostLabel(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly className?: string | undefined;
}) {
  const estimate = useThreadCostEstimate(props.threadRef);
  if (estimate === null || estimate.rows.every((row) => row.model === null)) return null;
  const text = `${estimate.partial ? "≥ " : "≈ "}${formatUsd(estimate.totalUsd)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        className={cn(
          "shrink-0 text-2xs leading-none tabular-nums text-secondary-label/50",
          props.className,
        )}
        aria-label={`Estimated thread cost ${formatUsd(estimate.totalUsd)}${estimate.partial ? ", partial" : ""}`}
      >
        {text}
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex flex-col gap-1">
          <div>
            Estimated cost{estimate.partial ? " (partial)" : ""}: thread plus delegated subagents,
            at Usage page prices.
          </div>
          <table className="tabular-nums">
            <tbody>
              {estimate.rows.map((row) => (
                <tr key={`${row.threadId}:${row.model ?? ""}`}>
                  <td className="pr-3" style={{ paddingLeft: `${row.depth * 0.75}rem` }}>
                    {row.depth === 0 ? "This thread" : row.title}
                  </td>
                  <td className="pr-3 text-muted-foreground">{row.model ?? "—"}</td>
                  <td className="pr-3 text-right">{formatTokens(row.totalTokens)} tok</td>
                  <td className="text-right">
                    {row.costUsd === null
                      ? row.model === null
                        ? "loading"
                        : "unpriced"
                      : `${formatUsd(row.costUsd)}${row.incompleteUsage ? "*" : ""}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {estimate.partial ? (
            <div className="text-muted-foreground">
              Partial: unpriced models and turns without usage totals are excluded.
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
