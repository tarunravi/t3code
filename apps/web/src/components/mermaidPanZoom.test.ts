import { describe, expect, it } from "vite-plus/test";

import { fitTransform, wheelZoomFactor, zoomAround, zoomBounds } from "./mermaidPanZoom";

describe("fitTransform", () => {
  it("scales a large diagram down and centers it", () => {
    const fit = fitTransform({ width: 2000, height: 500 }, { width: 1048, height: 800 });

    expect(fit.scale).toBe(0.5);
    expect(fit.x).toBe(24);
    expect(fit.y).toBe(275);
  });

  it("stops enlarging small diagrams at twice their natural size", () => {
    const fit = fitTransform({ width: 100, height: 50 }, { width: 1000, height: 800 });

    expect(fit.scale).toBe(2);
    expect(fit.x).toBe(400);
    expect(fit.y).toBe(350);
  });
});

describe("zoomAround", () => {
  const bounds = zoomBounds(1);
  const start = { scale: 1, x: 100, y: 50 };

  it("keeps the diagram point under the anchor fixed", () => {
    const anchor = { x: 300, y: 250 };
    const diagramPoint = {
      x: (anchor.x - start.x) / start.scale,
      y: (anchor.y - start.y) / start.scale,
    };

    const zoomed = zoomAround(start, 2, anchor, bounds);

    expect(zoomed.scale).toBe(2);
    expect(zoomed.x + diagramPoint.x * zoomed.scale).toBe(anchor.x);
    expect(zoomed.y + diagramPoint.y * zoomed.scale).toBe(anchor.y);
  });

  it("clamps to the zoom bounds", () => {
    const anchor = { x: 0, y: 0 };

    expect(zoomAround(start, 100, anchor, bounds).scale).toBe(bounds.max);
    expect(zoomAround(start, 0.01, anchor, bounds).scale).toBe(bounds.min);
  });

  it("returns the same transform when already at a bound", () => {
    const atMax = { ...start, scale: bounds.max };

    expect(zoomAround(atMax, bounds.max * 2, { x: 10, y: 10 }, bounds)).toBe(atMax);
  });
});

describe("zoomBounds", () => {
  it("allows half the fitted size and at least 8x natural size", () => {
    expect(zoomBounds(0.1)).toEqual({ min: 0.05, max: 8 });
    expect(zoomBounds(2)).toEqual({ min: 1, max: 16 });
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on upward scroll and out on downward scroll", () => {
    expect(wheelZoomFactor({ deltaY: -100, deltaMode: 0, ctrlKey: false }, 800)).toBeGreaterThan(1);
    expect(wheelZoomFactor({ deltaY: 100, deltaMode: 0, ctrlKey: false }, 800)).toBeLessThan(1);
  });

  it("treats line-mode deltas like pixels and pinches as stronger zoom", () => {
    const pixel = wheelZoomFactor({ deltaY: -16, deltaMode: 0, ctrlKey: false }, 800);

    expect(wheelZoomFactor({ deltaY: -1, deltaMode: 1, ctrlKey: false }, 800)).toBe(pixel);
    expect(wheelZoomFactor({ deltaY: -16, deltaMode: 0, ctrlKey: true }, 800)).toBeGreaterThan(
      pixel,
    );
  });
});
