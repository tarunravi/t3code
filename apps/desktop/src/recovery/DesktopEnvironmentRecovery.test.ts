import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { EMPTY_CONNECTION_CATALOG_DOCUMENT } from "@t3tools/client-runtime/platform";
import {
  BearerConnectionTarget,
  SshConnectionTarget,
  BearerConnectionProfile,
  SshConnectionProfile,
} from "@t3tools/client-runtime/connection";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DesktopConnectionCatalogStore } from "../app/DesktopConnectionCatalogStore.ts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { make } from "./DesktopEnvironmentRecovery.ts";

const url = EnvironmentId.make("saved-loopback");
const ssh = EnvironmentId.make("saved-ssh");
const catalog = {
  ...EMPTY_CONNECTION_CATALOG_DOCUMENT,
  targets: [
    new BearerConnectionTarget({ environmentId: url, connectionId: "url", label: "Work proxy" }),
    new SshConnectionTarget({ environmentId: ssh, connectionId: "ssh", label: "SSH" }),
  ],
  profiles: [
    new BearerConnectionProfile({
      environmentId: url,
      connectionId: "url",
      label: "Work proxy",
      httpBaseUrl: "http://127.0.0.1:13777",
      wsBaseUrl: "ws://127.0.0.1:13777",
    }),
    new SshConnectionProfile({
      environmentId: ssh,
      connectionId: "ssh",
      label: "SSH",
      target: { alias: "devbox", hostname: "devbox", username: null, port: null },
    }),
  ],
};
const recipe = { script: "existing-login && existing-proxy-restart", automatic: true };
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-recovery-test-" });
  const started = yield* Queue.unbounded<{
    command: ChildProcess.Command;
    exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
    outputRead: Deferred.Deferred<void>;
    stopped: Deferred.Deferred<void>;
  }>();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const outputRead = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const stdout = Stream.concat(
        Stream.make(
          new TextEncoder().encode(
            `${"x".repeat(5_000)}\nSigning in to AWS…\nhttps://example.com/login?user_code=ABCD-EFGH\n`,
          ),
        ),
        Stream.fromEffect(Deferred.succeed(outputRead, undefined)).pipe(Stream.drain),
      );
      yield* Effect.addFinalizer(() => Deferred.succeed(stopped, undefined));
      yield* Queue.offer(started, { command, exit, outputRead, stopped });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        stdout,
        stderr: Stream.empty,
        all: stdout,
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(true),
        kill: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const service = yield* make.pipe(
    Effect.provideService(
      DesktopEnvironment,
      DesktopEnvironment.of({
        path,
        stateDir,
        homeDirectory: stateDir,
      } as DesktopEnvironment["Service"]),
    ),
    Effect.provideService(
      DesktopConnectionCatalogStore,
      DesktopConnectionCatalogStore.of({
        get: Effect.succeedSome(JSON.stringify(catalog)),
        set: () => Effect.succeed(true),
      }),
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  return { service, started, fs, file: path.join(stateDir, "environment-recovery.json") };
});
const finish = (exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>, code: number) =>
  Deferred.succeed(exit, ChildProcessSpawner.ExitCode(code)).pipe(
    Effect.andThen(TestClock.adjust("0 millis")),
  );

