import {
  ContextTransferId,
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ThreadForkPlanV2 {
  readonly targetThread: OrchestrationV2AppThread;
  readonly transfer: OrchestrationV2ContextTransfer;
}

export class ThreadForkPlanError extends Schema.TaggedError<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ThreadForkServiceV2Shape {
  readonly plan: (input: {
    readonly sourceProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
    /** Null only for a side chat opened before the parent completed any run. */
    readonly sourceRun: OrchestrationV2Run | null;
    readonly sourceProviderThread: OrchestrationV2ProviderThread | undefined;
    readonly canonicalSourcePoint: OrchestrationV2ContextSourcePoint;
    readonly relationshipToParent: "fork" | "side";
    readonly transferId: ContextTransferId;
    readonly targetThreadId: ThreadId;
    readonly title?: string;
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<ThreadForkPlanV2, ThreadForkPlanError>;
}

export class ThreadForkServiceV2 extends Context.Service<
  ThreadForkServiceV2,
  ThreadForkServiceV2Shape
>()("t3/orchestration-v2/ThreadForkService/ThreadForkServiceV2") {}

export const layer: Layer.Layer<ThreadForkServiceV2> = Layer.succeed(
  ThreadForkServiceV2,
  ThreadForkServiceV2.of({
    plan: (input) =>
      Effect.gen(function* () {
        const { sourceRun } = input;
        const isSide = input.relationshipToParent === "side";
        if (sourceRun === null ? !isSide : sourceRun.status !== "completed") {
          return yield* new ThreadForkPlanError({
            sourceThreadId: input.sourceProjection.thread.id,
            targetThreadId: input.targetThreadId,
            cause:
              sourceRun === null
                ? "Fork has no source run."
                : `Fork source run ${sourceRun.id} is ${sourceRun.status}.`,
          });
        }
        const targetThread: OrchestrationV2AppThread = {
          ...input.sourceProjection.thread,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          id: input.targetThreadId,
          title:
            input.title ?? (isSide ? "Side chat" : `${input.sourceProjection.thread.title} fork`),
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: input.sourceProjection.thread.id,
            relationshipToParent: input.relationshipToParent,
            rootThreadId: input.sourceProjection.thread.lineage.rootThreadId,
          },
          // A side chat starts at its boundary; the parent's history reaches the
          // provider through the fork transfer instead of the visible timeline.
          forkedFrom:
            isSide || sourceRun === null
              ? null
              : { type: "run", threadId: input.sourceProjection.thread.id, runId: sourceRun.id },
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        const transfer: OrchestrationV2ContextTransfer = {
          id: input.transferId,
          type: "fork",
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          sourcePoint: input.canonicalSourcePoint,
          basePoint: null,
          sourceProviderInstanceId:
            sourceRun?.providerInstanceId ?? input.sourceProjection.thread.providerInstanceId,
          targetProviderInstanceId: null,
          targetRunId: null,
          status: "pending",
          resolution: null,
          createdBy: input.createdBy,
          error:
            input.sourceProviderThread?.nativeThreadRef?.strength === "strong"
              ? null
              : "Source provider thread does not expose a strong native thread ref.",
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          consumedAt: null,
        };
        return { targetThread, transfer };
      }),
  }),
);
