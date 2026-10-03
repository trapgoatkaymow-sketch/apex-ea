/**
 * Chart Scanner direction from live OHLC (and screenshot colors as last resort).
 * Never default to BUY. START Safe Scalper stays in silentStartOpen.js.
 */

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return null;
  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function emaLast(values, period) {
  const nums = (values || []).filter((n) => Number.isFinite(n));
  if (!nums.length || period < 1) return null;
  const k = 2 / (period + 1);
  let ema = nums[0];
  for (let i = 1; i < nums.length; i += 1) {
    ema = nums[i] * k + ema * (1 - k);
  }
  return ema;
}

export function sortBarsOldestFirst(bars = []) {
  const rows = (Array.isArray(bars) ? bars : []).slice();
  const timeMs = (value) => {
    if (value == null || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : null;
  };
  rows.sort((a, b) => {
    const at = timeMs(a?.time ?? a?.Time ?? a?.date);
    const bt = timeMs(b?.time ?? b?.Time ?? b?.date);
    if (at == null && bt == null) return 0;
    if (at == null) return -1;
    if (bt == null) return 1;
    return at - bt;
  });
  return rows;
}

export function lastBarSide(bars = []) {
  const rows = sortBarsOldestFirst(bars);
  const last = rows[rows.length - 1];
  if (!last) return null;
  const open = toFiniteNumber(last.open ?? last.openPrice);
  const close = toFiniteNumber(last.close ?? last.closePrice);
  if (open == null || close == null || open === close) return null;
  return close > open ? "BUY" : "SELL";
}

/**
 * Scanner bias from one timeframe's candles.
 * Uses recent bodies + short momentum + EMA when there are enough bars.
 * Returns null side when the tape is mixed — never a soft BUY.
 */
export function inferScannerSideFromBars(bars = []) {
  const rows = sortBarsOldestFirst(bars);
  if (rows.length < 3) {
    return { side: null, strength: 0, source: "bars" };
  }

  const n = Math.min(12, rows.length);
  const recent = rows.slice(-n);
  let bull = 0;
  let bear = 0;
  for (let i = 0; i < recent.length; i += 1) {
    const o = toFiniteNumber(recent[i]?.open ?? recent[i]?.openPrice);
    const c = toFiniteNumber(recent[i]?.close ?? recent[i]?.closePrice);
    if (o == null || c == null || o === c) continue;
    const weight = 1 + (i / Math.max(1, recent.length - 1)) * 1.8;
    if (c > o) bull += weight;
    else bear += weight;
  }

  const closes = rows
    .map((b) => toFiniteNumber(b?.close ?? b?.closePrice))
    .filter((v) => v != null && v > 0);
  const last = closes[closes.length - 1];
  if (last != null && last > 0 && closes.length >= 4) {
    const lookback = closes[Math.max(0, closes.length - 6)];
    if (lookback != null && lookback > 0) {
      const move = (last - lookback) / lookback;
      if (move > 0.0012) bull += 1.4;
      else if (move < -0.0012) bear += 1.4;
    }
  }

  if (closes.length >= 12 && last != null && last > 0) {
    const emaFast = emaLast(closes, 9);
    const emaSlow = emaLast(closes, 21);
    if (emaFast != null && emaSlow != null) {
      const spread = Math.abs(emaFast - emaSlow) / last;
      if (spread > 0.0006) {
        if (emaFast > emaSlow && last >= emaFast) bull += 1.6;
        if (emaFast < emaSlow && last <= emaFast) bear += 1.6;
      }
    }
  }

  const total = bull + bear;
  if (total < 2) {
    return { side: null, strength: 0, source: "bars" };
  }
  const margin = Math.abs(bull - bear) / total;
  // Recency weights the last bar — need a real lean, not a range flicker.
  if (margin < 0.12) {
    return { side: null, strength: margin, source: "bars" };
  }
  return {
    side: bull > bear ? "BUY" : "SELL",
    strength: Math.min(1, margin),
    source: "bars",
  };
}

/**
 * Weighted BUY/SELL vote across timeframes.
 * `weight` should be higher on faster TFs so a live dump is not vetoed by lagging M30.
 */
export function voteScannerSides(reads = []) {
  let buy = 0;
  let sell = 0;
  let buyN = 0;
  let sellN = 0;
  const usable = [];
  for (const read of Array.isArray(reads) ? reads : []) {
    if (read?.side !== "BUY" && read?.side !== "SELL") continue;
    const weight = Number(read.weight) > 0 ? Number(read.weight) : 1;
    const strength = Math.max(0, Math.min(1, Number(read.strength) || 0));
    const score = weight * (0.45 + strength * 0.55);
    if (read.side === "BUY") {
      buy += score;
      buyN += 1;
    } else {
      sell += score;
      sellN += 1;
    }
    usable.push({ ...read, weight, strength, score });
  }

  const total = buyN + sellN;
  if (!total) {
    return {
      side: null,
      buyScore: 0,
      sellScore: 0,
      agree: 0,
      total: 0,
      tied: false,
    };
  }

  const gap = Math.abs(buy - sell);
  if (gap < 0.12 && buyN === sellN) {
    usable.sort((a, b) => b.weight - a.weight);
    const top = usable[0];
    return {
      side: top?.side || null,
      buyScore: buy,
      sellScore: sell,
      agree: 1,
      total,
      tied: true,
    };
  }

  const side = buy > sell ? "BUY" : "SELL";
  return {
    side,
    buyScore: buy,
    sellScore: sell,
    agree: side === "BUY" ? buyN : sellN,
    total,
    tied: false,
  };
}

/**
 * Honest scanner confidence from how hard the candles agree.
 * Never a hardcoded 72 just because a live quote exists.
 */
export function scannerConfidence({ vote = null, usedLiveBars = false, usedImage = false } = {}) {
  if (!vote?.side) return 0;
  const agree = Number(vote.agree) || 0;
  const total = Number(vote.total) || 0;
  let conf = 56;
  if (usedLiveBars && total >= 3 && agree >= 3) conf = 79;
  else if (usedLiveBars && total >= 2 && agree >= 2 && agree === total) conf = 73;
  else if (usedLiveBars && total >= 2 && agree >= 2) conf = 67;
  else if (usedLiveBars && agree === 1) conf = 61;
  else if (usedLiveBars) conf = 64;
  else if (usedImage) conf = 57;

  const margin = Math.abs((Number(vote.buyScore) || 0) - (Number(vote.sellScore) || 0));
  const bump = Math.round(Math.min(7, Math.max(0, margin) * 1.8));
  conf += bump;
  if (vote.tied) conf -= 7;
  return Math.max(56, Math.min(86, Math.round(conf)));
}

/** Light MT5 paper vs dark terminal — sampled from plot luminance. */
export function chartBackgroundIsLight(luminance) {
  return Number(luminance) > 145;
}

/**
 * Classify one pixel as candle body color.
 * Light charts: near-black bodies are bear candles (do not skip them as wallpaper).
 * Dark charts: skip near-black wallpaper. Blue only counts when saturated (not grid).
 */
export function classifyCandlePixel(r, g, b, a, { lightBackground = false } = {}) {
  if (a < 40) return null;
  if (r > 230 && g > 230 && b > 230) return null;
  if (!lightBackground && r < 28 && g < 28 && b < 28) return null;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max - min;

  if (lightBackground && max < 55 && sat < 28) return "bear";

  const isBull =
    (g > r + 16 && g > b + 8) ||
    (g > 140 && b > 140 && r < 110) ||
    (b > r + 22 && b > g + 10 && sat > 40 && b < 220);
  const isBear =
    (r > g + 16 && r > b + 8) || (r > 150 && b > 140 && g < 110);

  if (isBull && !isBear) return "bull";
  if (isBear && !isBull) return "bear";
  return null;
}

/** Need a real majority — a few leftover blue pixels must not become BUY. */
export function inferSideFromColorTally(bull = 0, bear = 0) {
  const total = Number(bull) + Number(bear);
  if (total < 8) return null;
  const lead = Math.max(bull, bear);
  if (lead / total < 0.58) return null;
  if (bull > bear) return "BUY";
  if (bear > bull) return "SELL";
  return null;
}

export function explicitTradeSide(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase();
  if (raw === "SELL" || raw === "SHORT") return "SELL";
  if (raw === "BUY" || raw === "LONG") return "BUY";
  return null;
}
