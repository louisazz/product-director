import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, X } from "lucide-react";

export interface LightboxImage {
  id: string;
  name: string;
  url: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

const ZOOM_STEP = 1.4;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * In-page image viewer following the PhotoSwipe zoom model.
 *
 * Zoom is expressed relative to the image's natural pixel size, so 100% always
 * means 1:1. The view opens at the "fit" level (never upscaling a small image),
 * and fit doubles as the minimum: zooming out can never shrink the image below
 * the window, which is what made the earlier version drift off-centre. Pan is
 * clamped to the image edges, and is locked to centre whenever the scaled image
 * is smaller than the viewport.
 */
export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps) {
  const total = images.length;
  const current = images[index];

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [pinned, setPinned] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Measure the area actually available to the image.
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStage({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const fitZoom = useMemo(() => {
    if (!natural.width || !natural.height || !stage.width || !stage.height) return 1;
    // Never upscale past 1:1 just to fill the window.
    return Math.min(1, stage.width / natural.width, stage.height / natural.height);
  }, [natural, stage]);

  const maxZoom = Math.max(fitZoom * 4, 1);

  // Until the user takes control, stay fitted — including across image switches
  // and window resizes.
  useEffect(() => {
    if (pinned) return;
    setZoom(fitZoom);
    setOffset({ x: 0, y: 0 });
  }, [fitZoom, pinned]);

  const clampOffset = useCallback((next: { x: number; y: number }, atZoom: number) => {
    const overflowX = Math.max(0, (natural.width * atZoom - stage.width) / 2);
    const overflowY = Math.max(0, (natural.height * atZoom - stage.height) / 2);
    return { x: clamp(next.x, -overflowX, overflowX), y: clamp(next.y, -overflowY, overflowY) };
  }, [natural, stage]);

  // A trackpad pinch fires dozens of wheel events inside one React batch, so
  // reading `zoom`/`offset` from the closure would make every event in the
  // batch start from the same stale value. These refs always hold the latest.
  const zoomRef = useRef(zoom);
  const offsetRef = useRef(offset);
  zoomRef.current = zoom;
  offsetRef.current = offset;

  /** Zoom by a factor, keeping the point under `anchor` visually stationary. */
  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    const node = stageRef.current;
    if (!node) return;
    const from = zoomRef.current;
    const currentOffset = offsetRef.current;
    const next = clamp(from * factor, fitZoom, maxZoom);
    if (next === from) return;
    const ratio = next / from;
    let nextOffset = { x: currentOffset.x * ratio, y: currentOffset.y * ratio };
    if (anchor) {
      const box = node.getBoundingClientRect();
      const fromCentreX = anchor.x - (box.left + box.width / 2) - currentOffset.x;
      const fromCentreY = anchor.y - (box.top + box.height / 2) - currentOffset.y;
      nextOffset = { x: currentOffset.x + fromCentreX * (1 - ratio), y: currentOffset.y + fromCentreY * (1 - ratio) };
    }
    const clamped = clampOffset(nextOffset, next);
    zoomRef.current = next;
    offsetRef.current = clamped;
    setPinned(true);
    setZoom(next);
    setOffset(clamped);
  }, [fitZoom, maxZoom, clampOffset]);

  const fitToWindow = useCallback(() => {
    zoomRef.current = fitZoom;
    offsetRef.current = { x: 0, y: 0 };
    setPinned(false);
    setZoom(fitZoom);
    setOffset({ x: 0, y: 0 });
  }, [fitZoom]);

  const step = useCallback((delta: number) => {
    if (total < 2) return;
    setPinned(false);
    onIndexChange((index + delta + total) % total);
  }, [index, total, onIndexChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape": event.preventDefault(); onClose(); break;
        case "ArrowLeft": event.preventDefault(); step(-1); break;
        case "ArrowRight": event.preventDefault(); step(1); break;
        case "+": case "=": event.preventDefault(); zoomBy(ZOOM_STEP); break;
        case "-": case "_": event.preventDefault(); zoomBy(1 / ZOOM_STEP); break;
        case "0": event.preventDefault(); fitToWindow(); break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, step, zoomBy, fitToWindow]);

  const scaledWidth = natural.width * zoom;
  const scaledHeight = natural.height * zoom;
  const canPan = scaledWidth - stage.width > 1 || scaledHeight - stage.height > 1;
  const canPanRef = useRef(canPan);
  const stageHeightRef = useRef(stage.height);
  canPanRef.current = canPan;
  stageHeightRef.current = stage.height;

  /**
   * Wheel handling must be a native, non-passive listener on the whole overlay.
   * React's onWheel is registered as passive, so preventDefault() is ignored and
   * a trackpad pinch escapes to the browser and zooms the entire page. Binding
   * the overlay (not just the image) also means the gesture works anywhere over
   * the backdrop rather than only when the pointer is exactly on the picture.
   */
  useEffect(() => {
    const node = overlayRef.current;
    if (!node) return;

    const onWheel = (event: WheelEvent) => {
      // A pinch always reports ctrlKey, including on Windows precision touchpads.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stageHeightRef.current || 800 : 1;
        const pixels = clamp(event.deltaY * unit, -120, 120);
        zoomBy(Math.exp(-pixels / 420), { x: event.clientX, y: event.clientY });
        return;
      }
      if (!canPanRef.current) {
        // Still swallow the scroll so the page behind the overlay stays put.
        event.preventDefault();
        return;
      }
      event.preventDefault();
      setPinned(true);
      const panned = clampOffset(
        { x: offsetRef.current.x - event.deltaX, y: offsetRef.current.y - event.deltaY },
        zoomRef.current,
      );
      offsetRef.current = panned;
      setOffset(panned);
    };

    // Safari reports trackpad pinches as gesture events as well; block them so
    // the page cannot zoom underneath the viewer.
    const blockGesture = (event: Event) => event.preventDefault();

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("gesturestart", blockGesture as EventListener);
    node.addEventListener("gesturechange", blockGesture as EventListener);
    node.addEventListener("gestureend", blockGesture as EventListener);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("gesturestart", blockGesture as EventListener);
      node.removeEventListener("gesturechange", blockGesture as EventListener);
      node.removeEventListener("gestureend", blockGesture as EventListener);
    };
  }, [zoomBy, clampOffset]);

  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (!canPan) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current;
    if (!start) return;
    const moved = clampOffset(
      { x: start.ox + (event.clientX - start.x), y: start.oy + (event.clientY - start.y) },
      zoomRef.current,
    );
    offsetRef.current = moved;
    setOffset(moved);
  };

  const endDrag = () => { drag.current = null; setDragging(false); };

  if (!current) return null;

  const atFit = Math.abs(zoom - fitZoom) < 0.001;

  return createPortal(
    <div className="lightbox-overlay" ref={overlayRef} role="dialog" aria-modal="true" aria-label={current.name || "图片预览"}>
      <div className="lightbox-bar">
        <span className="lightbox-name">
          {current.name}
          {total > 1 && <em>{index + 1} / {total}</em>}
        </span>
        <div className="lightbox-tools">
          <span className="lightbox-scale">{zoom ? Math.round(zoom * 100) : 100}%</span>
          <button type="button" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={atFit} aria-label="缩小" title="缩小（-）"><Minus size={14} /></button>
          <button type="button" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= maxZoom - 0.001} aria-label="放大" title="放大（+）"><Plus size={14} /></button>
          <button type="button" onClick={fitToWindow} disabled={atFit} aria-label="适应窗口" title="适应窗口（0）"><Maximize2 size={14} /></button>
          <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭预览" title="关闭（Esc）"><X size={16} /></button>
        </div>
      </div>

      <div
        className="lightbox-stage"
        ref={stageRef}
        onClick={onClose}
      >
        <img
          key={current.id}
          className="lightbox-image"
          src={current.url}
          alt={current.name}
          draggable={false}
          onLoad={(event) => setNatural({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })}
          style={{
            width: scaledWidth || undefined,
            height: scaledHeight || undefined,
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
            transition: dragging ? "none" : "transform .12s ease-out, width .12s ease-out, height .12s ease-out",
            cursor: canPan ? (dragging ? "grabbing" : "grab") : "default",
            visibility: natural.width ? "visible" : "hidden",
          }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => {
            event.stopPropagation();
            atFit ? zoomBy(Math.max(1, fitZoom * 2.5) / zoom, { x: event.clientX, y: event.clientY }) : fitToWindow();
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      </div>

      {total > 1 && (
        <button type="button" className="lightbox-nav is-prev" aria-label="上一张" onClick={() => step(-1)}>
          <ChevronLeft size={22} />
        </button>
      )}
      {total > 1 && (
        <button type="button" className="lightbox-nav is-next" aria-label="下一张" onClick={() => step(1)}>
          <ChevronRight size={22} />
        </button>
      )}
    </div>,
    document.body,
  );
}
