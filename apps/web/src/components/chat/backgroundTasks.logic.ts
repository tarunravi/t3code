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

export interface BackgroundTaskEntry {
  readonly task: OrchestrationV2PendingBackgroundTask;
  /** Only roster tasks have an output file to tail and a per-task stop. */
  readonly inspectable: boolean;
}

/**
 * Banner work (roster tasks plus still-active background turn items) joined
 * with the roster, which carries the command, start time, and output file.
 */
export function backgroundTaskEntries(
  pending: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  roster: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
): ReadonlyArray<BackgroundTaskEntry> {
  return pending.map((task) => {
    const rosterTask = roster.find((candidate) => candidate.taskId === task.taskId);
    return rosterTask === undefined
      ? { task, inspectable: false }
      : { task: rosterTask, inspectable: true };
  });
}

/** The task whose output shows: the chosen one while it runs, else the only inspectable one. */
export function resolveSelectedBackgroundTaskId(
  entries: ReadonlyArray<BackgroundTaskEntry>,
  selectedTaskId: string | null,
): string | null {
  const inspectable = entries.filter((entry) => entry.inspectable);
  if (inspectable.some((entry) => entry.task.taskId === selectedTaskId)) return selectedTaskId;
  return inspectable.length === 1 ? inspectable[0]!.task.taskId : null;
}

export function backgroundTasksBannerTitle(count: number): {
  readonly full: string;
  readonly compact: string;
} {
  return count === 1
    ? { full: "Waiting on background task", compact: "Background task" }
    : { full: `Waiting on ${count} background tasks`, compact: `${count} background tasks` };
}
