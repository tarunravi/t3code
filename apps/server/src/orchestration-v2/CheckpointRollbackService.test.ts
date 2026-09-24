import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Layer from "effect/Layer";

import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  CheckpointRollbackServiceV2,
  layer as checkpointRollbackLayer,
} from "./CheckpointRollbackService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";
import { ProjectionStoreReadError, ProjectionStoreV2 } from "./ProjectionStore.ts";
import type { ProviderAdapterV2RollbackThreadInput } from "./ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import {
  CodexProviderCapabilitiesV2,
  resolveCodexRollbackTurnCount,
} from "./Adapters/CodexAdapterV2.ts";
import { layer as contextHandoffLayer } from "./ContextHandoffService.ts";
import { decideRollbackExecution } from "./CommandPolicy.ts";

const checkpointRollbackServiceLayer = checkpointRollbackLayer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(contextHandoffLayer.pipe(Layer.provide(idAllocatorLayer))),
);

it.effect("chooses rollback, native fork, or portable context by capability", () =>
  Effect.gen(function* () {
    const input = {
      commandId: CommandId.make("rewrite-policy"),
      threadId: ThreadId.make("rewrite-policy"),
      providerInstanceId: ProviderInstanceId.make("rewrite-provider"),
    };
    const capabilities = CodexProviderCapabilitiesV2;
    assert.equal(yield* decideRollbackExecution({ ...input, capabilities }), "native_rollback");
    const forkOnly = {
      ...capabilities,
      threads: { ...capabilities.threads, canRollbackThread: false },
    };
    assert.equal(
      yield* decideRollbackExecution({ ...input, capabilities: forkOnly, canForkFromTarget: true }),
      "native_fork",
    );
    assert.equal(
      yield* decideRollbackExecution({ ...input, capabilities: forkOnly }),
      "portable_context",
    );
    const unsupported = {
      ...forkOnly,
      context: { ...forkOnly.context, canConsumeHandoffSummaries: false },
    };
    const error = yield* decideRollbackExecution({ ...input, capabilities: unsupported }).pipe(
      Effect.flip,
    );
    assert.ok(error._tag === "CommandPolicyCapabilityUnsupportedError");
    assert.equal(error.capability, "context_handoff");
  }),
);

