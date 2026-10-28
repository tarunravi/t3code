// @effect-diagnostics nodeBuiltinImport:off -- Verify the shipped local-model example against the serving API contract.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

describe("local DeepSeek model examples", () => {
  it("target the Spark head node and respect its advertised limits", () => {
    for (const name of ["dsh-local.patch.yml", "omp-models.yml"]) {
      const example = readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8");
      expect(example).toContain("http://10.0.0.58:8888/v1");
      expect(example).toContain("contextWindow: 262144");
      expect(example).toContain("maxTokens: 16384");
      expect(example).not.toContain("spark-20d3");
      expect(example).not.toContain("contextWindow: 1000000");
    }
  });
});
