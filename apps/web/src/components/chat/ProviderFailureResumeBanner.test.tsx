import { RunId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { providerFailureResumeBannerItem } from "./ProviderFailureResumeBanner";

describe("providerFailureResumeBannerItem", () => {
  it("offers resume under the exact title, keyed by the failed run", () => {
    const item = providerFailureResumeBannerItem({
      runId: RunId.make("run-1"),
      disabled: false,
      onResume: () => undefined,
    });

    expect(item.title).toBe("Continue from where you last left off");
    expect(item.id).toBe("provider-failure-resume:run-1");
    expect(renderToStaticMarkup(<>{item.actions}</>)).toContain("Resume");
  });

  it("changes identity when a later run fails", () => {
    const first = providerFailureResumeBannerItem({
      runId: RunId.make("run-1"),
      disabled: false,
      onResume: () => undefined,
    });
    const second = providerFailureResumeBannerItem({
      runId: RunId.make("run-2"),
      disabled: false,
      onResume: () => undefined,
    });

    expect(second.id).not.toBe(first.id);
  });
});
