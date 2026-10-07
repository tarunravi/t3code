import { assert, describe, it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ompAcpRegistrySettings, ompPrintArgs, ompPromptTurnTokenUsage } from "./OmpAcpSupport.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

describe("ompAcpRegistrySettings", () => {
  it("launches `omp acp` with the instance's launch arguments", () => {
    const settings = ompAcpRegistrySettings(
      decodeOmpSettings({
        binaryPath: "/opt/homebrew/bin/omp",
        launchArgs: "--model sparksdirect/GLM-5.3-Flash-EXL3 --thinking high --tools 'read,bash'",
        customModels: ["sparks/custom"],
      }),
    );
    assert.equal(settings.source, "local");
    assert.equal(settings.commandPath, "/opt/homebrew/bin/omp");
    assert.deepEqual(settings.commandArgs, [
      "acp",
      "--model",
      "sparksdirect/GLM-5.3-Flash-EXL3",
      "--thinking",
      "high",
      "--tools",
      "read,bash",
    ]);
    assert.deepEqual(settings.customModels, ["sparks/custom"]);
  });

  it("defaults to `omp` on PATH", () => {
    const settings = ompAcpRegistrySettings(decodeOmpSettings({}));
    assert.equal(settings.commandPath, "omp");
    assert.deepEqual(settings.commandArgs, ["acp"]);
    assert.isTrue(settings.enabled);
  });
});

describe("ompPromptTurnTokenUsage", () => {
  it("counts cache reads and writes as input, as T3 normalizes turn usage", () => {
    assert.deepEqual(
      ompPromptTurnTokenUsage({
        usage: {
          inputTokens: 900,
          outputTokens: 412,
          totalTokens: 21_412,
          cachedReadTokens: 20_000,
          cachedWriteTokens: 100,
        },
        status: "completed",
        hasSubagents: false,
      }),
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: 21_000,
        outputTokens: 412,
        cachedInputTokens: 20_000,
        cacheCreationTokens: 100,
        hasSubagents: false,
      },
    );
  });

  it("marks a turn that did not complete as partial", () => {
    const usage = ompPromptTurnTokenUsage({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, thoughtTokens: 3 },
      status: "interrupted",
      hasSubagents: true,
    });
    assert.equal(usage.usageStatus, "partial");
    assert.equal(usage.reasoningTokens, 3);
    assert.isTrue(usage.hasSubagents);
  });
});

describe("ompPrintArgs", () => {
  it("keeps launch flags but drops the tool list, which would override --no-tools", () => {
    const args = ompPrintArgs({
      launchArgs: "--model a/b --tools read,bash --tools=write --config extra.yml",
      model: "default",
      thinking: undefined,
    });
    assert.deepEqual(args.slice(0, 4), ["--model", "a/b", "--config", "extra.yml"]);
    assert.notInclude(args, "--tools");
    assert.notInclude(args, "--tools=write");
    assert.includeMembers(args, ["-p", "--no-session", "--no-tools", "--no-extensions"]);
  });

  it("lets the picked model and thinking level win over launch flags", () => {
    const args = ompPrintArgs({
      launchArgs: "--model a/b --thinking high",
      model: "sparksdirect/GLM-5.3-Flash-EXL3",
      thinking: "low",
    });
    assert.deepEqual(args.slice(0, 8), [
      "--model",
      "a/b",
      "--thinking",
      "high",
      "--model",
      "sparksdirect/GLM-5.3-Flash-EXL3",
      "--thinking",
      "low",
    ]);
  });
});
