import assert from "node:assert/strict";
import test from "node:test";

import { resolveLaunchModelSelection } from "./t3-rpc.mjs";

test("post-install launch defaults to the requested Codex instance and Luna model", () => {
  assert.deepEqual(resolveLaunchModelSelection({}), {
    instanceId: "codex",
    model: "gpt-6-luna",
  });
});

test("launch model selection honors explicit provider and model flags", () => {
  assert.deepEqual(
    resolveLaunchModelSelection({ "provider-instance": "codex", model: "gpt-6-luna" }),
    { instanceId: "codex", model: "gpt-6-luna" },
  );
});
