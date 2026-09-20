import { useMemo } from "react";
import {
  buildLevelRows,
  formatOverlayPrice,
  normalizeOverlayGeometry,
  priceToY,
} from "./chartOverlay.js";

/**
 * Interface 2 — draws trade analysis (levels + trendlines) on the scanned chart.
 */
export default function ChartAnalysisOverlay({ signal, visible = true }) {
  const geometry = useMemo(
    () => normalizeOverlayGeometry(signal || {}),
    [signal]
  );

  const levels = useMemo(
    () => buildLevelRows(signal || {}, geometry),
    [signal, geometry]
  );

  const side = String(signal?.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const area = geometry.chartArea;
  const x0 = area.x * 100;
  const x1 = (area.x + area.w) * 100;
  const y0 = area.y * 100;
  const y1 = (area.y + area.h) * 100;

  const entryY = priceToY(signal?.entry, geometry);
  const slY = priceToY(signal?.stopLoss, geometry);
  const tp3Y = priceToY(signal?.takeProfit3, geometry);

  const riskZone =
    entryY != null && slY != null
      ? {
          y: Math.min(entryY, slY),
          h: Math.abs(entryY - slY),
        }
      : null;
  const rewardZone =
    entryY != null && tp3Y != null
      ? {
          y: Math.min(entryY, tp3Y),
          h: Math.abs(entryY - tp3Y),
        }
      : null;

  const trendlines = geometry.trendlines || [];
  const structure = (geometry.structure || [])
    .map((row) => {
      const y = priceToY(row.price, geometry);
      return y == null ? null : { ...row, y };
    })
    .filter(Boolean);

  if (!visible || !signal || levels.length < 2) return null;

  return (
    <div className="cs-analysis-overlay" aria-hidden="true">
      <svg
        className="cs-analysis-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {/* Plot frame */}
        <rect
          className="cs-analysis-frame"
          x={x0}
          y={y0}
          width={Math.max(1, x1 - x0)}
          height={Math.max(1, y1 - y0)}
        />

        {rewardZone ? (
          <rect
            className={`cs-analysis-zone is-reward is-${side.toLowerCase()}`}
            x={x0}
            y={rewardZone.y}
            width={Math.max(1, x1 - x0)}
            height={Math.max(0.2, rewardZone.h)}
          />
        ) : null}
        {riskZone ? (
          <rect
            className="cs-analysis-zone is-risk"
            x={x0}
            y={riskZone.y}
            width={Math.max(1, x1 - x0)}
            height={Math.max(0.2, riskZone.h)}
          />
        ) : null}

        {structure.map((row, i) => (
          <g key={`st-${i}`} className="cs-analysis-structure">
            <line
              x1={x0}
              x2={x1}
              y1={row.y}
              y2={row.y}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}

        {trendlines.map((line, i) => (
          <line
            key={`tl-${i}`}
            className={`cs-analysis-trend is-${line.kind || "trend"}`}
            x1={line.x1 * 100}
            y1={line.y1 * 100}
            x2={line.x2 * 100}
            y2={line.y2 * 100}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Fallback structure: diagonal bias when Vision omitted trendlines */}
        {!trendlines.length && entryY != null ? (
          <line
            className={`cs-analysis-trend is-bias is-${side.toLowerCase()}`}
            x1={x0 + 2}
            y1={side === "BUY" ? Math.min(y1 - 2, entryY + 8) : Math.max(y0 + 2, entryY - 8)}
            x2={x1 - 2}
            y2={side === "BUY" ? Math.max(y0 + 2, entryY - 10) : Math.min(y1 - 2, entryY + 10)}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {levels.map((row) => (
          <g key={row.key} className={`cs-analysis-level is-${row.tone}`}>
            <line
              x1={x0}
              x2={x1}
              y1={row.y}
              y2={row.y}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              className="cs-analysis-dot"
              cx={x0 + 1.2}
              cy={row.y}
              r="0.7"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </svg>

      <div className="cs-analysis-labels">
        <span className={`cs-analysis-badge is-${side.toLowerCase()}`}>
          {side}
          {signal.symbol ? ` · ${signal.symbol}` : ""}
        </span>
        {levels.map((row) => (
          <span
            key={`lb-${row.key}`}
            className={`cs-analysis-tag is-${row.tone}`}
            style={{ top: `${row.y}%` }}
          >
            <strong>{row.label}</strong>
            <em>{formatOverlayPrice(row.price)}</em>
          </span>
        ))}
      </div>

      {signal.analysis ? (
        <p className="cs-analysis-caption">{signal.analysis}</p>
      ) : null}
    </div>
  );
}
