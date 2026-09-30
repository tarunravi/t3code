/**
 * ZCodeProvider — snapshot/probe layer for the ZCode CLI.
 *
 * Health is probed with `zcode --version`. The headless CLI has no model
 * switch, so the single selection follows ZCode's config. Its label describes
 * the configured selection, not a proxy's resolved model or a resumed session.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { ServerProviderModel, ZCodeSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 10_000;

const ZCODE_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Configured model (unknown)",
  isCustom: false,
  capabilities: createModelCapabilities({ optionDescriptors: [] }),
};

// ZCode's versioned personal-provider config is data. Do not load its runtime,
// evaluate provider rules, or run a prompt to discover the selected model.
const decodeProviderConfig = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      config: Schema.Struct({
        defaultModelSelection: Schema.Struct({
          providerId: Schema.String,
          modelId: Schema.String,
        }),
      }),
    }),
  ),
);

export const readZCodeConfiguredModel = Effect.fn("readZCodeConfiguredModel")(function* (
  environment: NodeJS.ProcessEnv,
  binaryPath = "zcode",
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const paths = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const explicitPath = environment.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  // A wrapper can change its config internally; ambient HOME is not evidence.
  if (binaryPath && binaryPath !== "zcode" && !explicitPath) return ZCODE_DEFAULT_MODEL;
  const baseDir =
    environment.ZCODE_DATA_BASE_DIR?.trim() ||
    (platform === "win32" ? environment.USERPROFILE : environment.HOME) ||
    NodeOS.homedir();
  const path = explicitPath || paths.join(baseDir, ".zcode", "v2", "provider_config.json");
  // A relative override depends on the turn's cwd, which a provider probe lacks.
  if (!paths.isAbsolute(path)) return ZCODE_DEFAULT_MODEL;
  const discovered = yield* fs.readFileString(path).pipe(
    Effect.flatMap(decodeProviderConfig),
    Effect.map(({ config }) => {
      const providerId = config.defaultModelSelection.providerId.trim();
      const modelId = config.defaultModelSelection.modelId.trim();
      return providerId && modelId
        ? { ...ZCODE_DEFAULT_MODEL, name: `${providerId}/${modelId} (configured)` }
        : ZCODE_DEFAULT_MODEL;
    }),
    Effect.catch(() => Effect.succeed(ZCODE_DEFAULT_MODEL)),
    Effect.timeoutOption(2_000),
  );
  return Option.getOrElse(discovered, () => ZCODE_DEFAULT_MODEL);
});

const buildSnapshot = (
  enabled: boolean,
  checkedAt: string,
  probe: ProviderProbeResult,
  model = ZCODE_DEFAULT_MODEL,
) =>
  buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled,
    checkedAt,
    models: [model],
    probe,
  });

export const buildInitialZCodeProviderSnapshot = (
  settings: ZCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    buildSnapshot(settings.enabled, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking ZCode CLI availability..."
        : "ZCode is disabled in T3 Code settings.",
    }),
  );

export const checkZCodeProviderStatus = Effect.fn("checkZCodeProviderStatus")(function* (
  settings: ZCodeSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) return yield* buildInitialZCodeProviderSnapshot(settings);

  const command = settings.binaryPath || "zcode";
  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildSnapshot(true, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? `ZCode CLI (\`${command}\`) is not installed or not on PATH. Set its binary path in the provider settings.`
        : "Failed to execute the ZCode CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildSnapshot(true, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "ZCode CLI timed out while running `--version`.",
    });
  }
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  const model =
    output.code === 0 ? yield* readZCodeConfiguredModel(environment, command) : ZCODE_DEFAULT_MODEL;
  return buildSnapshot(
    true,
    checkedAt,
    output.code === 0
      ? { installed: true, version, status: "ready", auth: { status: "unknown" } }
      : {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "ZCode CLI is installed but failed to run.",
        },
    model,
  );
});