it.effect.each([
  { targetOrdinal: 0, supported: true, busy: false },
  { targetOrdinal: 1, supported: true, busy: false },
  { targetOrdinal: 1, supported: false, busy: false },
  { targetOrdinal: 1, supported: true, busy: true },
])(
  "portable rewrite retains only the prefix and rejects unsafe requests: %s",
  ({ targetOrdinal, supported, busy }) => {
    const threadId = ThreadId.make("portable-rewrite");
    const providerThreadId = ProviderThreadId.make("portable-original");
    const providerSessionId = ProviderSessionId.make("portable-original-session");
    const providerInstanceId = ProviderInstanceId.make("portable-provider");
    const checkpointId = CheckpointId.make("portable-checkpoint");
    const scopeId = CheckpointScopeId.make("portable-scope");
    const now = DateTime.makeUnsafe("2026-09-22T00:00:00Z");
    const original = {
      id: providerThreadId,
      providerSessionId,
      providerInstanceId,
      driver: "cursor",
      appThreadId: threadId,
      nativeThreadRef: { nativeId: "original-native-id", strength: "strong" },
    };
    const runs = [
      { id: "retained-run", ordinal: 1, status: "completed", rootNodeId: null },
      { id: "replaced-run", ordinal: 2, status: "completed", rootNodeId: null },
      { id: "failed-suffix", ordinal: 3, status: busy ? "queued" : "failed", rootNodeId: null },
      { id: "old-rolled-back", ordinal: 4, status: "rolled_back", rootNodeId: null },
    ];
    const projection = {
      thread: {
        id: threadId,
        worktreePath: null,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test" },
      },
      providerThreads: [original],
      providerSessions: [],
      providerTurns: [],
      nodes: [],
      attempts: [],
      checkpoints: [
        { id: checkpointId, scopeId, status: "ready", appRunOrdinal: targetOrdinal || null },
      ],
      checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
      runs,
      turnItems: runs.map((run, ordinal) => ({
        id: `item-${run.id}`,
        type: "user_message",
        messageId: `message-${run.id}`,
        runId: run.id,
        text: run.id,
        attachments: [],
        startedAt: now,
        ordinal,
      })),
    } as unknown as OrchestrationV2ThreadProjection;
    const events: OrchestrationV2DomainEvent[] = [];
    const restore = vi.fn(() => Effect.die("keep-files rewrite must not restore files"));
    const rollbackThread = vi.fn(() =>
      Effect.die("portable rewrite must not mutate native history"),
    );
    const testLayer = checkpointRollbackServiceLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(CheckpointServiceV2)({ restore }),
          Layer.mock(EventSinkV2)({
            write: (input) =>
              Effect.sync(() => {
                events.push(...input.events);
                return [];
              }),
          }),
          idAllocatorLayer,
          Layer.mock(ProjectionStoreV2)({ getThreadRecords: () => Effect.succeed(projection) }),
          Layer.mock(ProviderSessionManagerV2)({
            open: () =>
              Effect.succeed({
                providerSession: {
                  capabilities: {
                    ...CodexProviderCapabilitiesV2,
                    threads: {
                      ...CodexProviderCapabilitiesV2.threads,
                      canRollbackThread: false,
                      canForkThread: false,
                    },
                    context: {
                      ...CodexProviderCapabilitiesV2.context,
                      canConsumeHandoffSummaries: supported,
                    },
                  },
                },
                rollbackThread,
              } as never),
          }),
          Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* CheckpointRollbackServiceV2;
      const result = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles: false })
        .pipe(Effect.result);
      assert.equal(restore.mock.calls.length, 0);
      assert.equal(rollbackThread.mock.calls.length, 0);
      assert.equal(original.nativeThreadRef.nativeId, "original-native-id");
      if (!supported || busy) {
        assert.equal(result._tag, "Failure");
        assert.deepEqual(events, []);
        return;
      }
      assert.equal(result._tag, "Success");
      const handoff = events.find((event) => event.type === "context-handoff.updated");
      assert.ok(handoff?.type === "context-handoff.updated");
      assert.equal(handoff.payload.history?.messages.length, targetOrdinal);
      if (targetOrdinal > 0) assert.include(handoff.payload.summaryText, "retained-run");
      assert.notInclude(handoff.payload.summaryText, "replaced-run");
      assert.notInclude(handoff.payload.summaryText, "failed-suffix");
      assert.notInclude(handoff.payload.summaryText, "old-rolled-back");
      const replacement = events.find((event) => event.type === "provider-thread.updated");
      assert.ok(replacement?.type === "provider-thread.updated");
      assert.notEqual(replacement.payload.id, providerThreadId);
      assert.notEqual(replacement.payload.providerSessionId, providerSessionId);
      assert.equal(replacement.payload.nativeThreadRef, null);
      assert.equal(replacement.payload.appThreadId, threadId);
      assert.equal(handoff.payload.toProviderThreadId, replacement.payload.id);
      assert.deepEqual(
        events.filter((event) => event.type === "run.updated").map((event) => event.payload.id),
        runs
          .filter((run) => run.ordinal > targetOrdinal && run.status !== "rolled_back")
          .map((run) => run.id),
      );
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect("rejects a non-ready checkpoint before opening a session or restoring files", () => {
  const threadId = ThreadId.make("thread:rollback-non-ready");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
  const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
  const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    checkpoints: [{ id: checkpointId, scopeId, status: "stale" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "rollback-target-invalid");
    assert.equal(
      error.message,
      `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when another provider thread became active", () => {
  const threadId = ThreadId.make("thread:rollback-inactive-provider-thread");
  const requestedProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:requested",
  );
  const activeProviderThreadId = ProviderThreadId.make(
    "provider-thread:rollback-inactive-provider-thread:active",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-inactive-provider-thread",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-inactive-provider-thread");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-inactive-provider-thread");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_inactive_provider_thread");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      activeProviderThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: requestedProviderThreadId,
        providerSessionId,
        providerInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId: requestedProviderThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("rejects a rollback when provider selection changed before execution", () => {
  const threadId = ThreadId.make("thread:rollback-provider-selection-changed");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-selection-changed",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-selection-changed",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-selection-changed");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-selection-changed");
  const originalProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_original",
  );
  const selectedProviderInstanceId = ProviderInstanceId.make(
    "provider_rollback_provider_selection_changed_selected",
  );
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const open = vi.fn(() => Effect.die("provider session open must not run"));
  const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: selectedProviderInstanceId, model: "test-model" },
    },
    providerThreads: [
      {
        id: providerThreadId,
        providerSessionId,
        providerInstanceId: originalProviderInstanceId,
      },
    ],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready" }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManagerV2)({ open }),
        Layer.mock(RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "active-provider-changed");
    assert.equal(
      error.message,
      `Active provider changed before rollback target ${checkpointId} could execute on thread ${threadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
    assert.equal(open.mock.calls.length, 0);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("reports a missing provider turn as a structured rollback failure", () => {
  const threadId = ThreadId.make("thread:rollback-provider-turn-unavailable");
  const providerThreadId = ProviderThreadId.make(
    "provider-thread:rollback-provider-turn-unavailable",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider-session:rollback-provider-turn-unavailable",
  );
  const checkpointId = CheckpointId.make("checkpoint:rollback-provider-turn-unavailable");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-provider-turn-unavailable");
  const providerInstanceId = ProviderInstanceId.make("provider_rollback_provider_turn_unavailable");
  const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
  const projection = {
    thread: {
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    },
    providerThreads: [{ id: providerThreadId, providerSessionId, providerInstanceId }],
    providerSessions: [],
    checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: 1 }],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [],
    attempts: [],
    providerTurns: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({ restore }),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              providerSession: { capabilities: CodexProviderCapabilitiesV2 },
            } as never),
        }),
        Layer.mock(RuntimePolicyV2)({
          resolve: () => Effect.succeed({} as never),
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "provider-turn-unavailable");
    assert.equal(
      error.message,
      `Provider turn for rollback target ${checkpointId} is unavailable on provider thread ${providerThreadId}.`,
    );
    assert.equal(error.cause, undefined);
    assert.equal(restore.mock.calls.length, 0);
  }).pipe(Effect.provide(testLayer));
});

