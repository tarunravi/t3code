import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopKeepAwake from "./DesktopKeepAwake.ts";

interface Recorded {
  readonly spawns: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
  }>;
  killed: number;
  blockersHeld: number;
}

const makeRecorded = (): Recorded => ({ spawns: [], killed: 0, blockersHeld: 0 });

function layerKeepAwake(recorded: Recorded, platform: NodeJS.Platform) {
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const { command: executable, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      recorded.spawns.push({ command: executable, args, exit });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          recorded.killed += 1;
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(recorded.spawns.length),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const powerSaveBlocker = ElectronPowerSaveBlocker.ElectronPowerSaveBlocker.of({
    preventAppSuspension: Effect.acquireRelease(
      Effect.sync(() => {
        recorded.blockersHeld += 1;
      }),
      () =>
        Effect.sync(() => {
          recorded.blockersHeld -= 1;
        }),
    ),
  });
  return DesktopKeepAwake.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(ElectronPowerSaveBlocker.ElectronPowerSaveBlocker, powerSaveBlocker),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
    ),
  );
}

describe("DesktopKeepAwake", () => {
  it("runs caffeinate against the app pid without blocking display sleep", () => {
    assert.deepEqual(DesktopKeepAwake.caffeinateArgs(4242), ["-i", "-m", "-s", "-w", "4242"]);
  });

  it("backs off on repeated quick exits and resets after a stable run", () => {
    const quick = Duration.seconds(1);
    const delays: number[] = [];
    let failures = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const restart = DesktopKeepAwake.nextCaffeinateRestart(failures, quick);
      failures = restart.consecutiveFailures;
      delays.push(Duration.toMillis(restart.delay));
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);

    const afterStableRun = DesktopKeepAwake.nextCaffeinateRestart(failures, Duration.minutes(5));
    assert.strictEqual(afterStableRun.consecutiveFailures, 1);
    assert.strictEqual(Duration.toMillis(afterStableRun.delay), 1000);
  });

  it.effect("starts once, restarts caffeinate after it exits, and stops on disable", () => {
    const recorded = makeRecorded();
    return Effect.gen(function* () {
      const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;
      yield* keepAwake.setEnabled(true);
      yield* keepAwake.setEnabled(true);
      yield* Effect.yieldNow;

      assert.strictEqual(recorded.spawns.length, 1);
      assert.strictEqual(recorded.blockersHeld, 1);
      assert.strictEqual(recorded.spawns[0]?.command, DesktopKeepAwake.CAFFEINATE_PATH);
      assert.deepEqual(recorded.spawns[0]?.args, DesktopKeepAwake.caffeinateArgs(process.pid));

      yield* Deferred.succeed(recorded.spawns[0]!.exit, ChildProcessSpawner.ExitCode(1));
      yield* Effect.yieldNow;
      assert.strictEqual(recorded.spawns.length, 1);
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
      assert.strictEqual(recorded.spawns.length, 2);

      yield* keepAwake.setEnabled(false);
      assert.strictEqual(recorded.killed, 2);
      assert.strictEqual(recorded.blockersHeld, 0);
    }).pipe(Effect.provide(layerKeepAwake(recorded, "darwin")));
  });

  it.effect("does nothing outside macOS", () => {
    const recorded = makeRecorded();
    return Effect.gen(function* () {
      const keepAwake = yield* DesktopKeepAwake.DesktopKeepAwake;
      yield* keepAwake.setEnabled(true);
      yield* Effect.yieldNow;
      assert.strictEqual(recorded.spawns.length, 0);
      assert.strictEqual(recorded.blockersHeld, 0);
    }).pipe(Effect.provide(layerKeepAwake(recorded, "linux")));
  });
});
