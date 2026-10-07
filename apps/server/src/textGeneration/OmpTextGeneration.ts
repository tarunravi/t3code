/**
 * OmpTextGeneration — commit messages, PR content, branch names, and thread
 * titles from one ephemeral `omp -p` run with tools, extensions, and session
 * persistence disabled. The prompt goes over stdin so large diffs never hit
 * argv limits.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { TextGenerationError, type OmpSettings } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { OMP_DEFAULT_BINARY, ompPrintArgs } from "../provider/acp/OmpAcpSupport.ts";
import * as TextGenerationOperations from "./TextGenerationOperations.ts";
import { normalizeCliError } from "./TextGenerationUtils.ts";

const OMP_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const binaryPath = settings.binaryPath || OMP_DEFAULT_BINARY;

  const readText = (operation: string, stream: Stream.Stream<Uint8Array, unknown>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("omp", operation, cause, "Failed to collect omp output."),
      ),
    );

  const runOmpJson: TextGenerationOperations.Runner = (request) => {
    const { operation, cwd, prompt, modelSelection } = request;
    return Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(
        binaryPath,
        ompPrintArgs({
          launchArgs: settings.launchArgs,
          model: modelSelection.model,
          thinking: getModelSelectionStringOptionValue(modelSelection, "thinking"),
        }),
        { env: environment },
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: environment,
            cwd,
            shell: spawnCommand.shell,
            stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("omp", operation, cause, "Failed to start omp."),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readText(operation, child.stdout),
          readText(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("omp", operation, cause, "Failed to read omp exit code."),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation,
          detail: detail
            ? `omp exited with code ${exitCode}: ${detail.slice(0, 1_000)}`
            : `omp exited with code ${exitCode}.`,
        });
      }
      const text = stdout.trim();
      if (!text) {
        return yield* new TextGenerationError({ operation, detail: "omp returned empty output." });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "omp", text);
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(OMP_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new TextGenerationError({ operation, detail: "omp request timed out." })),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({ operation, detail: "omp text generation failed.", cause }),
      ),
    );
  };

  return TextGenerationOperations.fromRunner("OmpTextGeneration", runOmpJson);
});
