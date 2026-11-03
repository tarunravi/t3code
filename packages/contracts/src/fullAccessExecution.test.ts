import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  ExecutionRuntimeMode,
  RuntimeMode,
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  ScheduledTask,
  ScheduledTaskUpsertInput,
  ProjectSettingsOverrides,
  ServerSettings,
  ServerSettingsPatch,
  ManagedPolicyDocument,
  OrchestratorMcpRuntimeMode,
  clampManagedRuntimeMode,
  AuthMcpClientAccess,
} from "./index.ts";

describe("active execution and historical authority", () => {
  it("advertises and accepts Full access only for new commands while keeping saved records readable", () => {
    expect(Schema.decodeUnknownSync(ExecutionRuntimeMode)("full-access")).toBe("full-access");
    const json = JSON.stringify(Schema.toJsonSchemaDocument(ExecutionRuntimeMode));
    expect(json).toContain('"full-access"');
    expect(json).not.toContain('"approval-required"');
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      expect(Schema.decodeUnknownSync(RuntimeMode)(mode)).toBe(mode);
      expect(Schema.decodeUnknownSync(OrchestrationV2AppThread.fields.runtimeMode)(mode)).toBe(
        mode,
      );
      expect(Schema.decodeUnknownSync(ScheduledTask.fields.runtimeMode)(mode)).toBe(mode);
      expect(() => Schema.decodeUnknownSync(ExecutionRuntimeMode)(mode)).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(ScheduledTaskUpsertInput.fields.runtimeMode)(mode),
      ).toThrow();
      expect(() => Schema.decodeUnknownSync(OrchestratorMcpRuntimeMode)(mode)).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(OrchestrationV2Command)({
          type: "thread.runtime-mode.set",
          commandId: "test",
          threadId: "test",
          runtimeMode: mode,
        }),
      ).toThrow();
    }
  });

  it("migrates execution defaults, but never authority ceilings or MCP consent scopes", () => {
    expect(Schema.decodeUnknownSync(ServerSettings.fields.defaultRuntimeMode)("auto")).toBe(
      "full-access",
    );
    expect(
      Schema.decodeUnknownSync(ProjectSettingsOverrides)({
        defaultRuntimeMode: "approval-required",
      }).defaultRuntimeMode,
    ).toBe("full-access");
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({ defaultRuntimeMode: "auto" }),
    ).toThrow();
    const policy = Schema.decodeUnknownSync(ManagedPolicyDocument)({
      schemaVersion: 1,
      organization: "Corp",
      limits: { maxRuntimeMode: "auto" },
    });
    expect(policy.limits?.maxRuntimeMode).toBe("auto");
    for (const access of [
      "read-only",
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]) {
      expect(Schema.decodeUnknownSync(AuthMcpClientAccess)(access)).toBe(access);
    }
    expect(
      clampManagedRuntimeMode(
        { organization: "Corp", lockedSettings: [], limits: { maxRuntimeMode: "auto" } },
        "auto",
      ),
    ).toBeUndefined();
    expect(clampManagedRuntimeMode(undefined, "auto")).toBe("full-access");
    expect(clampManagedRuntimeMode(undefined, "full-access", ["auto"])).toBeUndefined();
  });
});
