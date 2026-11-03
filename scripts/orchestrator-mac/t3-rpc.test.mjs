import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { resolveLaunchModelSelection } from "./t3-rpc.mjs";

NodeTest.test("launch refuses implicit provider or model selection", () => {
  NodeAssert.throws(() => resolveLaunchModelSelection({}), /provider-instance/);
  NodeAssert.throws(
    () => resolveLaunchModelSelection({ "provider-instance": "codex" }),
    /model/,
  );
});

NodeTest.test("launch model selection honors explicit provider and model flags", () => {
  NodeAssert.deepEqual(
    resolveLaunchModelSelection({ "provider-instance": "codex", model: "existing-model" }),
    { instanceId: "codex", model: "existing-model" },
  );
});

NodeTest.test(
  "an explicit post-install thread can be continued without a provider or model",
  () => {
    const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-resume-test-"));
    try {
      const prompt = NodePath.join(temp, "post install.md");
      NodeFS.writeFileSync(prompt, "Continue verification without switching models.");
      const result = NodeChildProcess.spawnSync(
        process.execPath,
        [
          NodePath.join(import.meta.dirname, "t3-rpc.mjs"),
          "resume",
          "--thread-id",
          "existing-sol-thread",
          "--message-file",
          prompt,
          "--dry-run",
        ],
        { encoding: "utf8" },
      );
      NodeAssert.equal(result.status, 0, result.stderr);
      NodeAssert.match(result.stdout, /would resume existing-sol-thread/);
      NodeAssert.doesNotMatch(result.stdout, /launched|luna/i);
    } finally {
      NodeFS.rmSync(temp, { recursive: true, force: true });
    }
  },
);
