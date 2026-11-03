import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import {
  DesktopEnvironmentRecoveryRecipeSchema,
  type DesktopEnvironmentRecoveryRecipe,
  type DesktopEnvironmentRecoveryState,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { devboxPath, extractCodes, extractLinks, stripTerminal } from "../devbox/devboxPlan.ts";

type State = DesktopEnvironmentRecoveryState;
type Recipe = DesktopEnvironmentRecoveryRecipe;
const decodeRecipes = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, DesktopEnvironmentRecoveryRecipeSchema)),
);
const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCatalogDocument));
const recoveryRunning = (job: State["job"]) => job?.phase === "running" || job?.phase === "browser";
class RecoveryError extends Schema.TaggedError<RecoveryError>()("RecoveryError", {
  message: Schema.String,
}) {}

export class DesktopEnvironmentRecovery extends Context.Service<
  DesktopEnvironmentRecovery,
  {
    readonly get: (connected: readonly EnvironmentId[]) => Effect.Effect<readonly State[]>;
    readonly set: (id: EnvironmentId, recipe: Recipe | null) => Effect.Effect<State, Error>;
    readonly run: (
      id: EnvironmentId,
      reason: "automatic" | "manual",
    ) => Effect.Effect<State, Error>;
    readonly cancel: (id: EnvironmentId) => Effect.Effect<State>;
    readonly reconcile: (catalog: string) => Effect.Effect<void, Error>;
  }
