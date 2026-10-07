import { assert, it } from "@effect/vitest";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

/** In-process `omp -p` that records its argv and stdin, then prints `stdout`. */
const makeFakeOmp = (output: { readonly stdout: string; readonly exitCode?: number }) => {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; stdin: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("unexpected pipeline");
      const stdinConfig = command.options.stdin;
      const stdinStream =
        typeof stdinConfig === "object" && stdinConfig !== null && "stream" in stdinConfig
          ? (stdinConfig.stream as Stream.Stream<Uint8Array>)
          : Stream.empty;
      const stdin = yield* stdinStream.pipe(Stream.decodeText(), Stream.mkString);
      calls.push({ command: command.command, args: command.args, stdin });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_998),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(output.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, calls };
};

it.effect("generates a thread title through a tool-less `omp -p` run fed over stdin", () =>
  Effect.gen(function* () {
    const omp = makeFakeOmp({ stdout: 'Here you go:\n{"title":"Wire omp into T3"}\n' });
    const textGeneration = yield* makeOmpTextGeneration(
      decodeOmpSettings({
        binaryPath: "/opt/homebrew/bin/omp",
        launchArgs: "--model sparksdirect/GLM-5.3-Flash-EXL3 --tools read,bash",
      }),
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner));

    const generated = yield* textGeneration.generateThreadTitle({
      cwd: process.cwd(),
      message: "Add an oh-my-pi provider",
      modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "default"),
    });

    assert.equal(generated.title, "Wire omp into T3");
    assert.equal(omp.calls.length, 1);
    const call = omp.calls[0]!;
    assert.equal(call.command, "/opt/homebrew/bin/omp");
    assert.includeMembers([...call.args], ["-p", "--no-tools", "--no-session"]);
    assert.notInclude(call.args, "--tools");
    assert.include(call.stdin, "Add an oh-my-pi provider");
  }),
);

it.effect("reports a failed omp run with its output", () =>
  Effect.gen(function* () {
    const omp = makeFakeOmp({ stdout: "model not found", exitCode: 1 });
    const textGeneration = yield* makeOmpTextGeneration(decodeOmpSettings({}), {}).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
    );

    const error = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "hello",
        modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "missing/model"),
      })
      .pipe(Effect.flip);

    assert.include(error.detail, "omp exited with code 1: model not found");
    assert.deepEqual(omp.calls[0]!.args.slice(0, 2), ["--model", "missing/model"]);
  }),
);
