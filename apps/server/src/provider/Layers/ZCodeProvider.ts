/**
 * ZCodeProvider — snapshot/probe layer for the ZCode CLI.
 *
 * Health is probed with `zcode --version`. The headless CLI has no model
 * flag or model listing, so the snapshot advertises one "ZCode default" model
 * that runs whatever the user's ZCode provider config selects.
 */
import type { ServerProviderModel, ZCodeSettings } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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
  name: "ZCode default",
  isCustom: false,
  capabilities: createModelCapabilities({ optionDescriptors: [] }),
};

const buildSnapshot = (enabled: boolean, checkedAt: string, probe: ProviderProbeResult) =>
  buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled,
    checkedAt,
    models: [ZCODE_DEFAULT_MODEL],
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
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
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
  );
});
