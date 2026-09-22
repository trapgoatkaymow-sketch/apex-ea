import { useMemo, useState } from "react";
import BotAvatar from "./BotAvatar.jsx";
import ScanEye from "./ScanEye.jsx";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";

function formatPrice(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 100) return n.toFixed(3);
  if (abs >= 10) return n.toFixed(4);
  return n.toFixed(5);
}

function levelPct(entry, level, side, kind) {
  const e = Number(entry);
  const l = Number(level);
  if (!Number.isFinite(e) || !Number.isFinite(l) || e === 0) return null;
  const isSell = String(side).toUpperCase() === "SELL";
  let pct;
  if (kind === "tp") {
    pct = isSell ? ((e - l) / e) * 100 : ((l - e) / e) * 100;
  } else {
    pct = isSell ? ((l - e) / e) * 100 : ((e - l) / e) * 100;
  }
  if (!Number.isFinite(pct)) return null;
  const sign = kind === "sl" ? "-" : "+";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

function EqBars({ side }) {
  const heights =
    side === "left"
      ? [22, 38, 30, 48, 34, 44, 26, 40, 28]
      : [36, 24, 46, 32, 42, 28, 50, 34, 30];
  return (
    <div className={`tg-eq tg-eq--${side}`} aria-hidden="true">
      {heights.map((h, i) => (
        <i key={i} style={{ ["--tg-bar"]: `${h}%`, ["--tg-delay"]: `${i * 0.09}s` }} />
      ))}
    </div>
  );
}

function PortalBubbles() {
  return (
    <span className="tg-bubbles" aria-hidden="true">
      {Array.from({ length: 16 }, (_, i) => (
        <i key={i} className={`tg-bubble tg-bubble--${i + 1}`} />
      ))}
    </span>
  );
}

/**
 * Interface 2 scanner — TrapGoat layout (exact visual match to reference).
 */
export default function V2TrapScannerView({
  activeBot,
  connected,
  mt5Login,
  scansLeft,
  preview,
  symbol,
  setSymbol,
  setSymbolSource,
  symbolSource,
  signal,
  setupReady,
  engineActive,
  detectingSymbol,
  busy,
  canScan,
  engineMode,
  openCamera,
  openUpload,
  runScan,
  executeTrade,
  toggleInterface,
  setDetectionStatus,
  setDetectionMessage,
  setDetectionHint,
  CHART_DETECTION_STATUS,
  trades,
  setTrades,
  lotSize,
  setLotSize,
  clampTrades,
  clampLot,
  normalizeLot,
  saveSymbolMeta,
  fills,
}) {
  const [autoDetect, setAutoDetect] = useState(true);
  const side = String(signal?.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const displaySymbol = normalizeBrokerSymbol(signal?.symbol || symbol || "");
  const scanning = Boolean(busy || detectingSymbol || engineActive);

  const confidence = Math.max(
    0,
    Math.min(100, Math.round(Number(signal?.confidence) || 0))
  );

  const levels = useMemo(() => {
    if (!signal) return [];
    return [
      {
        key: "tp1",
        label: "TP1",
        tone: "tp",
        price: signal.takeProfit1,
        pct: levelPct(signal.entry, signal.takeProfit1, side, "tp"),
      },
      {
        key: "tp2",
        label: "TP2",
        tone: "tp",
        price: signal.takeProfit2,
        pct: levelPct(signal.entry, signal.takeProfit2, side, "tp"),
      },
      {
        key: "tp3",
        label: "TP3",
        tone: "tp",
        price: signal.takeProfit3,
        pct: levelPct(signal.entry, signal.takeProfit3, side, "tp"),
      },
      {
        key: "sl",
        label: "SL",
        tone: "sl",
        price: signal.stopLoss,
        pct: levelPct(signal.entry, signal.stopLoss, side, "sl"),
      },
    ];
  }, [signal, side]);

  const robotLabel = String(activeBot?.name || "ZETA SCALPER AI")
    .trim()
    .toUpperCase();

  return (
    <div className="tg-scanner">
      <header className="tg-top">
        <div className="tg-brand">
          <img className="tg-brand-logo" src="/logo.png" alt="" width="36" height="36" />
          <div className="tg-brand-copy">
            <strong>TrapGoat</strong>
            <em>SCANNER</em>
          </div>
        </div>
        <div className="tg-top-actions">
          <button type="button" className="tg-robot-pill" onClick={toggleInterface}>
            <span className="tg-crown" aria-hidden="true">
              ♛
            </span>
            <span>{robotLabel} TRADING ROBOT</span>
            <span className="tg-robot-chevron" aria-hidden="true">
              ›
            </span>
          </button>
          <button
            type="button"
            className="tg-settings"
            aria-label="Switch interface"
            onClick={toggleInterface}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h10M4 12h16M4 17h12"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
              <circle cx="16" cy="7" r="2.2" fill="currentColor" />
              <circle cx="8" cy="12" r="2.2" fill="currentColor" />
              <circle cx="14" cy="17" r="2.2" fill="currentColor" />
            </svg>
          </button>
        </div>
      </header>

      <div className="tg-status-row">
        <span className={`tg-mt${connected ? " is-on" : ""}`}>
          <i aria-hidden="true" />
          {connected ? `MT5 · ${mt5Login}` : "MT5 offline"}
        </span>
      </div>

      <div className="tg-intro">
        <div className="tg-intro-copy">
          <p className="tg-breadcrumb">Analyze · Detect · Execute</p>
          <h2 className="tg-title">Chart Scanner</h2>
          <p className="tg-subtitle">
            Find real trading symbols from your chart screenshot.
          </p>
        </div>
        <span className="tg-scans">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.7" />
            <circle cx="12" cy="12" r="2.4" fill="currentColor" />
          </svg>
          {scansLeft} scans left
        </span>
      </div>

      <div className={`tg-hero${scanning ? " is-scanning" : ""}${preview ? " has-chart" : ""}`}>
        <EqBars side="left" />
        <div className="tg-orb-wrap">
          <div className="tg-orb-glow" aria-hidden="true" />
          <PortalBubbles />
          <div className="tg-orb">
            <div className="tg-orb-ring tg-orb-ring--a" aria-hidden="true" />
            <div className="tg-orb-ring tg-orb-ring--b" aria-hidden="true" />
            <div className="tg-orb-core">
              {preview ? (
                <img className="tg-orb-chart" src={preview} alt="Chart preview" />
              ) : (
                <div className="tg-orb-empty">
                  <BotAvatar
                    className="tg-orb-ea"
                    bot={activeBot}
                    fallback="/zeta-fire-portal.jpg"
                    width="200"
                    height="260"
                  />
                  <span className="tg-orb-vignette" aria-hidden="true" />
                </div>
              )}
            </div>
            {displaySymbol ? (
              <div className="tg-orb-symbol">
                <strong>{displaySymbol}</strong>
                <em>{signal?.timeframe || "Chart symbol"}</em>
              </div>
            ) : null}
            <div className={`tg-orb-badge${scanning ? " is-live" : ""}`}>
              <span className="tg-wave" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
              {scanning
                ? "Scanning…"
                : setupReady
                  ? "Setup ready"
                  : preview
                    ? "Ready to scan"
                    : "Awaiting chart"}
            </div>
            {scanning ? (
              <div className="tg-scan-eye-stage" aria-live="polite">
                <ScanEye size="lg" label="Looking for a signal" />
                <span className="tg-scan-eye-caption">Looking for signal</span>
              </div>
            ) : null}
          </div>
        </div>
        <EqBars side="right" />
      </div>

      <div className="tg-side-panel">
        <label className="tg-auto">
          <span className="tg-auto-icon" aria-hidden="true">
            ⚡
          </span>
          <span className="tg-auto-copy">
            <strong>Auto detection</strong>
            <em>Finds the correct symbol from your chart (no false alerts).</em>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autoDetect}
            className={`tg-switch${autoDetect ? " is-on" : ""}`}
            onClick={() => setAutoDetect((v) => !v)}
          >
            <i />
          </button>
        </label>
      </div>

      <div className="tg-capture">
        <button
          type="button"
          className="tg-cap-btn is-camera"
          onClick={openCamera}
          disabled={busy || !connected}
        >
          <span className="tg-cap-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M4 8.5A2.5 2.5 0 0 1 6.5 6h2l1.2-1.8A1.5 1.5 0 0 1 10.9 3.5h2.2a1.5 1.5 0 0 1 1.2.7L15.5 6h2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </span>
          <span className="tg-cap-text">
            <strong>Camera</strong>
            <em>Open camera</em>
          </span>
        </button>
        <button
          type="button"
          className="tg-cap-btn is-upload"
          onClick={openUpload}
          disabled={busy || !connected}
        >
          <span className="tg-cap-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M5 7.5A1.5 1.5 0 0 1 6.5 6h11A1.5 1.5 0 0 1 19 7.5v9A1.5 1.5 0 0 1 17.5 18h-11A1.5 1.5 0 0 1 5 16.5v-9Z"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="M8 14.5 10.2 12l2.1 2.1L15.5 11l2.5 3.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="tg-cap-text">
            <strong>Upload</strong>
            <em>Choose image</em>
          </span>
        </button>
      </div>

      <div className="tg-desk">
        <label className="tg-pair">
          <span>Pair</span>
          <input
            value={detectingSymbol ? "" : symbol}
            disabled={busy || detectingSymbol}
            placeholder={detectingSymbol ? "Analyzing…" : "e.g. XAUUSDp"}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              const next = normalizeBrokerSymbol(
                String(e.target.value || "").replace(/\s+/g, "")
              );
              setSymbol(next);
              setSymbolSource(next ? "manual" : "");
              if (next) {
                setDetectionStatus(CHART_DETECTION_STATUS.SYMBOL_DETECTED);
                setDetectionMessage(`Symbol: ${next}`);
                setDetectionHint("");
              }
            }}
          />
        </label>
        <div className="tg-size">
          <label>
            <span>Trades</span>
            <input
              type="number"
              min="1"
              max="20"
              value={trades}
              disabled={busy}
              onChange={(e) => {
                const next = clampTrades(e.target.value);
                setTrades(next);
                if (symbol) saveSymbolMeta(symbol, { trades: next, lotSize: clampLot(lotSize) });
              }}
            />
          </label>
          <label>
            <span>Lot</span>
            <input
              type="text"
              inputMode="decimal"
              value={lotSize}
              disabled={busy}
              onChange={(e) => setLotSize(e.target.value)}
              onBlur={() => {
                const next = normalizeLot(lotSize) ?? 0.01;
                setLotSize(next);
                if (symbol) saveSymbolMeta(symbol, { trades: clampTrades(trades), lotSize: next });
              }}
            />
          </label>
        </div>
      </div>

      {!setupReady ? (
        <button
          type="button"
          className="tg-scan-btn"
          onClick={runScan}
          disabled={busy || detectingSymbol || !canScan}
        >
          {busy && engineMode === "scanning"
            ? "Building trade setup…"
            : detectingSymbol
              ? "Analyzing chart…"
              : !connected
                ? "Connect MT5 to Scan"
                : !symbol
                  ? "Waiting for symbol…"
                  : "Scan Chart"}
        </button>
      ) : null}

      {setupReady ? (
        <div className={`tg-result tg-result--${side.toLowerCase()}`}>
          <div className="tg-result-head">
            <div className="tg-result-sym">
              <BotAvatar
                className="tg-result-ea"
                bot={activeBot}
                fallback="/logo.png"
                width="28"
                height="28"
              />
              <div>
                <strong>{displaySymbol || "SETUP"}</strong>
                <em>{signal?.timeframe || "M15"} · Entry {formatPrice(signal?.entry)}</em>
              </div>
            </div>
            <span className={`tg-side-pill is-${side.toLowerCase()}`}>
              {side === "BUY" ? "↑" : "↓"} {side}
            </span>
            <div
              className="tg-confidence"
              style={{ ["--tg-conf"]: confidence }}
              aria-label={`Confidence ${confidence}%`}
              title={`Confidence ${confidence}%`}
            >
              <svg viewBox="0 0 36 36" aria-hidden="true">
                <circle className="tg-conf-track" cx="18" cy="18" r="15" />
                <circle className="tg-conf-val" cx="18" cy="18" r="15" />
              </svg>
              <span className="tg-conf-in">
                <strong>{confidence}</strong>
                <em>%</em>
              </span>
            </div>
          </div>

          <div className="tg-levels">
            {levels.map((row) => (
              <div key={row.key} className={`tg-level is-${row.tone}`}>
                <span className="tg-level-tag">
                  <i aria-hidden="true" />
                  {row.label}
                </span>
                <strong>{formatPrice(row.price)}</strong>
                <em>{row.pct || "—"}</em>
              </div>
            ))}
          </div>

          <div className="tg-manage">
            <label>
              <input
                type="checkbox"
                checked
                readOnly
                aria-checked="true"
              />
              <span>SL → BE after TP1</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked
                readOnly
                aria-checked="true"
              />
              <span>Protect after TP2</span>
            </label>
          </div>

          <button
            type="button"
            className={`tg-execute${busy && engineMode === "trading" ? " is-executing" : ""}`}
            onClick={executeTrade}
            disabled={busy || !connected}
          >
            <span className="tg-execute-fx" aria-hidden="true">
              <i className="tg-execute-fx-glow" />
              <i className="tg-execute-fx-shine" />
              <i className="tg-execute-fx-ripple" />
              <i className="tg-execute-fx-ripple" />
              <i className="tg-execute-fx-spark tg-execute-fx-spark--1" />
              <i className="tg-execute-fx-spark tg-execute-fx-spark--2" />
              <i className="tg-execute-fx-spark tg-execute-fx-spark--3" />
              <i className="tg-execute-fx-spark tg-execute-fx-spark--4" />
              <i className="tg-execute-fx-spark tg-execute-fx-spark--5" />
            </span>
            <span className="tg-execute-icon" aria-hidden="true">
              {busy && engineMode === "trading" ? (
                <span className="tg-execute-icon-spin" />
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
                  <path
                    d="M3.5 12.5 20 4l-3.2 16.2-4.3-5.1-4.8 2.4 1.1-5.4L3.5 12.5Z"
                    fill="currentColor"
                    opacity="0.95"
                  />
                  <path
                    d="M12.5 15.1 20 4l-7.5 11.1Z"
                    fill="currentColor"
                    opacity="0.55"
                  />
                </svg>
              )}
            </span>
            <span className="tg-execute-copy">
              <strong>
                {busy && engineMode === "trading"
                  ? "Sending…"
                  : !connected
                    ? "Connect MT5"
                    : "Execute"}
              </strong>
              <em>
                {busy && engineMode === "trading"
                  ? "Opening trades…"
                  : "Manual execution only"}
              </em>
            </span>
          </button>

          {fills.length ? (
            <p className="tg-fills">
              {fills.filter((f) => f.ok !== false).length}/{fills.length} trades filled
            </p>
          ) : (
            <p className="tg-note">TP1 / TP2 / TP3 will be set after execution.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
