import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

export const CAFFEINATE_PATH = "/usr/bin/caffeinate";
const MAX_RESTART_DELAY = Duration.minutes(1);
// A run this long counts as healthy, so the next exit restarts quickly again.
const STABLE_RUN = Duration.minutes(1);

const { logInfo, logWarning } = makeComponentLogger("desktop-keep-awake");

/**
 * Prevent idle sleep (-i), disk idle sleep (-m), and system sleep on AC power
 * (-s). Display sleep stays allowed. -w exits caffeinate when T3 Code dies,
 * even if it is killed before it can clean up.
 */
export function caffeinateArgs(pid: number): ReadonlyArray<string> {
  return ["-i", "-m", "-s", "-w", String(pid)];
}

export function nextCaffeinateRestart(
  consecutiveFailures: number,
  ranFor: Duration.Duration,
): { readonly consecutiveFailures: number; readonly delay: Duration.Duration } {
  const failures = Duration.isGreaterThanOrEqualTo(ranFor, STABLE_RUN)
    ? 1
    : consecutiveFailures + 1;
  return {
    consecutiveFailures: failures,
    delay: Duration.min(Duration.seconds(2 ** (failures - 1)), MAX_RESTART_DELAY),
  };
}

export class DesktopKeepAwake extends Context.Service<
  DesktopKeepAwake,
  {
    /** Starts or stops keeping the Mac awake. A no-op on other platforms. */
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopKeepAwake") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
  const layerScope = yield* Effect.scope;
  const active = yield* SynchronizedRef.make<Option.Option<Fiber.Fiber<never>>>(Option.none());

  if (environment.platform !== "darwin") {
    return DesktopKeepAwake.of({ setEnabled: () => Effect.void });
  }

  const runCaffeinate = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(CAFFEINATE_PATH, [...caffeinateArgs(process.pid)], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      return yield* handle.exitCode;
    }),
  );

  const superviseCaffeinate = Effect.gen(function* () {
    let consecutiveFailures = 0;
    while (true) {
      const startedAt = yield* Clock.currentTimeMillis;
      const outcome = yield* Effect.result(runCaffeinate);
      const ranFor = Duration.millis((yield* Clock.currentTimeMillis) - startedAt);
      const restart = nextCaffeinateRestart(consecutiveFailures, ranFor);
      consecutiveFailures = restart.consecutiveFailures;
      yield* logWarning("caffeinate stopped; restarting", {
        ...(Result.isSuccess(outcome)
          ? { exitCode: outcome.success }
          : { error: outcome.failure.message }),
        restartInMs: Duration.toMillis(restart.delay),
      });
      yield* Effect.sleep(restart.delay);
    }
  });

  // The in-process blocker keeps idle sleep away even while caffeinate is
  // missing or between restarts; caffeinate adds disk and system-sleep
  // assertions Electron does not expose.
  const keepAwake = Effect.scoped(
    powerSaveBlocker.preventAppSuspension.pipe(Effect.andThen(superviseCaffeinate)),
  );

  const setEnabled = (enabled: boolean) =>
    SynchronizedRef.updateEffect(active, (current) => {
      if (enabled === Option.isSome(current)) return Effect.succeed(current);
      return Option.match(current, {
        onNone: () =>
          Effect.forkIn(keepAwake, layerScope).pipe(
            Effect.asSome,
            Effect.tap(() => logInfo("keeping Mac awake")),
          ),
        onSome: (fiber) =>
          Fiber.interrupt(fiber).pipe(
            Effect.as(Option.none()),
            Effect.tap(() => logInfo("allowing Mac to sleep")),
          ),
      });
    });

  return DesktopKeepAwake.of({ setEnabled });
});

export const layer = Layer.effect(DesktopKeepAwake, make);
