import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkZCodeProviderStatus, readZCodeConfiguredModel } from "./ZCodeProvider.ts";

const settings = { enabled: true, binaryPath: "zcode-wrapper" };
const config = (providerId = "bifrost", modelId = "sparks/example-model") =>
  JSON.stringify({
    schemaVersion: 1,
    config: {
      defaultModelSelection: { providerId, modelId },
      providerConfigRules: { credential: "must-not-leak", command: "must-not-run" },
    },
  });

const files = (content: string, onRead: (path: string) => void = () => {}) =>
  FileSystem.makeNoop({
    readFileString: (path) => {
      onRead(path);
      return Effect.succeed(content);
    },
  });

const probeSpawner = (environment: NodeJS.ProcessEnv, exitCode = 0) =>
  ChildProcessSpawner.make((command) => {
    assert.isTrue(ChildProcess.isStandardCommand(command));
    if (ChildProcess.isStandardCommand(command)) {
      assert.deepEqual(command.args, ["--version"]);
      assert.deepEqual(command.options.env, environment);
    }
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_002),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.succeed("zcode 0.16.9")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });

describe("ZCode configured model discovery", () => {
  it.effect("does not attribute the ambient default file to a custom wrapper", () =>
    Effect.gen(function* () {
      let reads = 0;
      const environment = { HOME: "/ambient" };
      const snapshot = yield* checkZCodeProviderStatus(settings, environment).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          files(config("ambient", "wrong-model"), () => {
            reads++;
          }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, probeSpawner(environment)),
      );
      assert.equal(snapshot.models[0]?.name, "Configured model (unknown)");
      assert.equal(reads, 0);
    }),
  );

  it.effect("uses the instance override and advertises only the config-following selection", () =>
    Effect.gen(function* () {
      const environment = {
        HOME: "/other-home",
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/instance/provider.json",
      };
      const snapshot = yield* checkZCodeProviderStatus(settings, environment).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          files(config(), (path) => assert.equal(path, "/instance/provider.json")),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, probeSpawner(environment)),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.version, "0.16.9");
      assert.equal(snapshot.models.length, 1);
      assert.equal(snapshot.models[0]?.slug, "default");
      assert.equal(snapshot.models[0]?.name, "bifrost/sparks/example-model (configured)");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.notInclude(JSON.stringify(snapshot), "must-not-");
    }),
  );

  it.effect("honors per-instance data roots and homes without caching another instance", () =>
    Effect.gen(function* () {
      for (const [environment, path] of [
        [
          { ZCODE_DATA_BASE_DIR: "/instance-data", HOME: "/ignored" },
          "/instance-data/.zcode/v2/provider_config.json",
        ],
        [
          { HOME: "/instance-home", USERPROFILE: "/instance-home" },
          "/instance-home/.zcode/v2/provider_config.json",
        ],
      ] as const) {
        const model = yield* readZCodeConfiguredModel(environment).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(
            FileSystem.FileSystem,
            files(config("custom", "alias"), (actual) => assert.equal(actual, path)),
          ),
        );
        assert.equal(model.name, "custom/alias (configured)");
      }
    }),
  );

  it.effect("uses the Windows instance home with Windows path semantics", () =>
    Effect.gen(function* () {
      const model = yield* readZCodeConfiguredModel({ USERPROFILE: "C:\\Users\\instance" }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(
          FileSystem.FileSystem,
          files(config(), (path) =>
            assert.equal(path, "C:\\Users\\instance\\.zcode\\v2\\provider_config.json"),
          ),
        ),
      );
      assert.equal(model.slug, "default");
      assert.equal(model.name, "bifrost/sparks/example-model (configured)");
    }),
  );

  it.effect("keeps aliases verbatim and does not infer a backend from provider rules", () =>
    Effect.gen(function* () {
      const model = yield* readZCodeConfiguredModel({ HOME: "/home", USERPROFILE: "/home" }).pipe(
        Effect.provideService(FileSystem.FileSystem, files(config("proxy", "auto"))),
      );
      assert.equal(model.name, "proxy/auto (configured)");
    }),
  );

  it.effect("falls back for malformed, absent, unsupported, or incomplete selection data", () =>
    Effect.gen(function* () {
      for (const content of [
        "not-json",
        "{}",
        config().replace('"schemaVersion":1', '"schemaVersion":2'),
        config("", "model"),
        config("provider", "  "),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          schemaVersion: 1,
          config: { defaultModelSelection: { modelId: "model" } },
        }),
      ]) {
        const model = yield* readZCodeConfiguredModel({ HOME: "/home", USERPROFILE: "/home" }).pipe(
          Effect.provideService(FileSystem.FileSystem, files(content)),
        );
        assert.equal(model.slug, "default");
        assert.equal(model.name, "Configured model (unknown)");
      }
      const missing = yield* readZCodeConfiguredModel({
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/missing",
      }).pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})));
      assert.equal(missing.name, "Configured model (unknown)");
    }),
  );

  it.effect("does not substitute the host config for an unreadable or relative override", () =>
    Effect.gen(function* () {
      let reads = 0;
      const model = yield* readZCodeConfiguredModel({
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "relative.json",
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          files(config(), () => {
            reads++;
          }),
        ),
      );
      assert.equal(model.name, "Configured model (unknown)");
      assert.equal(reads, 0);
    }),
  );

  it.effect("bounds config discovery without making a prompt request", () =>
    Effect.gen(function* () {
      const fiber = yield* readZCodeConfiguredModel({
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/slow",
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({ readFileString: () => Effect.never }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust(2_000);
      assert.equal((yield* Fiber.join(fiber)).name, "Configured model (unknown)");
    }),
  );

  it.effect("does not read config when disabled or the version probe fails", () =>
    Effect.gen(function* () {
      let reads = 0;
      for (const enabled of [false, true]) {
        const snapshot = yield* checkZCodeProviderStatus({ ...settings, enabled }, {}).pipe(
          Effect.provideService(
            FileSystem.FileSystem,
            files(config(), () => {
              reads++;
            }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, probeSpawner({}, 1)),
        );
        assert.equal(snapshot.models[0]?.name, "Configured model (unknown)");
      }
      assert.equal(reads, 0);
    }),
  );
});
