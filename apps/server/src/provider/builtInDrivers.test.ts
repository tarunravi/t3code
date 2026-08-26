import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

describe("built-in providers", () => {
  it("ships only the Slingshot-backed driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toEqual(["opencode"]);
    expect(BUILT_IN_DRIVERS[0]?.metadata.displayName).toBe("Slingshot");
    expect(BUILT_IN_DRIVERS[0]?.defaultConfig()).toMatchObject({
      enabled: true,
      binaryPath: "sling",
      serverUrl: "",
    });
  });
});
