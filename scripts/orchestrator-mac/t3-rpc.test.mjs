import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { resolveLaunchModelSelection } from "./t3-rpc.mjs";

NodeTest.test("post-install launch defaults to the requested Codex instance and Luna model", () => {
  NodeAssert.deepEqual(resolveLaunchModelSelection({}), {
    instanceId: "codex",
    model: "gpt-6-luna",
  });
});

NodeTest.test("launch model selection honors explicit provider and model flags", () => {
  NodeAssert.deepEqual(
    resolveLaunchModelSelection({ "provider-instance": "codex", model: "gpt-6-luna" }),
    { instanceId: "codex", model: "gpt-6-luna" },
  );
});
