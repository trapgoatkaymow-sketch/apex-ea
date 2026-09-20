import { useCallback, useEffect, useRef, useState } from "react";
import ChartAnalysisOverlay from "./ChartAnalysisOverlay.jsx";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/**
 * Fullscreen lightbox for the scanned chart + analysis overlay.
 * Supports pinch zoom, wheel zoom, and drag pan.
 */
export default function ChartFullscreenViewer({
  open,
  preview,
  signal,
  onClose,
}) {
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);
  const pinchRef = useRef(null);
  const stageRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const clampZoom = useCallback((value) => {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  }, []);

  const zoomAt = useCallback(
    (nextZoom, clientX, clientY) => {
      const stage = stageRef.current;
      if (!stage) {
        setZoom(clampZoom(nextZoom));
        return;
      }
      const rect = stage.getBoundingClientRect();
      const cx = clientX - rect.left - rect.width / 2;
      const cy = clientY - rect.top - rect.height / 2;
      setZoom((prev) => {
        const z = clampZoom(nextZoom);
        const ratio = z / Math.max(0.01, prev);
        setOffset((off) => ({
          x: cx - (cx - off.x) * ratio,
          y: cy - (cy - off.y) * ratio,
        }));
        return z;
      });
    },
    [clampZoom]
  );

  useEffect(() => {
    if (!open) return undefined;
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onWheelNative = (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.18 : 0.18;
      zoomAt(zoom + delta, e.clientX, e.clientY);
    };
    stage.addEventListener("wheel", onWheelNative, { passive: false });
    return () => stage.removeEventListener("wheel", onWheelNative);
  }, [open, zoom, zoomAt]);

  const onPointerDown = (e) => {
    if (e.pointerType === "touch" && e.target?.setPointerCapture) {
      try {
        e.target.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      ox: offset.x,
      oy: offset.y,
      moved: false,
    };
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag || pinchRef.current) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (zoom <= 1) return;
    setOffset({ x: drag.ox + dx, y: drag.oy + dy });
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinchRef.current = {
        dist,
        zoom,
        cx: (a.clientX + b.clientX) / 2,
        cy: (a.clientY + b.clientY) / 2,
      };
      dragRef.current = null;
    }
  };

  const onTouchMove = (e) => {
    const pinch = pinchRef.current;
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const next = pinch.zoom * (dist / Math.max(1, pinch.dist));
    zoomAt(next, pinch.cx, pinch.cy);
  };

  const onTouchEnd = (e) => {
    if (e.touches.length < 2) pinchRef.current = null;
  };

  const onDoubleClick = (e) => {
    if (zoom > 1.05) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    } else {
      zoomAt(2.2, e.clientX, e.clientY);
    }
  };

  if (!open || !preview) return null;

  return (
    <div className="cs-chart-lightbox" role="dialog" aria-modal="true" aria-label="Full chart analysis">
      <div className="cs-chart-lightbox-bar">
        <button type="button" className="cs-chart-lightbox-close" onClick={onClose}>
          Close
        </button>
        <span className="cs-chart-lightbox-hint">Pinch or scroll to zoom · drag to pan</span>
        <div className="cs-chart-lightbox-zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => {
              const next = clampZoom(zoom - 0.35);
              setZoom(next);
              if (next <= 1) setOffset({ x: 0, y: 0 });
            }}
          >
            −
          </button>
          <em>{Math.round(zoom * 100)}%</em>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => clampZoom(z + 0.35))}
          >
            +
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="cs-chart-lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onDoubleClick={onDoubleClick}
      >
        <div
          className="cs-chart-lightbox-canvas"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
        >
          <div className="cs-chart-frame has-analysis is-lightbox">
            <img className="cs-chart" src={preview} alt="Full chart analysis" draggable={false} />
            {signal ? <ChartAnalysisOverlay signal={signal} visible dense /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