it.effect("wraps underlying failures with an unexpected-failure reason and cause", () => {
  const threadId = ThreadId.make("thread:rollback-unexpected-failure");
  const providerThreadId = ProviderThreadId.make("provider-thread:rollback-unexpected-failure");
  const checkpointId = CheckpointId.make("checkpoint:rollback-unexpected-failure");
  const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-unexpected-failure");
  const projectionError = new ProjectionStoreReadError({
    threadId,
    cause: new Error("database read failed"),
  });
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({}),
        Layer.mock(EventSinkV2)({}),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.fail(projectionError),
        }),
        Layer.mock(ProviderSessionManagerV2)({}),
        Layer.mock(RuntimePolicyV2)({}),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    const error = yield* service
      .execute({
        threadId,
        providerThreadId,
        checkpointId,
        scopeId,
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "unexpected-failure");
    assert.equal(
      error.message,
      `Failed to execute rollback target ${checkpointId} on provider thread ${providerThreadId} for thread ${threadId}.`,
    );
    assert.strictEqual(error.cause, projectionError);
  }).pipe(Effect.provide(testLayer));
});

it.effect.each([
  { restoreFiles: true, shared: "none" },
  { restoreFiles: false, shared: "root" },
  { restoreFiles: true, shared: "root" },
  { restoreFiles: true, shared: "worktree" },
  { restoreFiles: false, shared: "worktree" },
  { restoreFiles: true, shared: "historical" },
  { restoreFiles: false, shared: "none", targetOrdinal: 1 },
])("rewinds safely with %s", ({ restoreFiles, shared, targetOrdinal = 0 }) => {
  const threadId = ThreadId.make("rewind-files");
  const providerThreadId = ProviderThreadId.make("rewind-provider");
  const providerSessionId = ProviderSessionId.make("rewind-session");
  const instanceId = ProviderInstanceId.make("rewind-instance");
  const checkpointId = CheckpointId.make("rewind-start");
  const scopeId = CheckpointScopeId.make("rewind-scope");
  const calls: string[] = [];
  const providerThread = {
    id: providerThreadId,
    providerSessionId,
    providerInstanceId: instanceId,
  };
  const projection = {
    thread: {
      worktreePath: shared === "root" ? null : process.cwd(),
      activeProviderThreadId: providerThreadId,
      modelSelection: { instanceId, model: "test" },
    },
    providerThreads: [providerThread],
    providerSessions: [],
    // Turn 3 remains in the audit history after an earlier rollback.
    providerTurns: [1, 2, 3].map((ordinal) => ({
      id: `turn-${ordinal}`,
      providerThreadId,
      runAttemptId: `attempt-${ordinal}`,
      ordinal,
      status: "completed",
    })),
    nodes: [],
    attempts: [1, 2, 3].map((ordinal) => ({ id: `attempt-${ordinal}`, runId: `run-${ordinal}` })),
    checkpoints: [
      { id: checkpointId, scopeId, status: "ready", appRunOrdinal: targetOrdinal || null },
    ],
    checkpointScopes: [{ id: scopeId, cwd: process.cwd() }],
    runs: [1, 2, 3].map((ordinal) => ({
      id: `run-${ordinal}`,
      ordinal,
      status: ordinal === 3 ? "rolled_back" : "completed",
      rootNodeId: null,
      activeAttemptId: `attempt-${ordinal}`,
    })),
  } as unknown as OrchestrationV2ThreadProjection;
  const testLayer = checkpointRollbackServiceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(CheckpointServiceV2)({
          restore: () =>
            Effect.sync(() => {
              calls.push("files");
            }),
        }),
        Layer.mock(EventSinkV2)({
          write: ({ events }) =>
            Effect.sync(() => {
              assert.ok(
                events.some(
                  (event) => event.type === "run.updated" && event.payload.status === "rolled_back",
                ),
              );
              calls.push("projection");
              return [];
            }),
        }),
        idAllocatorLayer,
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getCheckpointContext: () =>
            Effect.succeed({
              checkpointScopes: [{ cwd: process.cwd() }],
              runs: [],
              checkpoints: [],
            } as never),
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads:
                shared === "worktree" || shared === "historical"
                  ? [
                      {
                        id: ThreadId.make("other-thread"),
                        deletedAt: null,
                        worktreePath: shared === "worktree" ? process.cwd() : null,
                      } as never,
                    ]
                  : [],
            }),
        }),
        Layer.mock(ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              providerSession: { capabilities: CodexProviderCapabilitiesV2 },
              rollbackThread: (input: ProviderAdapterV2RollbackThreadInput) =>
                Effect.gen(function* () {
                  const count = yield* resolveCodexRollbackTurnCount(input);
                  assert.equal(count, 2 - targetOrdinal);
                  calls.push("provider");
                  return { providerThread };
                }),
            } as never),
        }),
        Layer.mock(RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* CheckpointRollbackServiceV2;
    if (restoreFiles && shared !== "none") {
      const error = yield* Effect.flip(
        service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles }),
      );
      assert.equal(error.reason, "shared-workspace");
      assert.deepEqual(calls, []);
      return;
    }
    yield* service.execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles });
    assert.deepEqual(
      calls,
      restoreFiles ? ["provider", "files", "projection"] : ["provider", "projection"],
    );
  }).pipe(Effect.provide(testLayer));
});

it.effect.skipIf(!symlinksSupported)(
  "rejects an archived thread sharing a worktree through a symlink",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-restore-isolation-" });
      const path = yield* Path.Path;
      const alias = path.join(cwd, "alias");
      yield* fileSystem.symlink(cwd, alias);
      const threadId = ThreadId.make("restore-alias-current");
      const otherId = ThreadId.make("restore-alias-archived");
      const projections = ProjectionStoreV2.of({
        getShellSnapshot: () =>
          Effect.succeed({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [],
            archivedThreads: [{ id: otherId, deletedAt: null, worktreePath: alias } as never],
          }),
        getCheckpointContext: () =>
          Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
      } as never);
      const isolated = yield* isCheckpointRestoreIsolated(
        { id: threadId, worktreePath: cwd },
        { cwd },
        { fileSystem, projections },
      );
      assert.isFalse(isolated);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
