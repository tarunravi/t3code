import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import { providerFallbackSourceRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** One automatic retry on the configured fallback model after two consecutive provider failures. */
export function providerFallbackCommand(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "turnItems" | "runtimeRequests"
  >,
  settings: Pick<ServerSettingsValue, "fallbackProviderInstanceId" | "fallbackModel">,
): OrchestrationV2Command | null {
  const { fallbackProviderInstanceId, fallbackModel } = settings;
  if (fallbackProviderInstanceId === null || fallbackModel === null) return null;
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    projection.runtimeRequests.some((request) => request.status === "pending")
  ) {
    return null;
  }
  const source = providerFallbackSourceRun(projection.runs, projection.turnItems);
  if (source === null) return null;
  // The run id is the identity: a replayed event dedupes through the command receipt.
  const identity = `provider-fallback:${thread.id}:${source.id}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: thread.id,
    manualContinuationOfRunId: source.id,
    automaticFallbackOfRunId: source.id,
    modelSelection: { instanceId: fallbackProviderInstanceId, model: fallbackModel },
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

// Driven by live run failures rather than a sweep: enabling the setting must not
// retry threads that failed before it, and a missed event only leaves the manual
// resume banner.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const retry = Effect.fn("ProviderFallbackWorker.retry")(function* (threadId: ThreadId) {
      const preferences = yield* settings.getSettings;
      if (preferences.fallbackProviderInstanceId === null || preferences.fallbackModel === null) {
        return;
      }
      const projection = yield* threads.getThreadRecords(threadId, [
        "runs",
        "turnItems",
        "runtimeRequests",
      ]);
      const command = providerFallbackCommand(projection, preferences);
      if (command !== null) yield* threads.dispatch(command);
    });
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "failed"
          ? retry(event.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.provider-fallback.dispatch-failed", {
                  threadId: event.threadId,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.provider-fallback.stream-failed", { cause }),
        ),
      ),
    );
  }),
);
