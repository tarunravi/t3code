import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

type BackgroundTaskProjection = {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "activeProviderThreadId">;
  readonly providerThreads: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["providerThreads"][number],
      "id" | "pendingBackgroundTasks"
    >
  >;
};

const EMPTY_TASKS: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [];

/**
 * The thread's live background tasks, straight from the active provider
 * thread's roster. Unlike the composer banner this is not gated on the turn
 * settling, so a dev server started mid-turn is inspectable right away.
 */
export function selectThreadBackgroundTasks(
  projection: BackgroundTaskProjection | null | undefined,
): ReadonlyArray<OrchestrationV2PendingBackgroundTask> {
  if (!projection) return EMPTY_TASKS;
  const activeId = projection.thread.activeProviderThreadId;
  const providerThreads =
    activeId === null
      ? projection.providerThreads
      : projection.providerThreads.filter((thread) => thread.id === activeId);
  const tasks = providerThreads.flatMap((thread) => thread.pendingBackgroundTasks ?? []);
  return tasks.length === 0 ? EMPTY_TASKS : tasks;
}

export function backgroundTaskLabel(
  task: Pick<OrchestrationV2PendingBackgroundTask, "taskId" | "command" | "description">,
): string {
  return task.command ?? task.description ?? task.taskId;
}
