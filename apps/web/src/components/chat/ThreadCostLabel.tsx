import type { ScopedThreadRef } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

import type { ThreadCostRow, ThreadCostSubtotal } from "../../lib/threadCost";
import { useThreadCostEstimate } from "../../state/threadCost";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

function formatSubtotal(subtotal: ThreadCostSubtotal): string {
  return `${subtotal.partial ? "≥ " : ""}${formatUsd(subtotal.usd)}`;
}

function formatRowCost(row: ThreadCostRow): string {
  if (row.costUsd !== null) return `${formatUsd(row.costUsd)}${row.incompleteUsage ? "*" : ""}`;
  return row.model === null ? "loading" : "unpriced";
}

/** Estimated cost of the thread and its delegated subagents, at Usage page prices. */
export function ThreadCostLabel(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly className?: string | undefined;
}) {
  const estimate = useThreadCostEstimate(props.threadRef);
  if (estimate === null || estimate.rows.every((row) => row.model === null)) return null;
  const subagentRows = estimate.rows.filter((row) => row.depth > 0);
  const subagentCount = new Set(subagentRows.map((row) => row.threadId)).size;
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
          <div>Estimated cost at Usage page prices.</div>
          <table className="tabular-nums">
            <tbody>
              <tr className="font-medium">
                <td className="pr-3">Parent agent</td>
                <td className="text-right">{formatSubtotal(estimate.parent)}</td>
              </tr>
              <tr className="font-medium">
                <td className="pr-3">Subagents{subagentCount > 0 ? ` (${subagentCount})` : ""}</td>
                <td className="text-right">
                  {subagentCount > 0 ? formatSubtotal(estimate.subagents) : "none"}
                </td>
              </tr>
            </tbody>
          </table>
          {subagentRows.length > 0 ? (
            <table className="tabular-nums">
              <tbody>
                {subagentRows.map((row) => (
                  <tr key={`${row.threadId}:${row.model ?? ""}`}>
                    <td className="pr-3" style={{ paddingLeft: `${(row.depth - 1) * 0.75}rem` }}>
                      {row.title}
                    </td>
                    <td className="pr-3 text-muted-foreground">{row.model ?? "—"}</td>
                    <td className="pr-3 text-right">{formatTokens(row.totalTokens)} tok</td>
                    <td className="text-right">{formatRowCost(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {estimate.partial ? (
            <div className="text-muted-foreground">
              ≥ marks a lower bound: unpriced models and turns without usage totals are excluded.
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
