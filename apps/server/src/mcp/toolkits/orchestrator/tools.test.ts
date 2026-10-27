import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import * as Schema from "effect/Schema";
import {
  ProviderInstanceId,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpSaveScheduledTaskInput,
} from "@t3tools/contracts";

import { DelegateTaskTool, OrchestratorToolkit } from "./tools.ts";

const decodeDelegateTask = Schema.decodeSync(OrchestratorMcpDelegateTaskInput);
const decodeScheduleTask = Schema.decodeSync(OrchestratorMcpSaveScheduledTaskInput);

const {
  create_threads: CreateThreadsTool,
  schedule_task: ScheduleTaskTool,
  t3_thread_update: ThreadUpdateTool,
} = OrchestratorToolkit.tools;

describe("orchestrator MCP tool guidance", () => {
  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "child agent");
    assert.include(CreateThreadsTool.description ?? "", "Not delegation");
    assert.include(CreateThreadsTool.description ?? "", "t3_thread_launch");
    assert.include(DelegateTaskTool.description ?? "", "taskId");
    assert.include(OrchestratorToolkit.tools.t3_thread_send.description ?? "", "fresh task");
    assert.include(OrchestratorToolkit.tools.task_cancel.description ?? "", "including later runs");
  });

  it("points agents at models and options without a role field", () => {
    const target = decodeDelegateTask({
      task: "work",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "medium" }],
      },
    }).target;
    assert.deepEqual(target, {
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "medium" }],
    });
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: ReadonlyArray<string>;
    };
    assert.notProperty(schema.properties ?? {}, "role");
    assert.property(schema.properties ?? {}, "target");
    assert.deepEqual(schema.required, ["task"]);
  });

  it("documents wait timeout as a parent budget, not a child failure", () => {
    const schema = Tool.getJsonSchema(DelegateTaskTool) as {
      readonly properties?: Readonly<
        Record<
          string,
          {
            readonly description?: unknown;
            readonly anyOf?: ReadonlyArray<{ readonly description?: unknown }>;
          }
        >
      >;
    };
    const mode = schema.properties?.mode;
    const timeoutMs = schema.properties?.timeoutMs;
    const modeText = [mode?.description, ...(mode?.anyOf ?? []).map((entry) => entry.description)]
      .filter((value) => typeof value === "string")
      .join(" ");
    const timeoutText = [
      timeoutMs?.description,
      ...(timeoutMs?.anyOf ?? []).map((entry) => entry.description),
    ]
      .filter((value) => typeof value === "string")
      .join(" ");
    assert.include(modeText, "Default 'async'");
    assert.include(timeoutText, "does not cancel the child");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.property(schema.properties ?? {}, "schedule");
    const schedule = { type: "interval", everyMs: 60_000 } as const;
    assert.deepEqual(decodeScheduleTask({ prompt: "work", schedule }).schedule, schedule);
    assert.deepEqual(
      decodeScheduleTask({ prompt: "work", schedule: '{"type":"interval","everyMs":60000}' })
        .schedule,
      schedule,
    );
    assert.include(ScheduleTaskTool.description ?? "", "object, not text");
    assert.include(ScheduleTaskTool.description ?? "", "webhookUrl");
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, ["threadId", "action", "title", "clientRequestId"]);
    assert.include(ThreadUpdateTool.description ?? "", "Workspace and branch cannot change here");
    assert.notProperty(schema.properties ?? {}, "pullRequest");
  });
});
