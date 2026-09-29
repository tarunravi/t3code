import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { TerminalSquareIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadProjection } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { AgentElapsed } from "./AgentElapsed";
import { backgroundTaskLabel, selectThreadBackgroundTasks } from "./backgroundTasks.logic";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

interface BackgroundTaskView {
  readonly label: string;
  readonly text: string;
  readonly truncated: boolean;
}

// Within this distance of the bottom, new output keeps the tail pinned.
const TAIL_PIN_THRESHOLD_PX = 24;

export function useThreadBackgroundTasks(environmentId: EnvironmentId, threadId: ThreadId) {
  const projection = useThreadProjection(scopeThreadRef(environmentId, threadId))?.projection;
  return selectThreadBackgroundTasks(projection);
}

function BackgroundTaskElapsed({ task }: { task: OrchestrationV2PendingBackgroundTask }) {
  if (task.startedAt === undefined) return null;
  return (
    <AgentElapsed agent={{ status: "running", startedAt: task.startedAt, completedAt: null }} />
  );
}

/** Thread details section listing non-subagent background tasks; a row opens its output tail. */
export function ThreadBackgroundTasksSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const tasks = useThreadBackgroundTasks(props.environmentId, props.threadId);
  if (tasks.length === 0) return null;
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  return (
    <ThreadDetailsSection
      headingId="thread-details-background-heading"
      title={`Background · ${tasks.length} running`}
      data-thread-background-tasks-panel
    >
      <ul aria-label="Background tasks" className="m-0 list-none p-0">
        {tasks.map((task) => (
          <li key={task.taskId} className="group flex h-9 items-center rounded-lg">
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              onClick={() =>
                useRightPanelStore.getState().openBackgroundTask(threadRef, task.taskId)
              }
            >
              <TerminalSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-left font-mono text-xs text-foreground/85">
                {backgroundTaskLabel(task)}
              </span>
              <span className="shrink-0 text-2xs font-normal text-muted-foreground">
                <BackgroundTaskElapsed task={task} />
              </span>
            </ThreadDetailsControl>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}

/** Right-panel view of one background task: its command and a live tail of its output. */
export function BackgroundTaskPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
}) {
  const tasks = useThreadBackgroundTasks(props.environmentId, props.threadId);
  const task = tasks.find((candidate) => candidate.taskId === props.taskId);
  // Polls only while the task runs; the roster drops it once it settles.
  const output = useEnvironmentQuery(
    task === undefined
      ? null
      : orchestrationEnvironment.backgroundTaskOutput({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, taskId: props.taskId },
        }),
  );
  // Keep the last tail (and label) visible after the task finishes and
  // leaves the roster. Updated during render, guarded by equality.
  const [finalView, setFinalView] = useState<BackgroundTaskView | null>(null);
  const liveView =
    task === undefined
      ? null
      : {
          label: backgroundTaskLabel(task),
          text: output.data?.text ?? finalView?.text ?? "",
          truncated: output.data?.truncated ?? finalView?.truncated ?? false,
        };
  if (
    liveView !== null &&
    (finalView === null ||
      finalView.label !== liveView.label ||
      finalView.text !== liveView.text ||
      finalView.truncated !== liveView.truncated)
  ) {
    setFinalView(liveView);
  }
  const view = liveView ?? finalView ?? { label: props.taskId, text: "", truncated: false };
  const { label, text } = view;

  const stopBackgroundTask = useAtomCommand(orchestrationEnvironment.stopBackgroundTask);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    await stopBackgroundTask({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, taskId: props.taskId },
    });
    setStopping(false);
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (text.length > 0 && element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-background-task-panel="true">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <TerminalSquareIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-foreground">{label}</span>
        {task === undefined ? (
          <span className="shrink-0 text-muted-foreground">Finished</span>
        ) : (
          <>
            <span className="shrink-0 text-muted-foreground">
              <BackgroundTaskElapsed task={task} />
            </span>
            <Button size="xs" variant="ghost" disabled={stopping} onClick={() => void stop()}>
              {stopping ? "Stopping..." : "Stop"}
            </Button>
          </>
        )}
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto bg-muted/30 p-3"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <=
            TAIL_PIN_THRESHOLD_PX;
        }}
      >
        {view.truncated ? (
          <p className="mb-2 font-mono text-2xs text-muted-foreground">
            Showing the latest output.
          </p>
        ) : null}
        <pre className="m-0 whitespace-pre-wrap break-all font-mono text-xs/5 text-foreground/85">
          {text.length > 0
            ? text
            : output.error !== null && task !== undefined
              ? output.error
              : task === undefined
                ? "No output."
                : "Waiting for output..."}
        </pre>
      </div>
    </div>
  );
}
