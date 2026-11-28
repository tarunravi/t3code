import {
  routeAntigravityModelSelection,
  type OrchestrationV2ServerCommand,
  type ProjectId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
 * The thread's project decides which accounts it may route to; `projectOf` finds it.
 */
export const routeCommandModelAccount = <E, R>(
  settings: Pick<
    ServerSettings,
    "providerInstances" | "projectSettingsOverrides" | "antigravityModelAccounts"
  >,
  command: OrchestrationV2ServerCommand,
  projectOf: (threadId: ThreadId) => Effect.Effect<ProjectId | null, E, R>,
): Effect.Effect<OrchestrationV2ServerCommand, E, R> => {
  if (!isRoutedCommand(command) || command.modelSelection === undefined) {
    return Effect.succeed(command);
  }
  const { modelSelection: requested } = command;
  const projectId =
    command.type === "thread.create"
      ? Effect.succeed(command.projectId)
      : projectOf(
          command.type === "delegated_task.request" ? command.parentThreadId : command.threadId,
        );
  return projectId.pipe(
    Effect.map((project) => {
      const modelSelection = routeAntigravityModelSelection(settings, project, requested);
      return modelSelection === requested ? command : { ...command, modelSelection };
    }),
  );
};
