import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const antigravity = ProviderDriverKind.make("antigravity");
const accountA = ProviderInstanceId.make("antigravity");
const accountB = ProviderInstanceId.make("antigravity_work");
const adapter = (instanceId: ProviderInstanceId) =>
  ({
    instanceId,
    driver: antigravity,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed for selection routing"),
  }) as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provide(NodeCrypto.layerDigest), Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "model-accounts" },
    ProviderAdapterRegistry.layerFromAdapters([adapter(accountA), adapter(accountB)]),
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      serverSettings: {
        providerInstances: {
          [accountA]: { driver: antigravity, enabled: true },
          [accountB]: { driver: antigravity, enabled: true },
        },
        antigravityModelAccounts: { "gemini-4-neon": accountA, "gemini-4-hydrogen": accountB },
      },
    },
  ),
);

it.effect("records each mapped Antigravity model on the account that runs it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:model-accounts");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-model-accounts"),
      threadId,
      projectId: ProjectId.make("project:model-accounts"),
      title: "Model accounts",
      modelSelection: { instanceId: accountA, model: "gemini-4-hydrogen" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const created = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(created.thread.modelSelection, {
      instanceId: accountB,
      model: "gemini-4-hydrogen",
    });

    yield* orchestrator.dispatch({
      type: "thread.model-selection.set",
      commandId: CommandId.make("switch-model-accounts"),
      threadId,
      modelSelection: { instanceId: accountB, model: "gemini-4-neon" },
    });
    const switched = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(switched.thread.modelSelection, {
      instanceId: accountA,
      model: "gemini-4-neon",
    });
  }).pipe(Effect.provide(layerTest)),
);