describe("desktop environment recovery", () => {
  it.effect(
    "runs once across concurrent windows, outlives preparation, and rearms only on connection for URL and SSH routes",
    () =>
      Effect.gen(function* () {
        const { service, started } = yield* fixture;
        assert.isNull((yield* service.run(url, "automatic")).job);
        assert.strictEqual(yield* Queue.size(started), 0);
        for (const id of [url, ssh]) {
          yield* service.set(id, recipe);
          const joined = yield* Effect.all(
            [service.run(id, "automatic"), service.run(id, "automatic"), service.run(id, "manual")],
            { concurrency: "unbounded" },
          );
          assert.strictEqual(new Set(joined.map((state) => state.job?.id)).size, 1);
          const process = yield* Queue.take(started);
          yield* Deferred.await(process.outputRead);
          yield* TestClock.adjust("16 seconds");
          const state = yield* service.run(id, "automatic");
          assert.strictEqual(state.job?.phase, "browser");
          assert.isAtMost(state.job!.output.length, 4_000);
          assert.deepEqual(state.job?.codes, ["ABCD-EFGH"]);
          assert.strictEqual(yield* Queue.size(started), 0);
          assert.strictEqual(process.command._tag, "StandardCommand");
          if (process.command._tag === "StandardCommand") {
            assert.deepEqual(process.command.args, ["-lc", recipe.script]);
            assert.isTrue(process.command.options.detached);
            assert.strictEqual(process.command.options.stdin, "ignore");
            assert.strictEqual(process.command.options.forceKillAfter, "2 seconds");
          }
          yield* finish(process.exit, 0);
          assert.strictEqual((yield* service.run(id, "automatic")).job?.phase, "done");
          assert.strictEqual(yield* Queue.size(started), 0);
          assert.isNull(
            (yield* service.get([id])).find((entry) => entry.environmentId === id)?.job,
          );
          yield* service.run(id, "automatic");
          const next = yield* Queue.take(started);
          assert.notStrictEqual(
            (yield* service.get([])).find((state) => state.environmentId === id)?.job?.id,
            state.job?.id,
          );
          yield* service.cancel(id);
          assert.isTrue(yield* Deferred.isDone(next.stopped));
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "latches failures, kills cancelled groups, and ignores cancelled completion after explicit retry",
    () =>
      Effect.gen(function* () {
        const { service, started } = yield* fixture;
        yield* service.set(url, recipe);
        yield* service.run(url, "automatic");
        const first = yield* Queue.take(started);
        yield* finish(first.exit, 1);
        assert.strictEqual((yield* service.run(url, "automatic")).job?.phase, "failed");
        assert.strictEqual(yield* Queue.size(started), 0);
        yield* service.run(url, "manual");
        const cancelled = yield* Queue.take(started);
        const oldId = (yield* service.cancel(url)).job?.id;
        assert.isTrue(yield* Deferred.isDone(cancelled.stopped));
        yield* service.run(url, "manual");
        const current = yield* Queue.take(started);
        yield* finish(cancelled.exit, 0);
        const state = (yield* service.get([]))[0]!;
        assert.notStrictEqual(state.job?.id, oldId);
        assert.notStrictEqual(state.job?.phase, "done");
        yield* TestClock.adjust("10 minutes");
        assert.strictEqual((yield* service.get([]))[0]?.job?.phase, "failed");
        assert.include((yield* service.get([]))[0]!.job!.output, "timed out");
        assert.isTrue(yield* Deferred.isDone(current.stopped));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "persists only local scripts and cancels on disable, script removal, and environment deletion",
    () =>
      Effect.gen(function* () {
        const { service, started, fs, file } = yield* fixture;
        yield* service.set(url, recipe);
        yield* service.set(ssh, { ...recipe, automatic: false });
        yield* service.run(ssh, "automatic");
        assert.strictEqual(yield* Queue.size(started), 0);
        yield* service.run(ssh, "manual");
        const disabled = yield* Queue.take(started);
        yield* service.reconcile(JSON.stringify({ ...catalog, disabledEnvironmentIds: [ssh] }));
        assert.isTrue(yield* Deferred.isDone(disabled.stopped));
        yield* service.run(url, "manual");
        const removed = yield* Queue.take(started);
        yield* service.set(url, null);
        assert.isTrue(yield* Deferred.isDone(removed.stopped));
        const saved = yield* fs.readFileString(file);
        assert.notInclude(saved, url);
        assert.include(saved, ssh);
        assert.notInclude(saved, "Signing in");
        yield* service.reconcile(JSON.stringify({ ...catalog, targets: [] }));
        assert.deepEqual(yield* service.get([]), []);
        assert.strictEqual(yield* fs.readFileString(file), "{}");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
