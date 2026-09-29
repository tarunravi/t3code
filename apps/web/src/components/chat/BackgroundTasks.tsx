import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { PanelRightIcon, TerminalSquareIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadProjection } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import {
  backgroundTaskLabel,
  backgroundTasksBannerTitle,
  resolveSelectedBackgroundTaskId,
  selectThreadBackgroundTasks,
  type BackgroundTaskEntry,
} from "./backgroundTasks.logic";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

interface BackgroundTaskTail {
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

/** Stops one background task; the roster drops it once the provider confirms. */
function BackgroundTaskStopButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly label: string;
}) {
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
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={stopping}
      aria-label={`Stop ${props.label}`}
      onClick={() => void stop()}
    >
      {stopping ? "Stopping..." : "Stop"}
    </Button>
  );
}

/**
 * Polled, auto-scrolling tail of one task's output. Polling runs only while
 * mounted and the task is live; the last tail stays visible after it ends.
 */
function BackgroundTaskOutputTail(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly live: boolean;
  readonly className?: string;
}) {
  const output = useEnvironmentQuery(
    props.live
      ? orchestrationEnvironment.backgroundTaskOutput({
          environmentId: props.environmentId,
          input: { threadId: props.threadId, taskId: props.taskId },
        })
      : null,
  );
  // Updated during render, guarded by equality.
  const [lastTail, setLastTail] = useState<BackgroundTaskTail | null>(null);
  if (
    output.data !== null &&
    (lastTail?.text !== output.data.text || lastTail.truncated !== output.data.truncated)
  ) {
    setLastTail({ text: output.data.text, truncated: output.data.truncated });
  }
  const text = lastTail?.text ?? "";

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (text.length > 0 && element && pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [text]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="Background task output"
      className={cn("min-h-0 overflow-auto bg-muted/30 p-3", props.className)}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinnedRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight <= TAIL_PIN_THRESHOLD_PX;
      }}
    >
      {lastTail?.truncated ? (
        <p className="mb-2 font-mono text-2xs text-muted-foreground">Showing the latest output.</p>
      ) : null}
      <pre className="m-0 whitespace-pre-wrap break-all font-mono text-xs/5 text-foreground/85">
        {text.length > 0
          ? text
          : output.error !== null && props.live
            ? output.error
            : props.live
              ? "Waiting for output..."
              : "No output."}
      </pre>
    </div>
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
  // Keep the label after the task finishes and leaves the roster.
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const liveLabel = task === undefined ? null : backgroundTaskLabel(task);
  if (liveLabel !== null && liveLabel !== lastLabel) setLastLabel(liveLabel);
  const label = liveLabel ?? lastLabel ?? props.taskId;

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
            <BackgroundTaskStopButton
              environmentId={props.environmentId}
              threadId={props.threadId}
              taskId={props.taskId}
              label={label}
            />
          </>
        )}
      </div>
      <BackgroundTaskOutputTail
        environmentId={props.environmentId}
        threadId={props.threadId}
        taskId={props.taskId}
        live={task !== undefined}
        className="flex-1"
      />
    </div>
  );
}

/** One row per background task; selecting an inspectable row shows its output. */
export function BackgroundTaskList(props: {
  readonly entries: ReadonlyArray<BackgroundTaskEntry>;
  readonly selectedTaskId: string | null;
  readonly onSelect: (taskId: string) => void;
  readonly renderActions: (entry: BackgroundTaskEntry) => ReactNode;
}) {
  return (
    <ul aria-label="Background tasks" className="m-0 flex list-none flex-col gap-0.5 p-0">
      {props.entries.map((entry) => {
        const label = backgroundTaskLabel(entry.task);
        const selected = entry.task.taskId === props.selectedTaskId;
        return (
          <li
            key={entry.task.taskId}
            className={cn(
              "flex h-8 min-w-0 items-center gap-1 rounded-md pe-1",
              selected && "bg-accent",
            )}
          >
            <Tooltip>
              <TooltipTrigger
                delay={400}
                render={
                  <button
                    type="button"
                    aria-pressed={selected}
                    disabled={!entry.inspectable}
                    onClick={() => props.onSelect(entry.task.taskId)}
                    className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md ps-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                  />
                }
              >
                <TerminalSquareIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/85">
                  {label}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  <BackgroundTaskElapsed task={entry.task} />
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top" variant="code">
                {label}
              </TooltipPopup>
            </Tooltip>
            {props.renderActions(entry)}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The composer banner's clickable summary. It opens a popover anchored to the
 * banner that lists the tasks and tails the selected one in place.
 */
export function BackgroundTasksBannerPopover(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<BackgroundTaskEntry>;
}) {
  const [open, setOpen] = useState(false);
  const [chosenTaskId, setChosenTaskId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedTaskId = resolveSelectedBackgroundTaskId(props.entries, chosenTaskId);
  const selected = props.entries.find((entry) => entry.task.taskId === selectedTaskId);
  const title = backgroundTasksBannerTitle(props.entries.length);
  const summary = props.entries.map((entry) => backgroundTaskLabel(entry.task)).join(", ");
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const openInPanel = () => {
    const taskId = selectedTaskId ?? props.entries.find((entry) => entry.inspectable)?.task.taskId;
    if (taskId === undefined) return;
    useRightPanelStore.getState().openBackgroundTask(threadRef, taskId);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            aria-label={`${title.full}: ${summary}. Show background tasks`}
            className="flex w-full min-w-0 cursor-pointer items-baseline gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-background-tasks-banner-trigger
          />
        }
      >
        <span className="shrink-0 font-medium">
          <span className="@max-[440px]:hidden">{title.full}</span>
          <span className="hidden @max-[440px]:inline">{title.compact}</span>
        </span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        padding="compact"
        anchor={() => triggerRef.current?.closest('[data-slot="composer-banner"]') ?? null}
        className="w-(--anchor-width) max-w-[calc(100vw-2rem)]"
        data-background-tasks-popover
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2 ps-1">
            <div className="min-w-0 flex-1 truncate">
              <PopoverTitle>
                {props.entries.length === 1
                  ? "1 background task"
                  : `${props.entries.length} background tasks`}
              </PopoverTitle>
            </div>
            <Button
              size="xs"
              variant="ghost"
              disabled={!props.entries.some((entry) => entry.inspectable)}
              onClick={openInPanel}
            >
              <PanelRightIcon aria-hidden />
              Open in panel
            </Button>
          </div>
          <BackgroundTaskList
            entries={props.entries}
            selectedTaskId={selectedTaskId}
            onSelect={setChosenTaskId}
            renderActions={(entry) =>
              entry.inspectable ? (
                <BackgroundTaskStopButton
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  taskId={entry.task.taskId}
                  label={backgroundTaskLabel(entry.task)}
                />
              ) : null
            }
          />
          {selected === undefined ? (
            <p className="px-1 pb-1 text-2xs text-muted-foreground">
              Select a task to see its output.
            </p>
          ) : (
            <BackgroundTaskOutputTail
              key={selected.task.taskId}
              environmentId={props.environmentId}
              threadId={props.threadId}
              taskId={selected.task.taskId}
              live
              className="h-[40dvh] rounded-md"
            />
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
