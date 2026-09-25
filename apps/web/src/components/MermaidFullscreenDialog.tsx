import { MinusIcon, PlusIcon, ScanIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "./ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  ZOOM_BUTTON_STEP,
  fitTransform,
  wheelZoomFactor,
  zoomAround,
  zoomBounds,
  type PanZoomPoint,
  type PanZoomSize,
  type PanZoomTransform,
} from "./mermaidPanZoom";

/** Full-viewport Mermaid viewer with wheel/pinch zoom, drag panning, and zoom controls. */
export function MermaidFullscreenDialog({
  svg,
  title,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  readonly svg: string;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-span-3 row-start-1 h-full max-w-none overflow-hidden"
        finalFocus={returnFocusRef}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <MermaidPanZoomView key={svg} svg={svg} />
      </DialogPopup>
    </Dialog>
  );
}

function MermaidPanZoomView({ svg }: { readonly svg: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState<PanZoomSize | null>(null);
  const [contentSize, setContentSize] = useState<PanZoomSize | null>(null);
  const [userTransform, setUserTransform] = useState<PanZoomTransform | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointersRef = useRef(new Map<number, PanZoomPoint>());

  // A null user transform means "fit", so the diagram refits on resize until the user zooms or pans.
  const fit = useMemo(
    () => (viewportSize && contentSize ? fitTransform(contentSize, viewportSize) : null),
    [viewportSize, contentSize],
  );
  const transform = userTransform ?? fit;
  const bounds = zoomBounds(fit?.scale ?? 1);

  // Mermaid emits `width="100%"` plus an inline max-width; pin the SVG to its viewBox size so
  // the transform alone controls how large it appears.
  useLayoutEffect(() => {
    const element = contentRef.current?.querySelector("svg");
    if (!element) return;
    const viewBox = element.viewBox.baseVal;
    const measured = element.getBoundingClientRect();
    const width = viewBox?.width || measured.width;
    const height = viewBox?.height || measured.height;
    if (!width || !height) return;
    element.setAttribute("width", String(width));
    element.setAttribute("height", String(height));
    element.style.maxWidth = "none";
    setContentSize({ width, height });
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () =>
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const updateTransform = useCallback(
    (update: (current: PanZoomTransform) => PanZoomTransform) =>
      setUserTransform((current) => {
        const base = current ?? fit;
        return base ? update(base) : current;
      }),
    [fit],
  );

  const zoomBy = useCallback(
    (factor: number, anchor?: PanZoomPoint) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const point = anchor ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
      updateTransform((current) =>
        zoomAround(current, current.scale * factor, point, zoomBounds(fit?.scale ?? 1)),
      );
    },
    [fit, updateTransform],
  );

  const resetToFit = () => setUserTransform(null);

  const toViewportPoint = (clientX: number, clientY: number): PanZoomPoint => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  // React registers wheel listeners as passive, so preventDefault needs a native listener.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomBy(wheelZoomFactor(event, viewport.clientHeight), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, toViewportPoint(event.clientX, event.clientY));
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const next = toViewportPoint(event.clientX, event.clientY);
    const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
    pointers.set(event.pointerId, next);
    updateTransform((current) => {
      if (!other) {
        return {
          ...current,
          x: current.x + next.x - previous.x,
          y: current.y + next.y - previous.y,
        };
      }
      // Two-finger pinch: scale by the change in finger distance around their midpoint,
      // and pan by how far the midpoint moved.
      const previousDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
      const nextDistance = Math.hypot(next.x - other.x, next.y - other.y);
      const previousMid = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
      const nextMid = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
      const zoomed = zoomAround(
        current,
        current.scale * (nextDistance / (previousDistance || 1)),
        previousMid,
        bounds,
      );
      return {
        ...zoomed,
        x: zoomed.x + nextMid.x - previousMid.x,
        y: zoomed.y + nextMid.y - previousMid.y,
      };
    });
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) setDragging(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const pan = (dx: number, dy: number) =>
      updateTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    const actions: Record<string, () => void> = {
      "+": () => zoomBy(ZOOM_BUTTON_STEP),
      "=": () => zoomBy(ZOOM_BUTTON_STEP),
      "-": () => zoomBy(1 / ZOOM_BUTTON_STEP),
      "0": resetToFit,
      ArrowLeft: () => pan(40, 0),
      ArrowRight: () => pan(-40, 0),
      ArrowUp: () => pan(0, 40),
      ArrowDown: () => pan(0, -40),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const zoomPercent = transform ? Math.round(transform.scale * 100) : 100;

  return (
    <div className="relative size-full min-h-0">
      <div
        ref={viewportRef}
        role="region"
        aria-label="Zoomable Mermaid diagram"
        aria-description="Scroll or pinch to zoom, drag to pan. Plus and minus zoom, 0 fits, arrow keys pan."
        tabIndex={0}
        className="size-full touch-none overflow-hidden outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <div
          ref={contentRef}
          className="absolute top-0 left-0 origin-top-left"
          style={{
            transform: transform
              ? `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
              : undefined,
            visibility: transform ? undefined : "hidden",
          }}
          // The SVG comes from Mermaid's strict-mode renderer, same as the inline diagram.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div
        className="absolute top-2 right-2 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-sm"
        role="toolbar"
        aria-label="Diagram zoom controls"
      >
        <ZoomControl
          label="Zoom out"
          disabled={!transform || transform.scale <= bounds.min}
          onClick={() => zoomBy(1 / ZOOM_BUTTON_STEP)}
        >
          <MinusIcon />
        </ZoomControl>
        <span
          className="min-w-12 text-center text-xs text-muted-foreground tabular-nums"
          aria-live="polite"
        >
          {zoomPercent}%
        </span>
        <ZoomControl
          label="Zoom in"
          disabled={!transform || transform.scale >= bounds.max}
          onClick={() => zoomBy(ZOOM_BUTTON_STEP)}
        >
          <PlusIcon />
        </ZoomControl>
        <ZoomControl label="Fit to screen" disabled={!fit} onClick={resetToFit}>
          <ScanIcon />
        </ZoomControl>
        <DialogClose
          aria-label="Close diagram"
          render={<Button type="button" variant="ghost" size="icon-sm" />}
        >
          <XIcon />
        </DialogClose>
      </div>
    </div>
  );
}

function ZoomControl({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
