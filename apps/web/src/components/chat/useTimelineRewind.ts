import { type Dispatch, type SetStateAction } from "react";
import { randomUUID } from "~/lib/utils";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { type ComposerImageAttachment, type ComposerFileAttachment } from "../../composerDraftStore";
import { readPreparedConnection } from "../../state/session";
import { recallableComposerPrompt } from "./composerPromptHistory";
import { canRestoreFilesForRun } from "../../session-logic";
import { prepareRevertedMessageAttachments, loadMessageRewriteDraft } from "../ChatView.logic";
export interface MessageRewriteState {
 readonly messageId: MessageId; readonly turnCount: number; readonly restoreFiles: boolean;
 readonly routeThreadKey: string; readonly rewound: boolean;
}
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { newThreadId } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { makeThreadErrorSetter } from "../ChatView.logic";
interface TimelineRewindInput {
 readonly turnDiffSummaries: Parameters<typeof canRestoreFilesForRun>[0];
 readonly cancelQueuedEdit: () => void;
 readonly setRewritingMessage: Dispatch<SetStateAction<MessageRewriteState | null>>;
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer) and forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const { turnDiffSummaries, cancelQueuedEdit, setRewritingMessage,
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    phase,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;

    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    if (restoreFiles === undefined && !canRestoreFilesForRun(turnDiffSummaries, message.runId)) {
      // No file snapshot for this turn (for example, outside git): edit the
      // conversation only, without asking about files.
      restoreFiles = false;
    }
    if (restoreFiles === undefined) {
      openRevertConfirm(routeThreadKey, { turnCount, messageId });
      return;
    }

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    try {
      // Rewriting loads the message into its own draft; the rewind runs when it is sent.
      if (composerRef.current?.hasPendingAttachments()) {
        throw new Error("Wait for attachments to finish preparing before rewinding.");
      }
      const connection = readPreparedConnection(environmentId);
      if (!connection) throw new Error("The environment is not connected.");
      const files = await prepareRevertedMessageAttachments({
        message,
        environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl: createAttachmentAssetUrl,
      });
      if (files.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        throw new Error("Make room for this message's attachments in the composer before rewinding.");
      }
      if (currentRouteThreadKeyRef.current !== routeThreadKey) return;
      const nextPrompt = recallableComposerPrompt(message.text);
      const images: ComposerImageAttachment[] = [];
      const restoredFiles: ComposerFileAttachment[] = [];
      files.forEach((file, index) => {
        const attachment = {
          id: randomUUID(),
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        };
        if (message.attachments?.[index]?.type === "image") {
          images.push({ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) });
        } else {
          restoredFiles.push({ ...attachment, type: "file" });
        }
      });
      loadMessageRewriteDraft({
        threadRef: routeThreadRef,
        prompt: nextPrompt,
        images,
        files: restoredFiles,
      });
      cancelQueuedEdit();
      setRewritingMessage({ messageId, turnCount, restoreFiles, routeThreadKey, rewound: false });
      if (currentRouteThreadKeyRef.current === routeThreadKey) {
        promptRef.current = nextPrompt;
        composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
        requestAnimationFrame(() => {
          if (currentRouteThreadKeyRef.current === routeThreadKey)
            composerRef.current?.focusAtEnd();
        });
      }
    } catch (error) {
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to revert thread state.",
      );
    } finally {
      useComposerDraftStore.setState((store) => {
        const remaining = new Set(store.rewindingThreadKeys);
        remaining.delete(routeThreadKey);
        return { rewindingThreadKeys: remaining };
      });
    }
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);
  const onConfirmRevert = (turnCount: number, messageId: MessageId, restoreFiles: boolean) => {
    void onRevertToTurnCount(turnCount, messageId, restoreFiles);
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  return {
    onConfirmRevertStable,
    onForkFromRunStable,
    onRevertTimelineTurnStable,
  };
}
