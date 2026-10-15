import { TargetIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function GoalRunningIndicator({ status }: { status: string | null }) {
  if (status !== "active") return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span aria-label="Goal running" className="inline-flex items-center text-info">
            <TargetIcon aria-hidden className="size-4 shrink-0" />
          </span>
        }
      />
      <TooltipPopup side="top">Goal running</TooltipPopup>
    </Tooltip>
  );
}
