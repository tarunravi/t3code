import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";

it.effect.each(["expired", "resolved"] as const)(
  "responds only to resolved requests and preserves feedback (%s)",
  (status) => {
    const threadId = ThreadId.make("thread-runtime-request-expired");
    const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
    const requestId = RuntimeRequestId.make("request-expired");
    const respondToRuntimeRequest = vi.fn(
      (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
    );
    const getSession = vi.fn(() =>
      Effect.succeedSome({
        respondToRuntimeRequest,
      } as never),
    );
    const projection = {
      runtimeRequests: [
        {
          id: requestId,
          nodeId: NodeId.make("node-runtime-request-expired"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "command",
          status,
          responseCapability: {
            type: "live",
            providerSessionId,
          },
          createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
          resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const layerTest = RuntimeRequestService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRequest: (_threadId, requestId) =>
              Effect.succeed(
                projection.runtimeRequests.find((request) => request.id === requestId),
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: getSession,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const response = service.respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "decline",
        feedback: "Use an explicit path.",
      });
      if (status === "resolved") {
        yield* response;
        assert.deepEqual(respondToRuntimeRequest.mock.calls, [
          [
            {
              requestId,
              decision: "decline",
              feedback: "Use an explicit path.",
            },
          ],
        ]);
        return;
      }
      const error = yield* response.pipe(Effect.flip);

      assert.equal(error.reason, "request-not-ready");
      assert.equal(
        error.message,
        `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
      );
      assert.isUndefined(error.cause);
      assert.equal(getSession.mock.calls.length, 0);
      assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect.each([
  "delivered",
  "wrong-session",
  "stale-run",
  "wrong-attempt",
  "wrong-binding",
  "wrong-decision",
  "transport-failure",
] as const)(
  "automatic permission response revalidates exact routing and reports %s honestly",
  (outcome) => {
    const threadId = ThreadId.make("automatic-thread");
    const providerSessionId = ProviderSessionId.make("automatic-session");
    const requestId = RuntimeRequestId.make("automatic-request");
    const calls: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput[] = [];
    const request = {
      id: requestId,
      nodeId: NodeId.make("automatic-node"),
      providerTurnId: "native-turn",
      status: "resolved",
      kind: "command",
      decision: "accept",
      automaticDecision: { policy: "full-access", decision: "accept" },
      responseCapability: {
        type: "live",
        providerSessionId: outcome === "wrong-session" ? "other-session" : providerSessionId,
      },
    };
    const layer = RuntimeRequestService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRuntimeRequest: () => Effect.succeed(request as never),
            getRuntimeResponseContext: () =>
              Effect.succeed({
                node: {
                  runId: "owner-run",
                  providerTurnId: "native-turn",
                  providerThreadId: "owner-thread",
                },
              } as never),
            getThreadRecords: () =>
              Effect.succeed({
                runs: [
                  {
                    id: "owner-run",
                    activeAttemptId: "owner-attempt",
                    status: outcome === "stale-run" ? "completed" : "running",
                  },
                ],
                providerTurns: [
                  {
                    id: "native-turn",
                    status: "running",
                    runAttemptId: outcome === "wrong-attempt" ? "old-attempt" : "owner-attempt",
                    providerThreadId: "owner-thread",
                  },
                ],
                providerThreads: [
                  {
                    id: "owner-thread",
                    providerSessionId:
                      outcome === "wrong-binding" ? "other-session" : providerSessionId,
                  },
                ],
              } as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: () =>
              Effect.succeedSome({
                providerSession: { status: "running" },
                respondToRuntimeRequest: (
                  input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
                ) =>
                  Effect.sync(() => {
                    calls.push(input);
                  }).pipe(
                    Effect.andThen(
                      outcome === "transport-failure"
                        ? Effect.fail("ambiguous-native-delivery")
                        : Effect.void,
                    ),
                  ),
              } as never),
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const result = yield* service
        .respond({
          threadId,
          providerSessionId,
          requestId,
          decision: outcome === "wrong-decision" ? "decline" : "accept",
        })
        .pipe(Effect.result);
      assert.equal(result._tag, outcome === "delivered" ? "Success" : "Failure");
      assert.equal(
        calls.length,
        outcome === "delivered" || outcome === "transport-failure" ? 1 : 0,
      );
      if (result._tag === "Failure") {
        assert.equal(
          result.failure.reason,
          outcome === "transport-failure" ? "unexpected-failure" : "request-not-resumable",
        );
        if (outcome === "transport-failure")
          assert.equal(result.failure.cause, "ambiguous-native-delivery");
      }
    }).pipe(Effect.provide(layer));
  },
);
