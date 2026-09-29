import type {
  EventId,
  OrchestrationV2DomainEvent,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

export function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

export function isNonterminalTurnItemStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isNonterminalSubagentStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function isNonterminalNodeStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

/**
 * Resolve providerInstanceId for a stale background-capable turn item whose
 * run is missing/null (or not found). Prefer an existing run, then a subagent
 * item's own instance id, then the item's provider thread, then a last-resort
 * first provider thread, then the thread's selected provider.
 */
function resolveStaleBackgroundItemProviderInstanceId(
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  projection: ProjectionRuntimeRecoveryState,
): OrchestrationV2ThreadProjection["thread"]["providerInstanceId"] {
  if (item.runId !== null) {
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    if (run !== undefined) {
      return run.providerInstanceId;
    }
  }
  if (item.type === "subagent") {
    return item.providerInstanceId;
  }
  if (item.providerThreadId !== null && item.providerThreadId !== undefined) {
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === item.providerThreadId,
    );
    if (providerThread !== undefined) {
      return providerThread.providerInstanceId;
    }
  }
  return projection.providerThreads[0]?.providerInstanceId ?? projection.thread.providerInstanceId;
}

/**
 * Cancels background work that only a now-dead provider process could have
 * settled: background-capable turn items (commands, dynamic tools, subagents)
 * with their nodes and linked subagent entities, plus a provider-native
 * subagent thread's runless root turn and the items under it.
 *
 * Items owned by `skipRunIds` are left alone: the caller either settles those
 * runs itself or they are still live. `alreadyCancelledItemIds` lists items
 * the caller already cancelled in the same commit. `onCancelledItem` sees each
 * cancelled background-capable item.
 */
