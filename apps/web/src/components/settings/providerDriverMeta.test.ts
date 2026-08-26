import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_CLIENT_DEFINITIONS } from "./providerDriverMeta";

describe("provider driver metadata", () => {
  it("exposes only Slingshot", () => {
    expect(PROVIDER_CLIENT_DEFINITIONS.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "opencode", label: "Slingshot" },
    ]);
  });
});
