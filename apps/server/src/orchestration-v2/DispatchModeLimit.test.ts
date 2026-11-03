import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-mode-limit" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:dispatch-mode-limit"),
      title: "Before",
      modelSelection: { instanceId, model: "gpt-5" },
      ...supervised,
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("DispatchModeLimit", (it) => {
  it.effect("refuses a limited command on a thread its user raised, and records nothing", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:limit-raised");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise"),
        threadId,
        runtimeMode: "full-access",
      });
      const rename = {
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId,
        title: "After",
      } as const;
      const refused = yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "Before");

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower"),
        threadId,
        runtimeMode: "approval-required",
      });
      const stillRefused = yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(stillRefused._tag, "OrchestratorThreadAboveModeLimitError");
      yield* orchestrator.dispatch(rename);
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("refuses to fork a source thread its user raised", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sourceThreadId = ThreadId.make("thread:limit-fork-source");
      const targetThreadId = ThreadId.make("thread:limit-fork-target");
      yield* createThread(sourceThreadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-source"),
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });
      const fork = {
        type: "thread.fork",
        commandId: CommandId.make("fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      const refused = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.ok(refused._tag === "OrchestratorThreadAboveModeLimitError");
      assert.equal(refused.threadId, sourceThreadId);
      assert.isNull(yield* projections.getThreadShell(targetThreadId));

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower-source"),
        threadId: sourceThreadId,
        runtimeMode: "approval-required",
      });
      const retried = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(retried._tag, "OrchestratorThreadAboveModeLimitError");
    }),
  );
});

const layerPolicyDatabase = SqlitePersistence.layerMemory;
const layerWithCeiling = Layer.mergeAll(
  layerPolicyDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerPolicyDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "runtime-mode-ceiling" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerPolicyDatabase,
      runEffectWorker: false,
      managedPolicy: {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { maxRuntimeMode: "auto-accept-edits" },
      },
    },
  ),
);

const sendMessage = (threadId: ThreadId, id: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text: id,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});

/** Historical records remain readable, without admitting new work below a managed ceiling. */
const seedHistoricalThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`history:${threadId}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: ProjectId.make("project:dispatch-mode-limit"),
        title: "Historical",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "fixture" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  });

it.layer(layerWithCeiling)("runtime mode ceiling", (it) => {
  it.effect(
    "refuses new execution even when an old caller asks for a mode at or below the ceiling",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make("thread:ceiling-legacy-create");
        const refused = yield* createThread(threadId).pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorRuntimeModeAboveCeilingError");
        assert.isNull(yield* projections.getThreadShell(threadId));
        yield* seedHistoricalThread(threadId);
        for (const runtimeMode of [
          "full-access",
          "auto",
          "auto-accept-edits",
          "approval-required",
        ] as const) {
          const change = yield* orchestrator
            .dispatch({
              type: "thread.runtime-mode.set",
              threadId,
              commandId: CommandId.make(`mode:${runtimeMode}`),
              runtimeMode,
            })
            .pipe(Effect.flip);
          assert.equal(change._tag, "OrchestratorRuntimeModeAboveCeilingError");
        }
        assert.equal(
          (yield* projections.getThreadShell(threadId))?.runtimeMode,
          "approval-required",
        );
      }),
  );

  it.effect("cannot use a legacy saved mode to run, queue, or lower around a managed ceiling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:ceiling-no-fallback");
      yield* seedHistoricalThread(threadId);
      for (const dispatchMode of [
        { type: "start_immediately" },
        { type: "queue_after_active" },
      ] as const) {
        const denied = yield* orchestrator
          .dispatch({ ...sendMessage(threadId, dispatchMode.type), dispatchMode })
          .pipe(Effect.flip);
        assert.equal(denied._tag, "OrchestratorRuntimeModeAboveCeilingError");
      }
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 0);
    }),
  );

  it.effect("applies both caller and managed ceilings inside the command lock", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:ceiling-limited");
      yield* seedHistoricalThread(threadId);
      const refused = yield* orchestrator
        .dispatch(sendMessage(threadId, "limited"))
        .pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
          Effect.flip,
        );
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
    }),
  );
});
