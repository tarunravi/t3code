import {
  routeAntigravityModelSelection,
  type OrchestrationV2ServerCommand,
  type ServerSettings,
} from "@t3tools/contracts";

// Selections naming this environment's instances. A remote task's selection names another
// environment's instances, so it is left alone.
type RoutedCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "thread.create"
      | "thread.model-selection.set"
      | "message.dispatch"
      | "queued-run.edit"
      | "delegated_task.request"
      | "provider.switch";
  }
>;

const ROUTED_COMMAND_TYPES: ReadonlySet<OrchestrationV2ServerCommand["type"]> = new Set<
  RoutedCommand["type"]
>([
  "thread.create",
  "thread.model-selection.set",
  "message.dispatch",
  "queued-run.edit",
  "delegated_task.request",
  "provider.switch",
]);

const isRoutedCommand = (command: OrchestrationV2ServerCommand): command is RoutedCommand =>
  ROUTED_COMMAND_TYPES.has(command.type);

/**
 * Applies Antigravity model-to-account routes before the command is decided, so the thread records
 * the instance that actually runs the model and later turns, resumes, and queued runs follow it.
 */
export function routeCommandModelAccount(
  settings: Pick<ServerSettings, "providerInstances" | "antigravityModelAccounts">,
  command: OrchestrationV2ServerCommand,
): OrchestrationV2ServerCommand {
  if (!isRoutedCommand(command) || command.modelSelection === undefined) return command;
  const modelSelection = routeAntigravityModelSelection(settings, command.modelSelection);
  return modelSelection === command.modelSelection ? command : { ...command, modelSelection };
}
