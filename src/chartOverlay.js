/**
 * Helpers to map trade levels + structure onto a chart screenshot.
 * Used by Interface 2 scanner analysis overlay.
 */

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function normalizeRect(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = clamp01(toFiniteNumber(raw.x ?? raw.left));
  const y = clamp01(toFiniteNumber(raw.y ?? raw.top));
  const w = clamp01(toFiniteNumber(raw.w ?? raw.width));
  const h = clamp01(toFiniteNumber(raw.h ?? raw.height));
  if (x == null || y == null || w == null || h == null) return null;
  if (w < 0.2 || h < 0.2) return null;
  return {
    x,
    y,
    w: Math.min(w, 1 - x),
    h: Math.min(h, 1 - y),
  };
}

function normalizeTrendline(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x1 = clamp01(toFiniteNumber(raw.x1));
  const y1 = clamp01(toFiniteNumber(raw.y1));
  const x2 = clamp01(toFiniteNumber(raw.x2));
  const y2 = clamp01(toFiniteNumber(raw.y2));
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  const kind = String(raw.kind || raw.type || "trend")
    .trim()
    .toLowerCase();
  return { x1, y1, x2, y2, kind: kind || "trend" };
}

/** Default plot inset when Vision does not return chartArea (phone MT screenshots). */
export const DEFAULT_CHART_AREA = { x: 0.04, y: 0.1, w: 0.72, h: 0.72 };

/**
 * Normalize geometry fields from the analyze API / client signal.
 */
export function normalizeOverlayGeometry(signal = {}) {
  const chartArea =
    normalizeRect(signal.chartArea) ||
    normalizeRect(signal.plotArea) ||
    { ...DEFAULT_CHART_AREA };

  let priceTop = toFiniteNumber(signal.priceTop ?? signal.axisTop);
  let priceBottom = toFiniteNumber(signal.priceBottom ?? signal.axisBottom);

  const levels = [
    signal.entry,
    signal.stopLoss,
    signal.takeProfit1,
    signal.takeProfit2,
    signal.takeProfit3,
  ]
    .map(toFiniteNumber)
    .filter((n) => n != null);

  if (
    (priceTop == null ||
      priceBottom == null ||
      Math.abs(priceTop - priceBottom) < 1e-9) &&
    levels.length >= 2
  ) {
    const min = Math.min(...levels);
    const max = Math.max(...levels);
    const pad = Math.max((max - min) * 0.35, Math.abs(max) * 0.0015, 1e-6);
    priceTop = max + pad;
    priceBottom = min - pad;
  }

  if (
    priceTop != null &&
    priceBottom != null &&
    priceTop < priceBottom
  ) {
    const swap = priceTop;
    priceTop = priceBottom;
    priceBottom = swap;
  }

  const trendlines = (
    Array.isArray(signal.trendlines) ? signal.trendlines : []
  )
    .map(normalizeTrendline)
    .filter(Boolean)
    .slice(0, 4);

  const structure = (
    Array.isArray(signal.structure) ? signal.structure : []
  )
    .map((row) => {
      if (typeof row === "number" || typeof row === "string") {
        const price = toFiniteNumber(row);
        return price == null ? null : { price, label: "LVL" };
      }
      if (!row || typeof row !== "object") return null;
      const price = toFiniteNumber(row.price ?? row.level);
      if (price == null) return null;
      return {
        price,
        label: String(row.label || row.kind || "LVL")
          .trim()
          .toUpperCase()
          .slice(0, 8),
      };
    })
    .filter(Boolean)
    .slice(0, 4);

  return {
    chartArea,
    priceTop,
    priceBottom,
    trendlines,
    structure,
  };
}

/**
 * Map a price onto SVG viewBox coords (0–100) using chartArea + axis.
 * Returns null when the scale is unavailable.
 */
export function priceToY(price, geometry) {
  const p = toFiniteNumber(price);
  const top = toFiniteNumber(geometry?.priceTop);
  const bottom = toFiniteNumber(geometry?.priceBottom);
  const area = geometry?.chartArea || DEFAULT_CHART_AREA;
  if (p == null || top == null || bottom == null) return null;
  const span = top - bottom;
  if (!(Math.abs(span) > 1e-12)) return null;
  const t = (top - p) / span;
  const yNorm = area.y + Math.min(1, Math.max(0, t)) * area.h;
  return yNorm * 100;
}

export function buildLevelRows(signal, geometry) {
  const side = String(signal?.side || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const defs = [
    { key: "stopLoss", label: "SL", tone: "sl", price: signal?.stopLoss },
    { key: "entry", label: "ENTRY", tone: "entry", price: signal?.entry },
    { key: "takeProfit1", label: "TP1", tone: "tp", price: signal?.takeProfit1 },
    { key: "takeProfit2", label: "TP2", tone: "tp", price: signal?.takeProfit2 },
    { key: "takeProfit3", label: "TP3", tone: "tp", price: signal?.takeProfit3 },
  ];
  return defs
    .map((row) => {
      const y = priceToY(row.price, geometry);
      if (y == null) return null;
      return { ...row, y, side };
    })
    .filter(Boolean);
}

export function formatOverlayPrice(value) {
  const n = toFiniteNumber(value);
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 100) return n.toFixed(3);
  if (abs >= 10) return n.toFixed(4);
  return n.toFixed(5);
}
