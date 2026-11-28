import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { routeCommandModelAccount } from "./modelAccountRouting.ts";

const antigravity = ProviderDriverKind.make("antigravity");
const accountA = ProviderInstanceId.make("antigravity");
const accountB = ProviderInstanceId.make("antigravity_work");
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [accountA]: { driver: antigravity, enabled: true },
    [accountB]: { driver: antigravity, enabled: true },
  },
  antigravityModelAccounts: { "gemini-4-hydrogen": accountB },
};
const commandId = CommandId.make("command-1");
const threadId = ThreadId.make("thread-1");

describe("routeCommandModelAccount", () => {
  it("moves a mapped model's turn, switch, and selection to its account", () => {
    for (const type of ["thread.model-selection.set", "provider.switch"] as const) {
      const command = {
        type,
        commandId,
        threadId,
        modelSelection: { instanceId: accountA, model: "gemini-4-hydrogen" },
      } satisfies OrchestrationV2ServerCommand;
      expect(routeCommandModelAccount(settings, command)).toEqual({
        ...command,
        modelSelection: { instanceId: accountB, model: "gemini-4-hydrogen" },
      });
    }
  });

  it("leaves unmapped models and commands without a selection unchanged", () => {
    const unmapped = {
      type: "thread.model-selection.set",
      commandId,
      threadId,
      modelSelection: { instanceId: accountA, model: "gemini-4-neon" },
    } satisfies OrchestrationV2ServerCommand;
    expect(routeCommandModelAccount(settings, unmapped)).toBe(unmapped);
    const stop = {
      type: "thread.stop",
      commandId,
      threadId,
    } satisfies OrchestrationV2ServerCommand;
    expect(routeCommandModelAccount(settings, stop)).toBe(stop);
  });

  it("does not route a task that runs in a linked environment", () => {
    // Its selection names the other environment's instances.
    const remote = {
      type: "delegated_task.remote.request",
      modelSelection: { instanceId: accountA, model: "gemini-4-hydrogen" },
    } as unknown as OrchestrationV2ServerCommand;
    expect(routeCommandModelAccount(settings, remote)).toBe(remote);
  });
});
