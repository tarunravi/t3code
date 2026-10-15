import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GoalRunningIndicator } from "./GoalRunningIndicator";

describe("GoalRunningIndicator", () => {
  it("shows the labelled target icon for an active goal", () => {
    const html = renderToStaticMarkup(<GoalRunningIndicator status="active" />);

    expect(html).toContain('aria-label="Goal running"');
    expect(html).toContain("lucide-target");
  });

  it.each([null, "complete", "paused"])("hides for goal status %s", (status) => {
    expect(renderToStaticMarkup(<GoalRunningIndicator status={status} />)).toBe("");
  });
});
