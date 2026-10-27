import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { DshDriver, dshAcpSettings } from "@t3tools/provider-dsh/server";
import { DshSettings } from "@t3tools/provider-dsh/settings";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import {
  ProviderEventLoggers,
  NoOpProviderEventLoggers,
} from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeTurnInput } from "../../orchestration-v2/Adapters/AcpAdapterV2.testkit.ts";

const decodeSettings = Schema.decodeSync(DshSettings);
const decodeFrames = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.optional(Schema.String) })),
);
const layer = Layer.mergeAll(
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
    inspect: () =>
      Effect.succeed({
        status: "ready" as const,
        distribution: "local" as const,
        version: "0.2.1-stub",
        agentId: "dsh",
      }),
    resolve: (settings, cwd, environment) =>
      Effect.succeed({
        distribution: "local" as const,
        spawn: {
          command: settings.commandPath,
          args: settings.commandArgs,
          cwd,
          ...(environment === undefined ? {} : { env: environment }),
        },
      }),
  }),
);

describe("DeepSeek Harness driver", () => {
  it("is opt-in and uses the supported ACP profile with quoted patch arguments", () => {
    expect(DshDriver.metadata.hasDefaultInstance).toBe(false);
    expect(
      dshAcpSettings(decodeSettings({ launchArgs: '--patch "/a path/custom.yml"' })),
    ).toMatchObject({
      source: "local",
      commandPath: "dsh",
      commandArgs: ["--profile", "acp", "--patch", "/a path/custom.yml"],
    });
  });
  it.live(
    "drives initialize, model selection, prompt and persistent resume over stdio without session/load",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const log = path.join(directory, "protocol.jsonl");
        const script = yield* path.fromFileUrl(new URL("./DshDriver.fixture.mjs", import.meta.url));
        const binaryPath = writeFakeCli({
          directory,
          name: "dsh",
          source: execScriptSource({ scriptPath: script, expectedArgs: ["--profile", "acp"] }),
          env: { DSH_STUB_LOG: log },
        });
        const instanceId = ProviderInstanceId.make("dsh-test");
        const instance = yield* DshDriver.create({
          instanceId,
          enabled: true,
          environment: [],
          displayName: undefined,
          config: decodeSettings({ binaryPath }),
        });
        const threadId = ThreadId.make("dsh-thread");
        const modelSelection = {
          instanceId,
          model: '["sparksdeepseek","DeepSeek-V4.1-Flash-1017"]',
        };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: directory,
        });
        const providerThread = yield* Effect.gen(function* () {
          const runtime = yield* instance.orchestrationAdapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("dsh-runtime"),
            modelSelection,
            runtimePolicy,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
          });
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              modelSelection,
              now: yield* DateTime.now,
            }),
          );
          const events = yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          );
          expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
          expect(
            events.some(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
            ),
          ).toBe(true);
          expect(providerThread.driver).toBe("dsh");
          return providerThread;
        }).pipe(Effect.scoped);
        const nativeId = providerThread.nativeThreadRef?.nativeId;
        if (nativeId == null) throw new Error("DSH must return a persistent native session ID");
        yield* Effect.gen(function* () {
          const runtime = yield* instance.orchestrationAdapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("dsh-resumed-runtime"),
            modelSelection,
            runtimePolicy,
            initialNativeThreadId: nativeId,
          });
          yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy,
            existingProviderThread: providerThread,
          });
          expect(runtime.providerSession.driver).toBe("dsh");
        }).pipe(Effect.scoped);
        const methods = (yield* fs.readFileString(log))
          .trim()
          .split("\n")
          .map((line) => decodeFrames(line).method);
        expect(methods).toContain("session/set_config_option");
        expect(methods).toContain("session/prompt");
        expect(methods).toContain("session/resume");
        expect(methods).not.toContain("session/load");
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
