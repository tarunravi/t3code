import { type LegendListRef } from "@legendapp/list/react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import {
  derivePendingApprovals,
  derivePhase,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
} from "../../session-logic";
import {
  useServerConfigs,
  useThreadProjection,
  useThreadShell,
  useThreadVisibleTurnItems,
  waitForThreadShell,
} from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { newMessageId, newThreadId } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { MessagesTimeline } from "./MessagesTimeline";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  resolveSideChatModelSelection,
  resolveSideChatParentStatus,
  SIDE_CHAT_PARENT_STATUS_LABELS,
  sideChatParentMessage,
} from "./sideChat.logic";

interface SideChatParent {
  readonly id: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** Opens, asks, and discards a thread's side chat; one per parent at a time, like Codex. */
export function useSideChatActions(environmentId: EnvironmentId) {
  const openSideChatCommand = useAtomCommand(threadEnvironment.openSideChat);
  const deleteThread = useAtomCommand(threadEnvironment.delete);
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  const settings = useEnvironmentSettings(environmentId);

  const ask = useCallback(
    (input: {
      readonly sideThreadId: ThreadId;
      readonly parent: SideChatParent;
      readonly modelSelection: ModelSelection;
      readonly text: string;
    }) =>
      startTurn({
        environmentId,
        input: {
          threadId: input.sideThreadId,
          message: { messageId: newMessageId(), role: "user", text: input.text, attachments: [] },
          modelSelection: input.modelSelection,
          runtimeMode: input.parent.runtimeMode,
          interactionMode: input.parent.interactionMode,
          dispatchMode: "auto",
        },
      }),
    [environmentId, startTurn],
  );

  const discard = useCallback(
    (sideThreadId: ThreadId) => deleteThread({ environmentId, input: { threadId: sideThreadId } }),
    [deleteThread, environmentId],
  );

  const open = useCallback(
    async (parent: SideChatParent, question: string) => {
      const parentRef = scopeThreadRef(environmentId, parent.id);
      const previous = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        parentRef,
      ).surfaces.find((surface) => surface.kind === "side-chat");
      if (previous?.kind === "side-chat") void discard(previous.threadId);
      const sideThreadId = newThreadId();
      const opened = await openSideChatCommand({
        environmentId,
        input: { parentThreadId: parent.id, sideThreadId },
      });
      if (opened._tag === "Failure") return;
      useRightPanelStore.getState().openSideChat(parentRef, sideThreadId);
      if (question.length === 0) return;
      if (!(await waitForThreadShell(scopeThreadRef(environmentId, sideThreadId)))) return;
      await ask({
        sideThreadId,
        parent,
        modelSelection: settings.sideChatModelSelection ?? parent.modelSelection,
        text: question,
      });
    },
    [ask, discard, environmentId, openSideChatCommand, settings.sideChatModelSelection],
  );

  return { open, ask, discard };
}

const EMPTY_TURN_DIFF_SUMMARIES: never[] = [];
const noop = () => {};

