import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ModelSelection } from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

export type SideChatParentStatus =
  | "working"
  | "needs-approval"
  | "needs-input"
  | "failed"
  | "interrupted"
  | "finished"
  | "idle";

export const SIDE_CHAT_PARENT_STATUS_LABELS: Record<SideChatParentStatus, string> = {
  working: "Parent working",
  "needs-approval": "Parent needs approval",
  "needs-input": "Parent needs input",
  failed: "Parent failed",
  interrupted: "Parent interrupted",
  finished: "Parent finished",
  idle: "Parent idle",
};

/** The parent's state as Codex reports it beside a side conversation. */
export function resolveSideChatParentStatus(
  parent: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "runtime" | "latestRun"
  >,
): SideChatParentStatus {
  switch (resolveSidebarThreadStatus(parent)) {
    case "approval":
      return "needs-approval";
    case "input":
      return "needs-input";
    case "working":
    case "waiting":
      return "working";
    case "failed":
    case "limited":
      return "failed";
    case "ready":
      break;
  }
  switch (parent.latestRun?.status) {
    case undefined:
      return "idle";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return "finished";
  }
}

/**
 * The model a side chat sends with: the user's pick in the panel, else the model its
 * first turn used, else the Settings default, else the parent's model.
 */
export function resolveSideChatModelSelection(input: {
  readonly picked: ModelSelection | null;
  readonly sideThread: Pick<EnvironmentThreadShell, "modelSelection" | "latestRun"> | null;
  readonly settingsDefault: ModelSelection | null;
  readonly parentModelSelection: ModelSelection;
}): ModelSelection {
  if (input.picked !== null) return input.picked;
  if (input.sideThread?.latestRun != null) return input.sideThread.modelSelection;
  return input.settingsDefault ?? input.parentModelSelection;
}

/** Text relayed to the parent thread, labeled so its agent knows the source. */
export function sideChatParentMessage(text: string): string {
  return `[From side chat]\n\n${text}`;
}
