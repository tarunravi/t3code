// @effect-diagnostics nodeBuiltinImport:off -- Verify the shipped local-model example against the serving API contract.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

describe("DeepSeek Harness local-model example", () => {
  it("targets the Spark head node and respects its advertised limits", () => {
    const example = readFileSync(new URL("../examples/dsh-local.patch.yml", import.meta.url), "utf8");
    expect(example).toContain("http://10.0.0.58:8888/v1");
    expect(example).toContain("contextWindow: 262144");
    expect(example).toContain("maxTokens: 16384");
    expect(example).not.toContain("spark-20d3");
    expect(example).not.toContain("contextWindow: 1000000");
  });
});
