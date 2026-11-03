import { expect, it } from "vite-plus/test";
import {
  fullAccessPermissionDecision,
  type ProviderAdapterV2RuntimePolicy,
} from "./ProviderAdapter.ts";
const policy: ProviderAdapterV2RuntimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/test",
};
it("requires native allow-once support and effective unrestricted execution, not just its label", () => {
  expect(fullAccessPermissionDecision(policy, true)).toEqual({
    policy: "full-access",
    decision: "accept",
  });
  expect(fullAccessPermissionDecision(policy, false)).toBeUndefined();
  for (const restricted of [
    { ...policy, runtimeMode: "auto" as const },
    { ...policy, maxRuntimeMode: "auto" as const },
    { ...policy, interactionMode: "plan" as const },
    { ...policy, approvalPolicy: "untrusted" },
    { ...policy, sandboxPolicy: { type: "readOnly" } },
    { ...policy, sandboxPolicy: { type: "workspaceWrite" } },
    { ...policy, sandboxPolicy: { type: "externalSandbox" } },
  ])
    expect(fullAccessPermissionDecision(restricted, true)).toBeUndefined();
});
