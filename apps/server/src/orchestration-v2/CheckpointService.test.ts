import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import {
  CheckpointServiceV2,
  checkpointRefForScopeOrdinal,
  layer as checkpointServiceLayer,
} from "./CheckpointService.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const testLayer = checkpointServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          idAllocatorLayer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect.each([true, false])("keeps an existing turn ref only when asked, keep=%s", (keep) => {
  const scope: OrchestrationV2CheckpointScope = {
    id: CheckpointScopeId.make("checkpoint-scope:keep-existing-ref"),
    threadId: ThreadId.make("thread:keep-existing-ref"),
    runId: RunId.make("run:keep-existing-ref:1"),
    nodeId: NodeId.make("node:keep-existing-ref:1"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:keep-existing-ref"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/repo",
    createdAt: DateTime.makeUnsafe("2026-09-25T00:00:00.000Z"),
  };
  const captureCheckpoint = vi.fn(() => Effect.void);
  const testLayer = checkpointServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        idAllocatorLayer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          hasCheckpointRef: () => Effect.succeed(true),
          captureCheckpoint,
          diffCheckpoints: () => Effect.succeed(""),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointServiceV2;
    const checkpoint = yield* checkpoints.capture({
      scope,
      ordinalWithinScope: 1,
      runId: scope.runId,
      nodeId: scope.nodeId!,
      appRunOrdinal: 1,
      capturedAt: scope.createdAt,
      keepExistingRef: keep,
    });
    assert.equal(checkpoint.status, "ready");
    assert.equal(captureCheckpoint.mock.calls.length, keep ? 0 : 1);
  }).pipe(Effect.provide(testLayer));
});
