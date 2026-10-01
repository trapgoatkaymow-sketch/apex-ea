import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "./apiOrigin.js";
import { getPriceHistory, getSymbolQuote } from "./metaApi.js";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";
import { normalizeLicenseKey } from "./licensesApi.js";
import {
  inferSafeScalperSideFromBars,
  START_SCANNER_TIMEFRAMES,
  START_TP_REWARD_MULTIPLES,
} from "./silentStartOpen.js";
import { useApp } from "./store.jsx";
import {
  buildSafeMultiTpLevels,
  defaultStopDistance,
} from "./tradeLevels.js";
import { clampTradeThreadCount } from "./tradeManagement.js";

const TIMEFRAMES = [
  { id: "M1", minutes: 1 },
  { id: "M15", minutes: 15 },
  { id: "M30", minutes: 30 },
  { id: "H1", minutes: 60 },
  { id: "H4", minutes: 240 },
];
const CHART_TYPES = ["Candle", "Line", "Area"];

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatPrice(value, symbol = "") {
  const n = toNum(value);
  if (n == null) return "—";
  const core = String(symbol || "").toUpperCase();
  const digits = /XAU|GOLD|NAS|US30|SPX|US500|BTC/i.test(core)
    ? 2
    : /JPY/i.test(core)
      ? 3
      : 5;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  });
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function normalizeBars(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const open = toNum(row?.open ?? row?.openPrice);
      const high = toNum(row?.high ?? row?.highPrice);
      const low = toNum(row?.low ?? row?.lowPrice);
      const close = toNum(row?.close ?? row?.closePrice);
      if ([open, high, low, close].some((n) => n == null || n <= 0)) return null;
      return { open, high, low, close, time: row?.time || null };
    })
    .filter(Boolean);
}

function clampLot(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  return Number(Math.min(1000, n).toFixed(4));
}

