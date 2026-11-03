import { expect, it } from "vite-plus/test";
import { resolveCompatibleRuntimeMode, runtimeModeOptions } from "./runtimeModeConfig";
it("has one execution choice and never substitutes a supervised provider mode", () => {
  expect(runtimeModeOptions).toEqual(["full-access"]);
  expect(resolveCompatibleRuntimeMode("auto", undefined)).toEqual({
    modes: ["full-access"],
    mode: "full-access",
  });
  expect(resolveCompatibleRuntimeMode("auto", ["full-access"])).toEqual({
    modes: ["full-access"],
    mode: "full-access",
  });
  expect(resolveCompatibleRuntimeMode("auto", ["auto"])).toEqual({
    modes: [],
    mode: "full-access",
  });
});