export const orphanedBackgroundWorkEvents = <E>(input: {
  readonly projection: ProjectionRuntimeRecoveryState;
  readonly skipRunIds: ReadonlySet<string>;
  readonly alreadyCancelledItemIds?: ReadonlySet<string>;
  readonly onCancelledItem?: (item: OrchestrationV2ThreadProjection["turnItems"][number]) => void;
  readonly now: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}): Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, E> =>
  Effect.gen(function* () {
    const { projection, now, allocateEventId } = input;
    const events: Array<OrchestrationV2DomainEvent> = [];
    const cancelledStaleNodeIds = new Set<string>();
    const cancelledStaleItemIds = new Set<string>(input.alreadyCancelledItemIds);
    for (const item of projection.turnItems ?? []) {
      if (item.runId !== null && input.skipRunIds.has(item.runId)) {
        continue;
      }
      if (!isBackgroundCapableTurnItemType(item.type)) {
        continue;
      }
      if (!isNonterminalTurnItemStatus(item.status)) {
        continue;
      }
      const providerInstanceId = resolveStaleBackgroundItemProviderInstanceId(item, projection);
      input.onCancelledItem?.(item);
      cancelledStaleItemIds.add(item.id);
      events.push({
        id: yield* allocateEventId(),
        type: "turn-item.updated",
        threadId: projection.thread.id,
        ...(item.runId === null ? {} : { runId: item.runId }),
        ...(item.nodeId === null || item.nodeId === undefined ? {} : { nodeId: item.nodeId }),
        providerInstanceId,
        occurredAt: now,
        payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
      });
      if (item.nodeId !== null && item.nodeId !== undefined) {
        const staleItemNode = projection.nodes.find(
          (candidate) => candidate.id === item.nodeId && isNonterminalNodeStatus(candidate.status),
        );
        if (staleItemNode !== undefined && !cancelledStaleNodeIds.has(staleItemNode.id)) {
          cancelledStaleNodeIds.add(staleItemNode.id);
          events.push({
            id: yield* allocateEventId(),
            type: "node.updated",
            threadId: projection.thread.id,
            ...(item.runId === null ? {} : { runId: item.runId }),
            nodeId: staleItemNode.id,
            providerInstanceId,
            occurredAt: now,
            payload: { ...staleItemNode, status: "cancelled", completedAt: now },
          });
        }
      }
      if (item.type !== "subagent") {
        continue;
      }
      // Cancelling only the turn item would leave the linked subagent entity
      // non-terminal forever, since the dead provider process can no longer
      // emit its terminal event. Match the exact linked id so a subagent
      // that already finished is never overwritten.
      const staleSubagent = projection.subagents.find(
        (candidate) =>
          candidate.id === item.subagentId && isNonterminalSubagentStatus(candidate.status),
      );
      if (staleSubagent !== undefined) {
        events.push({
          id: yield* allocateEventId(),
          type: "subagent.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          nodeId: staleSubagent.id,
          driver: staleSubagent.driver,
          providerInstanceId: staleSubagent.providerInstanceId,
          occurredAt: now,
          payload: { ...staleSubagent, status: "cancelled", completedAt: now, updatedAt: now },
        });
      }
      const staleSubagentNode = projection.nodes.find(
        (candidate) =>
          candidate.id === item.subagentId && isNonterminalNodeStatus(candidate.status),
      );
      if (staleSubagentNode !== undefined && !cancelledStaleNodeIds.has(staleSubagentNode.id)) {
        cancelledStaleNodeIds.add(staleSubagentNode.id);
        events.push({
          id: yield* allocateEventId(),
          type: "node.updated",
          threadId: projection.thread.id,
          ...(item.runId === null ? {} : { runId: item.runId }),
          nodeId: staleSubagentNode.id,
          providerInstanceId,
          occurredAt: now,
          payload: { ...staleSubagentNode, status: "cancelled", completedAt: now },
        });
      }
    }
    // A provider-native subagent thread has no runs: its work is a runless
    // root turn, plus items under it (Claude's live progress item), that
    // only the dead provider process could settle. Left running, the child
    // would show as working forever.
    for (const node of projection.nodes) {
      if (
        node.kind !== "root_turn" ||
        node.runId !== null ||
        !isNonterminalNodeStatus(node.status) ||
        cancelledStaleNodeIds.has(node.id)
      ) {
        continue;
      }
      cancelledStaleNodeIds.add(node.id);
      events.push({
        id: yield* allocateEventId(),
        type: "node.updated",
        threadId: projection.thread.id,
        nodeId: node.id,
        providerInstanceId: projection.thread.providerInstanceId,
        occurredAt: now,
        payload: { ...node, status: "cancelled", completedAt: now },
      });
      for (const item of projection.turnItems) {
        if (
          item.nodeId !== node.id ||
          item.runId !== null ||
          !isNonterminalTurnItemStatus(item.status) ||
          cancelledStaleItemIds.has(item.id)
        ) {
          continue;
        }
        cancelledStaleItemIds.add(item.id);
        events.push({
          id: yield* allocateEventId(),
          type: "turn-item.updated",
          threadId: projection.thread.id,
          nodeId: node.id,
          providerInstanceId: projection.thread.providerInstanceId,
          occurredAt: now,
          payload: {
            ...item,
            status: "cancelled",
            completedAt: now,
            updatedAt: now,
            ...(item.type === "reasoning" || item.type === "assistant_message"
              ? { streaming: false }
              : {}),
          },
        });
      }
    }
    return events;
  });

/**
 * Clears the persisted Waiting roster and idles active provider threads whose
 * provider process is gone, without resurrecting active status. Scoped to one
 * provider session's threads when `providerSessionId` is given.
 * `onClearedRosterTask` sees each task cleared from a root provider thread's roster.
 */
export const staleProviderThreadEvents = <E>(input: {
  readonly projection: ProjectionRuntimeRecoveryState;
  readonly providerSessionId?: string;
  readonly onClearedRosterTask?: (
    providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
    task: OrchestrationV2PendingBackgroundTask,
  ) => void;
  readonly now: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}): Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, E> =>
  Effect.gen(function* () {
    const { projection, now } = input;
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const providerThread of projection.providerThreads ?? []) {
      if (
        input.providerSessionId !== undefined &&
        providerThread.providerSessionId !== input.providerSessionId
      ) {
        continue;
      }
      const needsIdle = providerThread.status === "active";
      const needsRosterClear = (providerThread.pendingBackgroundTasks?.length ?? 0) > 0;
      if (!needsIdle && !needsRosterClear) {
        continue;
      }
      if (input.onClearedRosterTask !== undefined && providerThread.ownerNodeId === null) {
        for (const task of providerThread.pendingBackgroundTasks ?? []) {
          input.onClearedRosterTask(providerThread, task);
        }
      }
      events.push({
        id: yield* input.allocateEventId(),
        type: "provider-thread.updated",
        threadId: projection.thread.id,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        occurredAt: now,
        payload: {
          ...providerThread,
          status: needsIdle ? "idle" : providerThread.status,
          pendingBackgroundTasks: [],
          updatedAt: now,
        },
      });
    }
    return events;
  });