/** Mentor portal pairs for this EA — never a hardcoded global catalog. */
function resolveMentorPairs({
  activeBot,
  eas = [],
  licenseKeys = [],
  normalizeSymbol,
} = {}) {
  const botId = String(activeBot?.id || "").trim();
  const cover = normalizeLicenseKey(activeBot?.licenseKey);
  const fromStamp = Array.isArray(activeBot?.mentorSymbols)
    ? activeBot.mentorSymbols
    : [];

  let fromLicense = [];
  const rows = (Array.isArray(licenseKeys) ? licenseKeys : []).filter(
    (row) => String(row?.botId || row?.bot?.id || "").trim() === botId
  );
  const mine =
    (cover && rows.find((row) => normalizeLicenseKey(row?.key) === cover)) ||
    null;
  if (mine && Array.isArray(mine?.bot?.symbols) && mine.bot.symbols.length) {
    fromLicense = mine.bot.symbols;
  } else {
    const ranked = [...rows].sort((a, b) => {
      const aSync = Number(a?.mentorSymbolsSyncedAt) || 0;
      const bSync = Number(b?.mentorSymbolsSyncedAt) || 0;
      if (aSync !== bSync) return bSync - aSync;
      return (
        Number(b?.updatedAt || b?.createdAt || 0) -
        Number(a?.updatedAt || a?.createdAt || 0)
      );
    });
    const best = ranked.find(
      (row) => Array.isArray(row?.bot?.symbols) && row.bot.symbols.length
    );
    fromLicense = best?.bot?.symbols || [];
  }

  const ea = (Array.isArray(eas) ? eas : []).find(
    (item) => String(item?.id || "").trim() === botId
  );
  const fromEa = Array.isArray(ea?.symbols) ? ea.symbols : [];
  const fromBot = Array.isArray(activeBot?.symbols) ? activeBot.symbols : [];

  let raw = fromStamp;
  if (
    fromLicense.length &&
    (!fromStamp.length ||
      (fromStamp.length > fromLicense.length && fromLicense.length <= 40))
  ) {
    raw = fromLicense;
  }
  if (!raw.length) raw = fromLicense;
  if (!raw.length) raw = fromEa;
  if (!raw.length) raw = fromBot;

  const out = [];
  const seen = new Set();
  for (const rawSym of raw) {
    const clean =
      normalizeSymbol?.(rawSym) ||
      normalizeBrokerSymbol(rawSym) ||
      String(rawSym || "").trim().toUpperCase();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export default function LiveChartView({ active = true } = {}) {
  const {
    mt5Session,
    showToast,
    setV2View,
    activeBot,
    eas = [],
    licenseKeys = [],
    normalizeSymbol,
    getSymbolMeta,
    saveSymbolMeta,
  } = useApp();
  const accountId = String(mt5Session?.accountId || "").trim();
  const connected = Boolean(accountId);
  const tradeSymbolRef = useRef("");

  const symbols = useMemo(
    () =>
      resolveMentorPairs({
        activeBot,
        eas,
        licenseKeys,
        normalizeSymbol,
      }),
    [activeBot, eas, licenseKeys, normalizeSymbol]
  );

  const [symbol, setSymbol] = useState(symbols[0] || "");
  const [tfId, setTfId] = useState("M30");
  const [chartType, setChartType] = useState("Candle");
  const [bars, setBars] = useState([]);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [visibleCount, setVisibleCount] = useState(70);
  const [pan, setPan] = useState(0);
  const [showMa, setShowMa] = useState(true);
  const [lotSize, setLotSize] = useState(() => {
    const meta = getSymbolMeta?.(symbols[0] || "") || {};
    return clampLot(meta.lotSize);
  });
  const [tradeCount, setTradeCount] = useState(() => {
    const meta = getSymbolMeta?.(symbols[0] || "") || {};
    return clampTradeThreadCount(meta.trades || 3);
  });
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState(null);

  useEffect(() => {
    if (!symbols.length) {
      if (symbol) setSymbol("");
      return;
    }
    if (!symbols.includes(symbol)) setSymbol(symbols[0]);
  }, [symbols, symbol]);

  useEffect(() => {
    if (!symbol) return;
    const meta = getSymbolMeta?.(symbol) || {};
    setLotSize(clampLot(meta.lotSize));
    setTradeCount(clampTradeThreadCount(meta.trades || 3));
    setPan(0);
    setAnalysis(null);
  }, [symbol, getSymbolMeta]);

  function persistTradeSettings(nextLot = lotSize, nextTrades = tradeCount) {
    if (!symbol) return;
    const lot = clampLot(nextLot);
    const trades = clampTradeThreadCount(nextTrades);
    setLotSize(lot);
    setTradeCount(trades);
    saveSymbolMeta?.(symbol, {
      ...(getSymbolMeta?.(symbol) || {}),
      lotSize: lot,
      trades,
    });
  }

  const tfMinutes =
    TIMEFRAMES.find((t) => t.id === tfId)?.minutes || 30;

  useEffect(() => {
    if (!active || !connected || !symbol) return undefined;
    let cancelled = false;

    async function load({ quiet = false } = {}) {
      if (!quiet) setBusy(true);
      setError("");
      try {
        const [hist, q] = await Promise.all([
          getPriceHistory({
            accountId,
            symbol,
            timeFrame: tfMinutes,
            days: 14,
            fast: true,
          }),
          getSymbolQuote({
            accountId,
            symbol,
            side: "BUY",
            fast: true,
          }).catch(() => null),
        ]);
        if (cancelled) return;
        const nextBars = normalizeBars(hist?.bars);
        setBars(nextBars);
        if (hist?.symbol) {
          const resolved = normalizeBrokerSymbol(hist.symbol) || hist.symbol;
          tradeSymbolRef.current = resolved || symbol;
        } else {
          tradeSymbolRef.current = symbol;
        }
        setQuote(q);
        if (!nextBars.length) {
          setError("No bars from this MetaTrader account yet — try another TF");
        }
      } catch (err) {
        if (cancelled) return;
        setBars([]);
        setError(err?.message || "Could not load chart from connected account");
      } finally {
        if (!cancelled && !quiet) setBusy(false);
      }
    }

    load({ quiet: false });
    const id = setInterval(() => load({ quiet: true }), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, connected, accountId, symbol, tfMinutes]);

  const closes = bars.map((b) => b.close);
  const ma = useMemo(() => sma(closes, 14), [closes]);
  const rsiVals = useMemo(() => rsi(closes, 14), [closes]);

  const windowBars = useMemo(() => {
    if (!bars.length) return [];
    const count = Math.max(20, Math.min(120, visibleCount));
    const maxPan = Math.max(0, bars.length - count);
    const offset = Math.max(0, Math.min(maxPan, pan));
    const start = Math.max(0, bars.length - count - offset);
    return bars.slice(start, start + count);
  }, [bars, visibleCount, pan]);

  const windowMa = useMemo(() => {
    if (!bars.length || !windowBars.length) return [];
    const count = windowBars.length;
    const maxPan = Math.max(0, bars.length - count);
    const offset = Math.max(0, Math.min(maxPan, pan));
    const start = Math.max(0, bars.length - count - offset);
    return ma.slice(start, start + count);
  }, [bars, windowBars, ma, pan]);

  const windowRsi = useMemo(() => {
    if (!bars.length || !windowBars.length) return [];
    const count = windowBars.length;
    const maxPan = Math.max(0, bars.length - count);
    const offset = Math.max(0, Math.min(maxPan, pan));
    const start = Math.max(0, bars.length - count - offset);
    return rsiVals.slice(start, start + count);
  }, [bars, windowBars, rsiVals, pan]);

  const last = bars[bars.length - 1] || null;
  const livePrice = toNum(quote?.price) ?? last?.close ?? null;
  const open = last?.open ?? livePrice;
  const high = last?.high ?? livePrice;
  const low = last?.low ?? livePrice;
  const close = last?.close ?? livePrice;
  const changePct =
    open && close ? ((close - open) / open) * 100 : null;

  const chartGeom = useMemo(() => {
    if (!windowBars.length) return null;
    const padX = 8;
    // Wider canvas reads better on laptop; SVG scales to the card width.
    const w = 640;
    const priceH = 220;
    const rsiH = 72;
    const gap = 10;
    const highs = windowBars.map((b) => b.high);
    const lows = windowBars.map((b) => b.low);
    const min = Math.min(...lows);
    const max = Math.max(...highs);
    const span = Math.max(1e-8, max - min);
    const n = windowBars.length;
    const slot = (w - padX * 2) / Math.max(1, n);
    const yPrice = (p) => 8 + ((max - p) / span) * (priceH - 16);
    const xAt = (i) => padX + slot * i + slot / 2;
    return { w, priceH, rsiH, gap, slot, yPrice, xAt, min, max, totalH: priceH + gap + rsiH };
  }, [windowBars]);

  async function handleAnalyze() {
    const tradeSymbol =
      normalizeBrokerSymbol(tradeSymbolRef.current || symbol) || symbol;
    const entry = toNum(quote?.price) ?? last?.close;
    if (!connected) {
      showToast?.("Connect MetaTrader to analyze the live market");
      setV2View("metatrader");
      return;
    }
    if (entry == null || entry <= 0) {
      showToast?.("Wait for a live price, then analyze again");
      return;
    }

    setAnalyzing(true);
    setAnalysis(null);
    try {
      let side = "";
      let stopLoss = null;
      let confidence = 62;
      let note = "";
      let timeframe = tfId;
      let source = "openai-symbol";

      try {
        const response = await fetch(apiUrl("/api/chart/analyze-symbol"), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            symbol: tradeSymbol,
            price: entry,
            timeframes: START_SCANNER_TIMEFRAMES,
          }),
          cache: "no-store",
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(data?.error || data?.message || "Analyze failed");
        }
        side =
          String(data?.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
        stopLoss = toNum(data?.stopLoss);
        confidence = Math.max(
          55,
          Math.min(95, Math.round(Number(data?.confidence) || 70))
        );
        note = String(data?.analysis || "").trim();
        timeframe = String(data?.timeframe || tfId).toUpperCase();
        source = data?.source || "openai-symbol";
      } catch {
        // Offline / OpenAI down — M30 EMA bias from connected-account bars.
        side = inferSafeScalperSideFromBars(bars) || "";
        if (!side) {
          throw new Error(
            "No clear M30/H1/H4 direction right now — try again shortly"
          );
        }
        const risk = defaultStopDistance(tradeSymbol, entry);
        stopLoss = side === "BUY" ? entry - risk : entry + risk;
        note = `Safe Scalper bias from connected ${tradeSymbol} bars (${side}).`;
        timeframe = "M30";
        source = "safe-scalper";
        confidence = 60;
      }

      const levels = buildSafeMultiTpLevels({
        symbol: tradeSymbol,
        side,
        entry,
        stopLoss,
        timeframe: timeframe === "H4" ? "H4" : "M30",
        rewardMultiples: START_TP_REWARD_MULTIPLES,
        trustSide: true,
      });

      const next = {
        symbol: tradeSymbol,
        side: levels.side,
        entry: levels.entry,
        stopLoss: levels.stopLoss,
        takeProfit1: levels.takeProfit1,
        takeProfit2: levels.takeProfit2,
        takeProfit3: levels.takeProfit3,
        confidence,
        timeframe,
        analysis: note || `${levels.side} ${tradeSymbol}`,
        source,
        at: Date.now(),
      };
      setAnalysis(next);
      showToast?.(
        `${next.side} ${tradeSymbol} · ${next.confidence}% · ${next.timeframe}`
      );
    } catch (err) {
      showToast?.(err?.message || "Market analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  function refresh() {
    if (!connected) {
      showToast?.("Connect MetaTrader to load the live chart");
      setV2View("metatrader");
      return;
    }
    setBusy(true);
    getPriceHistory({
      accountId,
      symbol,
      timeFrame: tfMinutes,
      days: 14,
      fast: false,
    })
      .then((hist) => {
        setBars(normalizeBars(hist?.bars));
        if (hist?.symbol) {
          tradeSymbolRef.current =
            normalizeBrokerSymbol(hist.symbol) || hist.symbol;
        }
        setError("");
      })
      .catch((err) => setError(err?.message || "Refresh failed"))
      .finally(() => setBusy(false));
  }

  return (
    <section className="lc-view" aria-label="Live Chart">
      <header className="lc-header">
        <div className="lc-header-left">
          <button
            type="button"
            className="lc-icon-btn"
            aria-label="Close live chart"
            onClick={() => setV2View("home")}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
          <span className="lc-title-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
              <path d="M5 18V9h2.2v9H5zm5.9 0V6h2.2v12h-2.2zM16.8 18v-7H19v7h-2.2z" />
            </svg>
          </span>
          <h1 className="lc-title">Live Chart</h1>
        </div>
        <div className="lc-header-right">
          <span className="lc-sym-tf">
            {symbol} · {tfId}
          </span>
          <span className={`lc-live-badge${connected ? " is-on" : ""}`}>
            <i /> {connected ? "Live" : "Offline"}
          </span>
        </div>
      </header>

      <div className="lc-price-row">
        <div className="lc-last">
          <strong>{formatPrice(livePrice, symbol)}</strong>
          {changePct != null && (
            <span className={changePct >= 0 ? "is-up" : "is-down"}>
              {changePct >= 0 ? "+" : ""}
              {changePct.toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      <div className="lc-ohlc">
        <div>
          <span>O</span>
          <b>{formatPrice(open, symbol)}</b>
        </div>
        <div>
          <span>H</span>
          <b>{formatPrice(high, symbol)}</b>
        </div>
        <div>
          <span>L</span>
          <b>{formatPrice(low, symbol)}</b>
        </div>
        <div>
          <span>C</span>
          <b>{formatPrice(close, symbol)}</b>
        </div>
      </div>

      <div className="lc-symbols" role="tablist" aria-label="Mentor pairs">
        {symbols.length ? (
          symbols.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={s === symbol}
              className={s === symbol ? "is-active" : ""}
              onClick={() => setSymbol(s)}
            >
              {s}
            </button>
          ))
        ) : (
          <p className="lc-symbols-empty">
            No mentor pairs yet — your mentor adds them in the portal.
          </p>
        )}
      </div>

      <div className="lc-chart-card">
        <div className="lc-chart-tools">
          <button
            type="button"
            className={`lc-pill${showMa ? " is-active" : ""}`}
            onClick={() => setShowMa((v) => !v)}
          >
            Indicators
          </button>
          <button type="button" className="lc-icon-btn" aria-label="Refresh" onClick={refresh}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M19.5 12a7.5 7.5 0 1 1-2.1-5.2" strokeLinecap="round" />
              <path d="M19.5 5v4.2H15" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {!connected ? (
          <div className="lc-empty">
            <p>Connect MetaTrader to stream a live chart.</p>
            <button type="button" className="lc-connect" onClick={() => setV2View("metatrader")}>
              Open MetaTrader
            </button>
          </div>
        ) : error && !windowBars.length ? (
          <div className="lc-empty">
            <p>{error}</p>
            <button type="button" className="lc-connect" onClick={refresh}>
              Retry
            </button>
          </div>
        ) : !chartGeom ? (
          <div className="lc-empty">
            <p>{busy ? "Loading chart…" : "No bars yet for this symbol."}</p>
          </div>
        ) : (
          <svg
            className="lc-svg"
            viewBox={`0 0 ${chartGeom.w} ${chartGeom.totalH}`}
            role="img"
            aria-label={`${symbol} ${tfId} chart`}
          >
            <rect
              x="0"
              y="0"
              width={chartGeom.w}
              height={chartGeom.priceH}
              rx="10"
              fill="rgba(0,0,0,0.45)"
            />
            {chartType === "Candle" &&
              windowBars.map((b, i) => {
                const x = chartGeom.xAt(i);
                const yO = chartGeom.yPrice(b.open);
                const yC = chartGeom.yPrice(b.close);
                const yH = chartGeom.yPrice(b.high);
                const yL = chartGeom.yPrice(b.low);
                const up = b.close >= b.open;
                const bodyTop = Math.min(yO, yC);
                const bodyH = Math.max(1.2, Math.abs(yC - yO));
                const color = up ? "#22c55e" : "#ef4444";
                const cw = Math.max(2.2, chartGeom.slot * 0.55);
                return (
                  <g key={`c-${i}`}>
                    <line x1={x} y1={yH} x2={x} y2={yL} stroke={color} strokeWidth="1" />
                    <rect
                      x={x - cw / 2}
                      y={bodyTop}
                      width={cw}
                      height={bodyH}
                      fill={color}
                      rx="0.6"
                    />
                  </g>
                );
              })}
            {(chartType === "Line" || chartType === "Area") && windowBars.length > 1 && (
              <>
                {chartType === "Area" && (
                  <path
                    d={
                      windowBars
                        .map((b, i) => `${i === 0 ? "M" : "L"}${chartGeom.xAt(i)},${chartGeom.yPrice(b.close)}`)
                        .join(" ") +
                      ` L${chartGeom.xAt(windowBars.length - 1)},${chartGeom.priceH - 4}` +
                      ` L${chartGeom.xAt(0)},${chartGeom.priceH - 4} Z`
                    }
                    fill="rgba(34,211,238,0.18)"
                  />
                )}
                <path
                  d={windowBars
                    .map((b, i) => `${i === 0 ? "M" : "L"}${chartGeom.xAt(i)},${chartGeom.yPrice(b.close)}`)
                    .join(" ")}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="1.6"
                />
              </>
            )}
            {showMa && (() => {
              const pts = [];
              windowMa.forEach((v, i) => {
                if (v == null) return;
                pts.push(`${pts.length ? "L" : "M"}${chartGeom.xAt(i)},${chartGeom.yPrice(v)}`);
              });
              if (!pts.length) return null;
              return (
                <path
                  d={pts.join(" ")}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="1.3"
                  opacity="0.9"
                />
              );
            })()}
            {livePrice != null && (
              <line
                x1="4"
                x2={chartGeom.w - 4}
                y1={chartGeom.yPrice(livePrice)}
                y2={chartGeom.yPrice(livePrice)}
                stroke="#4ade80"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
            )}

            <rect
              x="0"
              y={chartGeom.priceH + chartGeom.gap}
              width={chartGeom.w}
              height={chartGeom.rsiH}
              rx="8"
              fill="rgba(0,0,0,0.35)"
            />
            <text
              x="8"
              y={chartGeom.priceH + chartGeom.gap + 12}
              fill="rgba(196,181,253,0.9)"
              fontSize="8"
            >
              RSI 14
            </text>
            {[30, 50, 70].map((lvl) => {
              const y =
                chartGeom.priceH +
                chartGeom.gap +
                16 +
                ((100 - lvl) / 100) * (chartGeom.rsiH - 22);
              return (
                <line
                  key={lvl}
                  x1="6"
                  x2={chartGeom.w - 6}
                  y1={y}
                  y2={y}
                  stroke="rgba(255,255,255,0.08)"
                  strokeWidth="1"
                />
              );
            })}
            {(() => {
              const pts = [];
              windowRsi.forEach((v, i) => {
                if (v == null) return;
                const y =
                  chartGeom.priceH +
                  chartGeom.gap +
                  16 +
                  ((100 - v) / 100) * (chartGeom.rsiH - 22);
                pts.push(`${pts.length ? "L" : "M"}${chartGeom.xAt(i)},${y}`);
              });
              if (!pts.length) return null;
              return (
                <path
                  d={pts.join(" ")}
                  fill="none"
                  stroke="#c4b5fd"
                  strokeWidth="1.4"
                />
              );
            })()}
          </svg>
        )}

        <div className="lc-pan">
          <button
            type="button"
            aria-label="Fewer bars"
            onClick={() => setVisibleCount((n) => Math.max(20, n - 10))}
          >
            −
          </button>
          <span>
            {windowBars.length || visibleCount} bars · drag offset {pan}
          </span>
          <button
            type="button"
            aria-label="More bars"
            onClick={() => setVisibleCount((n) => Math.min(120, n + 10))}
          >
            +
          </button>
          <button
            type="button"
            className="lc-pan-shift"
            aria-label="Pan left"
            onClick={() => setPan((p) => p + 5)}
          >
            ‹
          </button>
          <button
            type="button"
            className="lc-pan-shift"
            aria-label="Pan right"
            onClick={() => setPan((p) => Math.max(0, p - 5))}
          >
            ›
          </button>
        </div>
      </div>

      <div className="lc-tfs" role="tablist" aria-label="Timeframes">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.id}
            type="button"
            role="tab"
            aria-selected={tf.id === tfId}
            className={tf.id === tfId ? "is-active" : ""}
            onClick={() => setTfId(tf.id)}
          >
            {tf.id}
          </button>
        ))}
      </div>

      <div className="lc-types" role="tablist" aria-label="Chart type">
        {CHART_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === chartType}
            className={t === chartType ? "is-active" : ""}
            onClick={() => setChartType(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {analysis && (
        <div
          className={`lc-signal is-${String(analysis.side || "").toLowerCase()}`}
          role="status"
          aria-live="polite"
        >
          <div className="lc-signal-top">
            <strong>{analysis.side}</strong>
            <span>
              {analysis.confidence}% · {analysis.timeframe}
            </span>
          </div>
          <p>{analysis.analysis}</p>
          <div className="lc-signal-levels">
            <span>SL {formatPrice(analysis.stopLoss, analysis.symbol)}</span>
            <span>TP1 {formatPrice(analysis.takeProfit1, analysis.symbol)}</span>
            <span>TP2 {formatPrice(analysis.takeProfit2, analysis.symbol)}</span>
            <span>TP3 {formatPrice(analysis.takeProfit3, analysis.symbol)}</span>
          </div>
        </div>
      )}

      <div className="lc-trade-bar">
        <label className="lc-lot">
          <span>Lot</span>
          <input
            type="text"
            inputMode="decimal"
            value={lotSize}
            disabled={!symbol || analyzing}
            onChange={(e) =>
              setLotSize(e.target.value.replace(/[^\d.,]/g, ""))
            }
            onBlur={() => persistTradeSettings(lotSize, tradeCount)}
          />
        </label>
        <label className="lc-lot">
          <span>Trades</span>
          <input
            type="number"
            min="1"
            max="100"
            value={tradeCount}
            disabled={!symbol || analyzing}
            onChange={(e) =>
              setTradeCount(clampTradeThreadCount(e.target.value))
            }
            onBlur={() => persistTradeSettings(lotSize, tradeCount)}
          />
        </label>
      </div>

      <button
        type="button"
        className="lc-analyze"
        onClick={handleAnalyze}
        disabled={analyzing || !connected || !symbol}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7z" />
        </svg>
        {analyzing ? "Analysing market…" : "Analyze Market"}
      </button>
      {!symbols.length ? (
        <p className="lc-hint">
          Live Chart lists only pairs your mentor added for this EA in the portal.
        </p>
      ) : null}
      {!connected && (
        <p className="lc-hint">
          Connect MetaTrader on this device — the chart uses that account.
        </p>
      )}
      {connected && error ? <p className="lc-hint is-err">{error}</p> : null}
    </section>
  );
}
