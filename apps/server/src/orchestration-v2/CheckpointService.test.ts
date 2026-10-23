import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect.each([
  true,
  false,
  "lookup-failure",
  "retry",
  "historical",
  "historical-missing",
  "historical-no-git",
] as const)("keeps the first captured turn ref, keep=%s", (keep) => {
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
  let refExists = keep !== "retry" && keep !== "historical-missing";
  const captureCheckpoint = vi.fn(() =>
    Effect.sync(() => {
      refExists = true;
    }),
  );
  const testLayer = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(keep !== "historical-no-git"),
          hasCheckpointRef: () =>
            keep === "lookup-failure"
              ? Effect.fail(
                  new VcsProcessTimeoutError({
                    operation: "test.ref",
                    command: "git",
                    cwd: "/repo",
                    timeoutMs: 30000,
                  }),
                )
              : Effect.succeed(refExists),
          captureCheckpoint,
          listAuthoredPaths: () => Effect.succeed(null),
          diffCheckpoints: () => Effect.succeed(""),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const capture = checkpoints.capture({
      scope,
      ordinalWithinScope: 1,
      runId: scope.runId,
      nodeId: scope.nodeId!,
      appRunOrdinal: 1,
      capturedAt: scope.createdAt,
      keepExistingRef: keep !== false,
      historicalRefOnly: typeof keep === "string" && keep.startsWith("historical"),
    });
    if (
      keep === "lookup-failure" ||
      keep === "historical-missing" ||
      keep === "historical-no-git"
    ) {
      const failure = yield* capture.pipe(Effect.flip);
      assert.instanceOf(failure, CheckpointService.CheckpointCaptureError);
      if (keep !== "lookup-failure")
        assert.include(String(failure.cause), "Historical checkpoint unavailable");
      assert.equal(
        captureCheckpoint.mock.calls.length,
        0,
        "an unknown ref must never be overwritten",
      );
      return;
    }
    const checkpoint = yield* capture;
    assert.equal(checkpoint.status, "ready");
    if (keep === "retry") {
      const replay = yield* capture;
      assert.equal(replay.ref, checkpoint.ref);
      assert.equal(replay.id, checkpoint.id);
    }
    assert.equal(
      captureCheckpoint.mock.calls.length,
      keep === true || keep === "historical" ? 0 : 1,
    );
  }).pipe(Effect.provide(testLayer));
});
