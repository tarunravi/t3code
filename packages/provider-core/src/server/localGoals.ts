/**
 * `/goal` kept by T3 for an agent whose own goal mode T3 cannot reach: omp
 * over ACP, and omp RPC builds older than its native RPC goals. T3 stores the
 * goal on the provider thread and pursues it with ordinary prompts. The agent never enters a native goal mode:
 * it does not continue on its own between turns, and a goal turn that ends
 * short of done leaves the goal paused for `/goal resume`.
 */
import type { OrchestrationV2ProviderGoal, TurnTokenUsage } from "@t3tools/contracts";

export type LocalGoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

/**
 * Parses `/goal` like the Codex TUI: `clear`, `pause` and `resume` control the
 * current goal, a bare `/goal` shows it, and any other text sets a new
 * objective. Returns null for every other message.
 */
export function parseLocalGoalCommand(text: string): LocalGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "status":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument.replace(/^set\s+/iu, "") };
  }
}

/** The line a goal turn ends with once the agent reports the goal achieved. */
export const LOCAL_GOAL_COMPLETE_MARKER = "GOAL COMPLETE";

export type LocalGoalCommandOutcome =
  /** Settles without prompting the agent. */
  | {
      readonly type: "reply";
      readonly goal: OrchestrationV2ProviderGoal | null;
      readonly reply: string;
    }
  /** Prompts the agent with `prompt` while the goal is active. */
  | {
      readonly type: "pursue";
      readonly goal: OrchestrationV2ProviderGoal;
      readonly prompt: string;
    };

export function describeGoal(goal: OrchestrationV2ProviderGoal): string {
  return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}

function goalPrompt(lead: string, objective: string): string {
  return [
    lead,
    "",
    objective,
    "",
    "Keep working without asking for confirmation. When the goal is fully achieved " +
      `and verified, end your final message with a line containing only ${LOCAL_GOAL_COMPLETE_MARKER}. ` +
      "If you stop before then, say what remains instead.",
  ].join("\n");
}

export function runLocalGoalCommand(
  current: OrchestrationV2ProviderGoal | null,
  command: LocalGoalCommand,
): LocalGoalCommandOutcome {
  switch (command.type) {
    case "show":
      return {
        type: "reply",
        goal: current,
        reply: current === null ? "No goal is set." : describeGoal(current),
      };
    case "clear":
      return {
        type: "reply",
        goal: null,
        reply: current === null ? "No goal to clear." : "Goal cleared.",
      };
    case "pause":
      return current === null
        ? { type: "reply", goal: null, reply: "No goal is set." }
        : {
            type: "reply",
            goal: { ...current, status: "paused" },
            reply: "Goal paused. Send /goal resume to continue.",
          };
    case "resume":
      return current === null
        ? { type: "reply", goal: null, reply: "No goal is set." }
        : {
            type: "pursue",
            goal: { ...current, status: "active" },
            prompt: goalPrompt("Continue working toward this goal:", current.objective),
          };
    case "set":
      // A new objective replaces the goal and its accounting.
      return {
        type: "pursue",
        goal: { objective: command.objective, status: "active" },
        prompt: goalPrompt("Work toward this goal until it is fully achieved:", command.objective),
      };
  }
}

/**
 * Best effort: completion is read from the marker the goal prompt asks the
 * agent to end on, so an agent that omits it leaves the goal paused.
 */
export function localGoalCompletionReported(finalAssistantText: string): boolean {
  const lastLine = finalAssistantText.trimEnd().split("\n").at(-1) ?? "";
  return lastLine.replace(/[*_`.]/gu, "").trim() === LOCAL_GOAL_COMPLETE_MARKER;
}

/**
 * The goal after one of its turns settles. Tokens count new input, cache
 * writes, and output, as omp's own goal budget does; cache reads are reused
 * prefix.
 */
export function settleLocalGoalTurn(
  goal: OrchestrationV2ProviderGoal,
  turn: {
    readonly completed: boolean;
    readonly finalAssistantText: string;
    readonly tokenUsage: TurnTokenUsage | undefined;
    readonly elapsedSeconds: number;
  },
): OrchestrationV2ProviderGoal {
  const tokenUsage = turn.tokenUsage;
  const turnTokens =
    tokenUsage?.inputTokens === undefined || tokenUsage.outputTokens === undefined
      ? undefined
      : Math.max(0, tokenUsage.inputTokens - (tokenUsage.cachedInputTokens ?? 0)) +
        tokenUsage.outputTokens;
  return {
    ...goal,
    status:
      turn.completed && localGoalCompletionReported(turn.finalAssistantText)
        ? "complete"
        : "paused",
    ...(turnTokens === undefined ? {} : { tokensUsed: (goal.tokensUsed ?? 0) + turnTokens }),
    timeUsedSeconds: (goal.timeUsedSeconds ?? 0) + Math.max(0, Math.round(turn.elapsedSeconds)),
  };
}