>()("@t3tools/desktop/recovery/DesktopEnvironmentRecovery") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const mutex = yield* Semaphore.make(1);
  const file = environment.path.join(environment.stateDir, "environment-recovery.json");
  const recipes = new Map(
    Object.entries(
      yield* fs.readFileString(file).pipe(
        Effect.map((raw) => Option.getOrElse(decodeRecipes(raw), () => ({}))),
        Effect.orElseSucceed(() => ({})),
      ),
    ),
  );
  const jobs = new Map<EnvironmentId, NonNullable<State["job"]>>();
  const fibers = new Map<EnvironmentId, Fiber.Fiber<void>>();
  // This latch is shared by every window and survives a failed or cancelled job.
  const attempted = new Set<EnvironmentId>();
  let sequence = 0;
  const snapshot = (id: EnvironmentId): State => ({
    environmentId: id,
    recipe: recipes.get(id) ?? null,
    job: jobs.get(id) ?? null,
  });
  const persist = () =>
    fs.makeDirectory(environment.stateDir, { recursive: true }).pipe(
      Effect.andThen(
        fs.writeFileString(`${file}.tmp`, JSON.stringify(Object.fromEntries(recipes)), {
          mode: 0o600,
        }),
      ),
      Effect.andThen(fs.rename(`${file}.tmp`, file)),
      Effect.mapError(
        () => new RecoveryError({ message: "Could not save the local recovery script." }),
      ),
    );
  const saved = Effect.gen(function* () {
    const raw = yield* store.get.pipe(
      Effect.mapError(() => new RecoveryError({ message: "Could not read saved environments." })),
    );
    return Option.isSome(raw) ? Option.getOrNull(decodeCatalog(raw.value)) : null;
  });
  const requireSaved = (id: EnvironmentId) =>
    saved.pipe(
      Effect.filterOrFail(
        (catalog): catalog is ConnectionCatalogDocument =>
          catalog !== null && catalog.targets.some((target) => target.environmentId === id),
        () => new RecoveryError({ message: "Save this environment before configuring recovery." }),
      ),
    );
  const cancel = Effect.fn("recovery.cancel")(function* (id: EnvironmentId) {
    const job = jobs.get(id);
    if (job && recoveryRunning(job)) jobs.set(id, { ...job, phase: "cancelled" });
    const fiber = fibers.get(id);
    fibers.delete(id);
    if (fiber) yield* Fiber.interrupt(fiber);
    return snapshot(id);
  });
  const set = (id: EnvironmentId, recipe: Recipe | null) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* requireSaved(id);
        yield* cancel(id);
        const previous = recipes.get(id);
        if (recipe === null) recipes.delete(id);
        else recipes.set(id, recipe);
        yield* persist().pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (previous) recipes.set(id, previous);
              else recipes.delete(id);
            }),
          ),
        );
        if (recipe === null) jobs.delete(id);
        return snapshot(id);
      }),
    );
  const run = (id: EnvironmentId, reason: "automatic" | "manual") =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const catalog = yield* requireSaved(id);
        const recipe = recipes.get(id);
        if (
          !recipe ||
          catalog.disabledEnvironmentIds.includes(id) ||
          recoveryRunning(jobs.get(id) ?? null) ||
          (reason === "automatic" && (!recipe.automatic || attempted.has(id)))
        )
          return snapshot(id);
        attempted.add(id);
        const jobId = String(++sequence);
        jobs.set(id, { id: jobId, phase: "running", output: "", links: [], codes: [] });
        const update = (patch: Partial<NonNullable<State["job"]>>) =>
          Effect.sync(() => {
            const job = jobs.get(id);
            if (job?.id === jobId && recoveryRunning(job)) jobs.set(id, { ...job, ...patch });
          });
        let output = "";
        const append = (chunk: string) => {
          output = stripTerminal(output + chunk).slice(-4_000);
          const links = extractLinks(output);
          return update({
            output,
            links,
            codes: extractCodes(output),
            phase: links.length ? "browser" : "running",
          });
        };
        const session = Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(process.env.SHELL || "/bin/sh", ["-lc", recipe.script], {
                cwd: environment.homeDirectory,
                env: { PATH: devboxPath(environment.homeDirectory, process.env.PATH) },
                extendEnv: true,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                detached: true,
                killSignal: "SIGTERM",
                forceKillAfter: "2 seconds",
              }),
            );
            const pump = (stream: typeof handle.stdout) =>
              stream.pipe(Stream.decodeText(), Stream.runForEach(append));
            const [, , code] = yield* Effect.all(
              [pump(handle.stdout), pump(handle.stderr), handle.exitCode],
              { concurrency: "unbounded" },
            );
            return Number(code);
          }),
        ).pipe(
          Effect.timeoutOption("10 minutes"),
          Effect.flatMap((code) =>
            update({
              phase: Option.isSome(code) && code.value === 0 ? "done" : "failed",
              ...(Option.isNone(code)
                ? { output: `${output}\nRecovery timed out after 10 minutes.`.slice(-4_000) }
                : {}),
            }),
          ),
          // Never put CLI output or executable content in logs, spans, or server requests.
          Effect.catch(() =>
            update({
              phase: "failed",
              output: `${output}\nCould not run the local recovery script.`.slice(-4_000),
            }),
          ),
        );
        fibers.set(id, yield* Effect.forkIn(session, scope));
        return snapshot(id);
      }),
    );
  return DesktopEnvironmentRecovery.of({
    get: Effect.fn("recovery.get")((connected) =>
      Effect.sync(() => {
        for (const id of connected) {
          if (!recoveryRunning(jobs.get(id) ?? null)) {
            attempted.delete(id);
            jobs.delete(id);
          }
        }
        return [...recipes.keys()].map((id) => snapshot(id as EnvironmentId));
      }),
    ),
    set,
    run,
    cancel: Effect.fn("recovery.cancelWithPermit")((id) => mutex.withPermits(1)(cancel(id))),
    reconcile: Effect.fn("recovery.reconcile")((raw) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const catalog = Option.getOrNull(decodeCatalog(raw));
          if (!catalog) return;
          let removed = false;
          for (const key of recipes.keys()) {
            const id = key as EnvironmentId;
            const present = catalog.targets.some((target) => target.environmentId === id);
            if (!present || catalog.disabledEnvironmentIds.includes(id)) yield* cancel(id);
            if (!present) {
              recipes.delete(id);
              jobs.delete(id);
              attempted.delete(id);
              removed = true;
            }
          }
          if (removed) yield* persist();
        }),
      ),
    ),
  });
});
export const layer = Layer.effect(DesktopEnvironmentRecovery, make);
