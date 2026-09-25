export interface PanZoomSize {
  readonly width: number;
  readonly height: number;
}

export interface PanZoomPoint {
  readonly x: number;
  readonly y: number;
}

/** Diagram placement inside the viewport: `translate(x, y) scale(scale)` with a top-left origin. */
export interface PanZoomTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface ZoomBounds {
  readonly min: number;
  readonly max: number;
}

export const ZOOM_BUTTON_STEP = 1.25;

const FIT_PADDING = 24;
// Small diagrams stop growing here so a two-node flowchart does not fill a monitor.
const MAX_FIT_SCALE = 2;

/** Centers the whole diagram in the viewport. */
export function fitTransform(content: PanZoomSize, viewport: PanZoomSize): PanZoomTransform {
  const scale = Math.max(
    Number.EPSILON,
    Math.min(
      MAX_FIT_SCALE,
      (viewport.width - FIT_PADDING * 2) / content.width,
      (viewport.height - FIT_PADDING * 2) / content.height,
    ),
  );
  return {
    scale,
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
  };
}

/** Allows zooming out to half the fitted size and in to 8x the larger of fit or natural size. */
export function zoomBounds(fitScale: number): ZoomBounds {
  return { min: fitScale / 2, max: Math.max(fitScale, 1) * 8 };
}

/** Zooms to `scale`, clamped to `bounds`, keeping the diagram point under `anchor` fixed. */
export function zoomAround(
  transform: PanZoomTransform,
  scale: number,
  anchor: PanZoomPoint,
  bounds: ZoomBounds,
): PanZoomTransform {
  const nextScale = Math.min(bounds.max, Math.max(bounds.min, scale));
  if (nextScale === transform.scale) return transform;
  const ratio = nextScale / transform.scale;
  return {
    scale: nextScale,
    x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio,
  };
}

/** Converts a wheel event into a zoom multiplier; trackpad pinches arrive as ctrl+wheel. */
export function wheelZoomFactor(
  event: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">,
  pageHeight: number,
): number {
  const pixels =
    event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1);
  return Math.exp(-pixels * (event.ctrlKey ? 0.01 : 0.002));
}
