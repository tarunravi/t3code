import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export class ElectronPowerSaveBlocker extends Context.Service<
  ElectronPowerSaveBlocker,
  {
    /** Holds a `prevent-app-suspension` blocker until the scope closes. */
    readonly preventAppSuspension: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronPowerSaveBlocker") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronPowerSaveBlocker.of({
  preventAppSuspension: Effect.acquireRelease(
    Effect.sync(() => Electron.powerSaveBlocker.start("prevent-app-suspension")),
    (id) =>
      Effect.sync(() => {
        if (Electron.powerSaveBlocker.isStarted(id)) {
          Electron.powerSaveBlocker.stop(id);
        }
      }),
  ).pipe(Effect.asVoid),
});

export const layer = Layer.succeed(ElectronPowerSaveBlocker, make);
