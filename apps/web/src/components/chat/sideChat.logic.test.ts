import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSideChatModelSelection, resolveSideChatParentStatus } from "./sideChat.logic";

const runtime = (status: "running" | "ready" | "failed") =>
  ({ status, lastErrorClass: null }) as never;
const latestRun = (status: "completed" | "interrupted" | "failed") => ({ status }) as never;

describe("resolveSideChatParentStatus", () => {
  it("reports what the parent is doing", () => {
    const idle = {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: null,
      latestRun: null,
    };
    expect(resolveSideChatParentStatus(idle)).toBe("idle");
    expect(resolveSideChatParentStatus({ ...idle, runtime: runtime("running") })).toBe("working");
    expect(resolveSideChatParentStatus({ ...idle, hasPendingApprovals: true })).toBe(
      "needs-approval",
    );
    expect(resolveSideChatParentStatus({ ...idle, hasPendingUserInput: true })).toBe("needs-input");
    expect(resolveSideChatParentStatus({ ...idle, runtime: runtime("failed") })).toBe("failed");
    expect(
      resolveSideChatParentStatus({
        ...idle,
        runtime: runtime("ready"),
        latestRun: latestRun("interrupted"),
      }),
    ).toBe("interrupted");
    expect(
      resolveSideChatParentStatus({
        ...idle,
        runtime: runtime("ready"),
        latestRun: latestRun("completed"),
      }),
    ).toBe("finished");
  });
});

describe("resolveSideChatModelSelection", () => {
  const parent = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" };
  const setting = { instanceId: ProviderInstanceId.make("codex"), model: "gpt" };
  const picked = { instanceId: ProviderInstanceId.make("cursor"), model: "composer" };

  it("prefers the panel pick, then the side chat's own model, then Settings, then the parent", () => {
    const fresh = { modelSelection: parent, latestRun: null };
    const started = { modelSelection: setting, latestRun: latestRun("completed") };
    expect(
      resolveSideChatModelSelection({
        picked: null,
        sideThread: fresh,
        settingsDefault: null,
        parentModelSelection: parent,
      }),
    ).toBe(parent);
    expect(
      resolveSideChatModelSelection({
        picked: null,
        sideThread: fresh,
        settingsDefault: setting,
        parentModelSelection: parent,
      }),
    ).toBe(setting);
    expect(
      resolveSideChatModelSelection({
        picked: null,
        sideThread: started,
        settingsDefault: null,
        parentModelSelection: parent,
      }),
    ).toBe(setting);
    expect(
      resolveSideChatModelSelection({
        picked,
        sideThread: started,
        settingsDefault: setting,
        parentModelSelection: parent,
      }),
    ).toBe(picked);
  });
});
