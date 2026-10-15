import type { RunId } from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export const PROVIDER_FAILURE_RESUME_TITLE = "Continue from where you last left off";

/** Keyed by run, so it appears once per failed run and goes when a new run starts. */
export function providerFailureResumeBannerItem(props: {
  runId: RunId;
  disabled: boolean;
  onResume: () => void;
}): ComposerBannerStackItem {
  return {
    id: `provider-failure-resume:${props.runId}`,
    variant: "warning",
    priority: "urgent",
    icon: <RotateCcwIcon />,
    title: PROVIDER_FAILURE_RESUME_TITLE,
    actions: (
      <Button size="xs" variant="ghost" disabled={props.disabled} onClick={props.onResume}>
        Resume
      </Button>
    ),
  };
}
