import { useMemo } from "react";
import {
  buildLevelRows,
  formatOverlayPrice,
  normalizeOverlayGeometry,
  priceToY,
} from "./chartOverlay.js";

/**
 * Interface 2 — TradingView-style RR box + levels/trendlines on the scanned chart.
 */
export default function ChartAnalysisOverlay({
  signal,
  visible = true,
  dense = false,
}) {
  const geometry = useMemo(
    () => normalizeOverlayGeometry(signal || {}),
    [signal]
  );

  const levels = useMemo(
    () => buildLevelRows(signal || {}, geometry, { primaryOnly: true }),
    [signal, geometry]
  );

  const secondaryLevels = useMemo(
    () =>
      buildLevelRows(signal || {}, geometry, { secondaryOnly: true }),
    [signal, geometry]
  );

  const side =
    String(signal?.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const area = geometry.chartArea;
  const x0 = area.x * 100;
  const x1 = (area.x + area.w) * 100;
  const y0 = area.y * 100;
  const y1 = (area.y + area.h) * 100;
  const plotW = Math.max(1, x1 - x0);

  const entryY = priceToY(signal?.entry, geometry);
  const slY = priceToY(signal?.stopLoss, geometry);
  const tp3Y = priceToY(signal?.takeProfit3, geometry);

  // TradingView short/long position tool: grey risk box + cyan reward box
  const riskZone =
    entryY != null && slY != null
      ? { y: Math.min(entryY, slY), h: Math.abs(entryY - slY) }
      : null;
  const rewardZone =
    entryY != null && tp3Y != null
      ? { y: Math.min(entryY, tp3Y), h: Math.abs(entryY - tp3Y) }
      : null;

  const trendlines = geometry.trendlines || [];

  if (!visible || !signal || levels.length < 2) return null;

  const analysisText =
    String(signal.analysis || signal.reasons?.[0] || "").trim() || null;

  return (
    <div
      className={`cs-analysis-overlay${dense ? " is-dense" : ""}`}
      aria-hidden="true"
    >
      <svg
        className="cs-analysis-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {rewardZone ? (
          <rect
            className={`cs-analysis-zone is-reward is-${side.toLowerCase()}`}
            x={x0}
            y={rewardZone.y}
            width={plotW}
            height={Math.max(0.25, rewardZone.h)}
          />
        ) : null}
        {riskZone ? (
          <rect
            className="cs-analysis-zone is-risk"
            x={x0}
            y={riskZone.y}
            width={plotW}
            height={Math.max(0.25, riskZone.h)}
          />
        ) : null}

        {/* Entry divider across the RR box */}
        {entryY != null ? (
          <line
            className="cs-analysis-entry-split"
            x1={x0}
            x2={x1}
            y1={entryY}
            y2={entryY}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}

        {secondaryLevels.map((row) => (
          <line
            key={`sec-${row.key}`}
            className="cs-analysis-level-secondary"
            x1={x0}
            x2={x1}
            y1={row.y}
            y2={row.y}
            vectorEffect="non-scaling-stroke"
          />
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

        {/* Fallback: resistance + support diagonals when Vision omitted lines */}
        {!trendlines.length && entryY != null ? (
          <>
            <line
              className="cs-analysis-trend is-resistance"
              x1={x0 + 3}
              y1={side === "SELL" ? Math.max(y0 + 3, entryY - 14) : Math.min(y1 - 3, entryY + 14)}
              x2={x1 - 4}
              y2={side === "SELL" ? Math.min(y1 - 4, entryY + 10) : Math.max(y0 + 4, entryY - 10)}
              vectorEffect="non-scaling-stroke"
            />
            <line
              className="cs-analysis-trend is-support"
              x1={x0 + 4}
              y1={side === "SELL" ? Math.min(y1 - 3, entryY + 12) : Math.max(y0 + 3, entryY - 12)}
              x2={x1 - 3}
              y2={side === "SELL" ? Math.max(y0 + 6, entryY - 6) : Math.min(y1 - 6, entryY + 6)}
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}

        {levels.map((row) => (
          <line
            key={row.key}
            className={`cs-analysis-level is-${row.tone}`}
            x1={x0}
            x2={x1}
            y1={row.y}
            y2={row.y}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      <div className="cs-analysis-labels">
        <span className={`cs-analysis-badge is-${side.toLowerCase()}`}>
          {side}
          {signal.symbol ? ` ${signal.symbol}` : ""}
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

      {analysisText ? (
        <p className="cs-analysis-caption">{analysisText}</p>
      ) : null}
    </div>
  );
}