export function SideChatPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly parent: SideChatParent;
  readonly sideThreadId: ThreadId;
  readonly markdownCwd: string | undefined;
  readonly workspaceRoot: string | undefined;
}) {
  const { environmentId, parent, sideThreadId } = props;
  const parentRef = useMemo(
    () => scopeThreadRef(environmentId, parent.id),
    [environmentId, parent.id],
  );
  const sideRef = useMemo(
    () => scopeThreadRef(environmentId, sideThreadId),
    [environmentId, sideThreadId],
  );
  const sideKey = scopedThreadKey(sideRef);
  const parentShell = useThreadShell(parentRef);
  const sideShell = useThreadShell(sideRef);
  const sideProjection = useThreadProjection(sideShell === null ? null : sideRef)?.projection;
  const visibleTurnItems = useThreadVisibleTurnItems(sideShell === null ? null : sideRef);
  const settings = useEnvironmentSettings(environmentId);
  const { resolvedTheme } = useTheme();
  const providerStatuses =
    useServerConfigs().get(environmentId)?.providers ?? EMPTY_SERVER_PROVIDERS;
  const { ask } = useSideChatActions(environmentId);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval);
  const dismissUserInput = useAtomCommand(threadEnvironment.dismissUserInput);
  const sendToParentCommand = useAtomCommand(threadEnvironment.startTurn);

  const listRef = useRef<LegendListRef | null>(null);
  // Side chats are short, so the timeline derives without carrying memo state across renders.
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntriesFromVisibleTurnItemsWithState({
        visibleTurnItems,
        optimisticMessages: [],
        ...(sideProjection === undefined
          ? {}
          : {
              attempts: sideProjection.attempts,
              nodes: sideProjection.nodes,
              plans: sideProjection.plans,
            }),
      }).entries,
    [sideProjection, visibleTurnItems],
  );
  const runtime = sideProjection === undefined ? null : deriveThreadRuntime(sideProjection);
  const activityRun = sideProjection === undefined ? null : deriveThreadActivityRun(sideProjection);
  const phase = derivePhase(runtime);
  const isWorking = phase === "running" || phase === "connecting";
  const pendingRequests = useMemo(
    () =>
      sideProjection === undefined
        ? { approvals: [], userInputs: [] }
        : derivePendingThreadRequests(sideProjection),
    [sideProjection],
  );
  const pendingApproval = derivePendingApprovals(pendingRequests.approvals)[0] ?? null;
  const pendingUserInput = pendingRequests.userInputs[0] ?? null;
  const [respondingRequestId, setRespondingRequestId] = useState<RuntimeRequestId | null>(null);

  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const modelSelection = resolveSideChatModelSelection({
    picked: pickedModel,
    sideThread: sideShell,
    settingsDefault: settings.sideChatModelSelection,
    parentModelSelection: parent.modelSelection,
  });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        instanceEntries.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(
            settings,
            entry,
            entry.instanceId === modelSelection.instanceId ? modelSelection.model : null,
          ),
        ]),
      ),
    [instanceEntries, modelSelection.instanceId, modelSelection.model, settings],
  );

  const [prompt, setPrompt] = useState("");
  const send = useCallback(() => {
    const text = prompt.trim();
    if (text.length === 0 || sideShell === null) return;
    setPrompt("");
    void ask({ sideThreadId, parent, modelSelection, text });
  }, [ask, modelSelection, parent, prompt, sideShell, sideThreadId]);
  const sendToParent = useCallback(
    (text: string) => {
      void sendToParentCommand({
        environmentId,
        input: {
          threadId: parent.id,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: sideChatParentMessage(text),
            attachments: [],
          },
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          dispatchMode: "auto",
        },
      });
    },
    [environmentId, parent, sendToParentCommand],
  );
  const onRespondToApproval = useCallback(
    async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      setRespondingRequestId(requestId);
      await respondToApproval({
        environmentId,
        input: { threadId: sideThreadId, requestId, decision },
      });
      setRespondingRequestId(null);
    },
    [environmentId, respondToApproval, sideThreadId],
  );

  const parentStatus =
    parentShell === null
      ? null
      : SIDE_CHAT_PARENT_STATUS_LABELS[resolveSideChatParentStatus(parentShell)];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-side-chat-panel="true">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className="font-medium text-foreground">Side chat</span>
        {parentStatus === null ? null : (
          <span className="text-muted-foreground" data-side-chat-parent-status="true">
            {parentStatus}
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {sideShell === null ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            This side chat has ended.
          </div>
        ) : (
          <MessagesTimeline
            isWorking={isWorking}
            activeTurnInProgress={isWorking}
            listRef={listRef}
            timelineEntries={timelineEntries}
            latestRun={activityRun}
            turnDiffSummaries={EMPTY_TURN_DIFF_SUMMARIES}
            routeThreadKey={sideKey}
            onOpenTurnDiff={noop}
            onOpenThread={noop}
            onSendToParent={sendToParent}
            onRollbackCheckpoint={noop}
            supportsConversationRollback={false}
            onRevertToTurnCount={noop}
            isRevertingCheckpoint={false}
            onImageExpand={noop}
            activeThreadEnvironmentId={environmentId}
            markdownCwd={props.markdownCwd}
            resolvedTheme={resolvedTheme}
            timestampFormat={settings.timestampFormat}
            workspaceRoot={props.workspaceRoot}
            providerStatuses={providerStatuses}
            runs={sideProjection?.runs ?? []}
            anchorMessageId={null}
            onAnchorReady={noop}
            onAnchorSizeChanged={noop}
            contentInsetEndAdjustment={0}
            onIsAtEndChange={noop}
            liveFollowEnabled
            onManualNavigation={noop}
          />
        )}
      </div>
      <div className="shrink-0 border-t border-border p-2">
        {pendingApproval !== null ? (
          <div className="mb-2 flex flex-col gap-2 rounded-lg border border-warning/40 p-2">
            <ComposerPendingApprovalPanel approval={pendingApproval} pendingCount={1} />
            <div className="flex justify-end gap-1.5">
              <ComposerPendingApprovalActions
                requestId={pendingApproval.requestId}
                isResponding={respondingRequestId === pendingApproval.requestId}
                canRespond={pendingApproval.responseCapability === "live"}
                options={pendingApproval.options}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          </div>
        ) : pendingUserInput !== null ? (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-warning/40 p-2 text-xs">
            <span className="min-w-0 flex-1 truncate">
              {pendingUserInput.questions[0]?.question ?? "The side agent asked a question."}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void dismissUserInput({
                  environmentId,
                  input: { threadId: sideThreadId, requestId: pendingUserInput.requestId },
                })
              }
            >
              Dismiss
            </Button>
          </div>
        ) : null}
        <Textarea
          size="sm"
          value={prompt}
          placeholder="Ask a side question"
          aria-label="Side chat message"
          disabled={sideShell === null}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <ProviderModelPicker
            size="xs"
            activeInstanceId={modelSelection.instanceId}
            model={modelSelection.model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            triggerAriaLabel="Side chat model"
            onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) =>
              setPickedModel(createModelSelection(instanceId, model))
            }
          />
          {isWorking ? (
            <Button
              size="icon-xs"
              variant="outline"
              aria-label="Stop side chat"
              onClick={() =>
                void interruptTurn({ environmentId, input: { threadId: sideThreadId } })
              }
            >
              <SquareIcon />
            </Button>
          ) : (
            <Button
              size="icon-xs"
              aria-label="Send side question"
              disabled={prompt.trim().length === 0 || sideShell === null}
              onClick={send}
            >
              <ArrowUpIcon />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
