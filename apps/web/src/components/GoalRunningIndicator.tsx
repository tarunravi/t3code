import { TargetIcon } from "lucide-react";

export function GoalRunningIndicator({ status }: { status: string | null }) {
  if (status !== "active") return null;
  return (
    <span
      aria-label="Goal running"
      className="inline-flex items-center text-info"
      title="Goal running"
    >
      <TargetIcon aria-hidden className="size-4 shrink-0" />
    </span>
  );
}
