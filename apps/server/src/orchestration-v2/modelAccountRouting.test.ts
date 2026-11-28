import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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
const route = (command: OrchestrationV2ServerCommand) =>
  routeCommandModelAccount(settings, command, () => Effect.succeed(null));

describe("routeCommandModelAccount", () => {
  it.effect("moves a mapped model's turn, switch, and selection to its account", () =>
    Effect.gen(function* () {
      for (const type of ["thread.model-selection.set", "provider.switch"] as const) {
        const command = {
          type,
          commandId,
          threadId,
          modelSelection: { instanceId: accountA, model: "gemini-4-hydrogen" },
        } satisfies OrchestrationV2ServerCommand;
        expect(yield* route(command)).toEqual({
          ...command,
          modelSelection: { instanceId: accountB, model: "gemini-4-hydrogen" },
        });
      }
    }),
  );

  it.effect("leaves unmapped models and commands without a selection unchanged", () =>
    Effect.gen(function* () {
      const unmapped = {
        type: "thread.model-selection.set",
        commandId,
        threadId,
        modelSelection: { instanceId: accountA, model: "gemini-4-neon" },
      } satisfies OrchestrationV2ServerCommand;
      expect(yield* route(unmapped)).toBe(unmapped);
      const stop = {
        type: "thread.stop",
        commandId,
        threadId,
      } satisfies OrchestrationV2ServerCommand;
      expect(yield* route(stop)).toBe(stop);
    }),
  );

  it.effect("does not route a task that runs in a linked environment", () =>
    Effect.gen(function* () {
      // Its selection names the other environment's instances.
      const remote = {
        type: "delegated_task.remote.request",
        modelSelection: { instanceId: accountA, model: "gemini-4-hydrogen" },
      } as unknown as OrchestrationV2ServerCommand;
      expect(yield* route(remote)).toBe(remote);
    }),
  );
});
