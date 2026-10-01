/**
 * Minimum stop / take-profit distance by instrument class.
 * Chart AI often returns SL/TP that are only a few points from entry; brokers
 * then reject or instantly stop-out the fill. These floors keep protective
 * levels safely away from the live price.
 */

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize scanner/AI direction labels.
 * Prefer explicit BUY/SELL; also accept LONG/SHORT. When entry+SL are present,
 * trust stop geometry over a conflicting label (SL below entry = BUY) —
 * unless `trustSide` is set (live OrderSend must never flip Buy↔Sell).
 */
export function normalizeTradeSide(side, { entry, stopLoss, trustSide = false } = {}) {
  const raw = String(side || "")
    .trim()
    .toUpperCase();
  let dir = null;
  if (/^(SELL|SHORT|BEAR|PUT)$/.test(raw) || /\bSELL\b|\bSHORT\b/.test(raw)) {
    dir = "SELL";
  } else if (/^(BUY|LONG|BULL|CALL)$/.test(raw) || /\bBUY\b|\bLONG\b/.test(raw)) {
    dir = "BUY";
  }

  const e = toFiniteNumber(entry);
  const sl = toFiniteNumber(stopLoss);
  if (!trustSide && e != null && sl != null && e !== sl) {
    const fromLevels = sl < e ? "BUY" : "SELL";
    // Geometry wins when the text label conflicts or is missing.
    if (!dir || dir !== fromLevels) dir = fromLevels;
  }

  return dir === "SELL" ? "SELL" : "BUY";
}

export function symbolCoreName(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/CASH$/i, "")
    .replace(/\.(MIC|M|P|PRO|RAW|ECN|STD|CASH|SPOT|R|I|A|B|C)$/i, "")
    .replace(/([A-Z0-9])[MPABCRI]$/i, "$1")
    .split(".")[0];
}

/** Absolute price distance required between fill and SL/TP. */
export function minStopDistance(symbol, entryPrice) {
  const core = symbolCoreName(symbol);
  const e = Math.abs(toFiniteNumber(entryPrice) || 0) || 1;

  if (/^(XAU|GOLD)/.test(core)) return Math.max(3.0, e * 0.0008);
  if (/^(XAG|SILVER)/.test(core)) return Math.max(0.08, e * 0.0018);
  if (/^BTC/.test(core)) return Math.max(80, e * 0.002);
  if (/^ETH/.test(core)) return Math.max(8, e * 0.0025);
  if (
    /^(US30|DJ30|DJIA|WS30|DOW|USA30|USWALLST30|NAS100|USTEC|NDX|US100|USATECH|TECH100|SPX|US500|SP500|DE30|DE40|GER40|GER30|GDAXI|DAX|UK100|FTSE|JP225|JPN225|NI225|NIKKEI|AUS200|AU200|ASX|FRA40|CAC|HK50|HSI)/.test(
      core
    )
  ) {
    return Math.max(25, e * 0.0005);
  }
  if (/OIL|WTI|BRENT|^CL/.test(core)) return Math.max(0.25, e * 0.0025);
  if (/JPY$/.test(core)) return Math.max(0.15, e * 0.00012); // ~15 pips
  if (/^[A-Z]{6}$/.test(core) || /^(EUR|GBP|AUD|NZD|USD|CAD|CHF)/.test(core)) {
    return Math.max(0.0015, e * 0.00012); // ~15 pips on 5-digit FX
  }
  if (e >= 1000) return Math.max(20, e * 0.0005);
  if (e >= 100) return Math.max(2, e * 0.001);
  if (e >= 10) return Math.max(0.1, e * 0.0015);
  return Math.max(0.0015, e * 0.0015);
}

/**
 * Cap how far SL can sit from entry. Chart AI sometimes returns a near-zero
 * or wrong-scale stop (e.g. "30" as price on gold) which made risk ≈ entry and
 * TP land at ~5× the market (20882 on XAU ~4176).
 */
export function maxStopDistance(symbol, entryPrice) {
  const core = symbolCoreName(symbol);
  const e = Math.abs(toFiniteNumber(entryPrice) || 0) || 1;
  const min = minStopDistance(symbol, e);

  if (/^(XAU|GOLD)/.test(core)) return Math.max(min * 12, Math.min(120, e * 0.018));
  if (/^(XAG|SILVER)/.test(core)) return Math.max(min * 12, Math.min(2.5, e * 0.025));
  if (/^BTC/.test(core)) return Math.max(min * 10, Math.min(2500, e * 0.03));
  if (/^ETH/.test(core)) return Math.max(min * 10, Math.min(250, e * 0.03));
  if (
    /^(US30|DJ30|DJIA|WS30|DOW|USA30|USWALLST30|NAS100|USTEC|NDX|US100|USATECH|TECH100|SPX|US500|SP500|DE30|DE40|GER40|GER30|GDAXI|DAX|UK100|FTSE|JP225|JPN225|NI225|NIKKEI|AUS200|AU200|ASX|FRA40|CAC|HK50|HSI)/.test(
      core
    )
  ) {
    return Math.max(min * 12, Math.min(400, e * 0.012));
  }
  if (/OIL|WTI|BRENT|^CL/.test(core)) return Math.max(min * 12, Math.min(3, e * 0.03));
  if (/JPY$/.test(core)) return Math.max(min * 12, Math.min(1.5, e * 0.012));
  if (/^[A-Z]{6}$/.test(core) || /^(EUR|GBP|AUD|NZD|USD|CAD|CHF)/.test(core)) {
    return Math.max(min * 12, Math.min(0.02, e * 0.012));
  }
  if (e >= 1000) return Math.max(min * 12, Math.min(200, e * 0.015));
  if (e >= 100) return Math.max(min * 12, Math.min(15, e * 0.02));
  if (e >= 10) return Math.max(min * 12, Math.min(1.5, e * 0.025));
  return Math.max(min * 12, Math.min(0.02, e * 0.02));
}

export function formatTradePrice(value) {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  const abs = Math.abs(n);
  let digits = 5;
  if (abs >= 1000) digits = 2;
  else if (abs >= 100) digits = 3;
  else if (abs >= 10) digits = 4;
  return Number(n.toFixed(digits));
}

/**
 * Normalize chart timeframe labels (H4 / 4H / 240 → H4).
 */
export function normalizeChartTimeframe(raw) {
  const tf = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!tf) return "M15";
  if (/^(H4|4H|240M?|240)$/.test(tf)) return "H4";
  if (/^(H1|1H|60M?|60)$/.test(tf)) return "H1";
  if (/^(M15|15M|15)$/.test(tf)) return "M15";
  if (/^(M5|5M|5)$/.test(tf)) return "M5";
  if (/^(M1|1M|1)$/.test(tf)) return "M1";
  if (/^(M30|30M|30)$/.test(tf)) return "M30";
  if (/^(H2|2H|120)$/.test(tf)) return "H2";
  if (/^(D1|1D|DAILY)$/.test(tf)) return "D1";
  return tf;
}

/** H4 keeps the classic 1:1 ladder; every other TF starts at 1:2. */
export function isH4Timeframe(raw) {
  return normalizeChartTimeframe(raw) === "H4";
}

/** TP1/TP2/TP3 reward multiples of stop distance. */
export function tpRewardMultiples(timeframe) {
  return isH4Timeframe(timeframe) ? [1, 2, 3] : [2, 3, 4];
}

export function tpRiskRewardLabel(timeframe) {
  const [a, b, c] = tpRewardMultiples(timeframe);
  return `1:${a} · 1:${b} · 1:${c}`;
}

/**
 * Widen / re-anchor SL & TP so they cannot sit on top of the live fill.
 * Always trusts the requested trade side (Buy/Sell) — never flips direction
 * from SL geometry (that caused "Invalid stops" when price moved past chart SL).
 */
export function normalizeProtectiveLevels({
  symbol = "",
  side = "BUY",
  entryPrice,
  stopLoss,
  takeProfit,
  ensureStop = true,
} = {}) {
  const dir = normalizeTradeSide(side, { trustSide: true });
  const entry = toFiniteNumber(entryPrice);
  let sl = toFiniteNumber(stopLoss);
  let tp = toFiniteNumber(takeProfit);
  let widened = false;
  // Extra buffer vs chart min — brokers reject stops inside freeze/stops level.
  const minDist =
    entry != null
      ? Math.max(minStopDistance(symbol, entry) * 1.35, minStopDistance(symbol, entry))
      : 0;
  const maxDist =
    entry != null ? Math.max(maxStopDistance(symbol, entry), minDist) : 0;

  if (entry != null && entry > 0 && minDist > 0) {
    // Always attach a protective SL when we know the fill — missing SL left
    // positions naked when AI omitted stopLoss or broker dropped a bad one.
    if (ensureStop && (!(sl != null && sl > 0))) {
      sl = dir === "BUY" ? entry - minDist : entry + minDist;
      widened = true;
    }

    if (sl != null && sl > 0) {
      if (dir === "BUY") {
        if (!(sl <= entry - minDist)) {
          sl = entry - minDist;
          widened = true;
        } else if (entry - sl > maxDist) {
          sl = entry - maxDist;
          widened = true;
        }
      } else if (!(sl >= entry + minDist)) {
        sl = entry + minDist;
        widened = true;
      } else if (sl - entry > maxDist) {
        sl = entry + maxDist;
        widened = true;
      }
    }

    if (tp != null && tp > 0) {
      // Cap absurd TPs (e.g. 20882 on gold) to at most 4R of the max stop.
      const maxTpDist = maxDist * 4;
      if (dir === "BUY") {
        if (!(tp >= entry + minDist)) {
          tp = entry + minDist;
          widened = true;
        } else if (tp - entry > maxTpDist) {
          tp = entry + maxTpDist;
          widened = true;
        }
      } else if (!(tp <= entry - minDist)) {
        tp = entry - minDist;
        widened = true;
      } else if (entry - tp > maxTpDist) {
        tp = entry - maxTpDist;
        widened = true;
      }
    }
  }

  return {
    side: dir,
    entry: entry != null ? formatTradePrice(entry) : null,
    stopLoss: sl != null && sl > 0 ? formatTradePrice(sl) : null,
    takeProfit: tp != null && tp > 0 ? formatTradePrice(tp) : null,
    minDist,
    maxDist,
    widened,
  };
}

/**
 * Build Entry / SL / TP1–TP3 with a class-aware minimum risk distance.
 * Tight AI stops are widened before R:R targets are computed.
 * H4 → 1:1 / 1:2 / 1:3 · all other timeframes → 1:2 / 1:3 / 1:4.
 */
export function buildSafeMultiTpLevels({
  symbol = "",
  side = "BUY",
  entry,
  stopLoss,
  timeframe = "M15",
} = {}) {
  const dir = normalizeTradeSide(side, { entry, stopLoss });
  let e = toFiniteNumber(entry);
  let sl = toFiniteNumber(stopLoss);
  if (e == null || e <= 0) e = 1;

  const minDist = minStopDistance(symbol, e);
  const maxDist = maxStopDistance(symbol, e);
  const fallbackRisk = Math.max(
    minDist,
    Math.abs(e) * 0.0025,
    e >= 1000 ? 25 : e >= 100 ? 2 : e >= 10 ? 0.1 : 0.0015
  );

  if (dir === "BUY") {
    if (sl == null || !(sl < e)) sl = e - fallbackRisk;
  } else if (sl == null || !(sl > e)) {
    sl = e + fallbackRisk;
  }

  let risk = Math.abs(e - sl);
  if (risk < minDist) {
    risk = minDist;
    sl = dir === "BUY" ? e - risk : e + risk;
  } else if (risk > maxDist) {
    // Wrong-scale AI stops (price "30" on gold, etc.) → pull SL in before R:R.
    risk = maxDist;
    sl = dir === "BUY" ? e - risk : e + risk;
  }

  const [m1, m2, m3] = tpRewardMultiples(timeframe);
  const tp1 = dir === "BUY" ? e + risk * m1 : e - risk * m1;
  const tp2 = dir === "BUY" ? e + risk * m2 : e - risk * m2;
  const tp3 = dir === "BUY" ? e + risk * m3 : e - risk * m3;

  // Re-run through protective normalizer so rounding cannot collapse levels.
  const safeSl = normalizeProtectiveLevels({
    symbol,
    side: dir,
    entryPrice: e,
    stopLoss: sl,
    takeProfit: tp1,
  });

  const finalEntry = safeSl.entry ?? formatTradePrice(e);
  const finalSl = safeSl.stopLoss ?? formatTradePrice(sl);
  const finalRisk = Math.abs((finalEntry || e) - (finalSl || sl));
  const safeRisk = Math.min(Math.max(finalRisk, minDist), maxDist);

  return {
    side: dir,
    entry: finalEntry,
    stopLoss: finalSl,
    takeProfit1: formatTradePrice(
      dir === "BUY" ? finalEntry + safeRisk * m1 : finalEntry - safeRisk * m1
    ),
    takeProfit2: formatTradePrice(
      dir === "BUY" ? finalEntry + safeRisk * m2 : finalEntry - safeRisk * m2
    ),
    takeProfit3: formatTradePrice(
      dir === "BUY" ? finalEntry + safeRisk * m3 : finalEntry - safeRisk * m3
    ),
    takeProfit: formatTradePrice(
      dir === "BUY" ? finalEntry + safeRisk * m3 : finalEntry - safeRisk * m3
    ),
    minDist,
    widened: safeSl.widened || risk < minDist + 1e-12,
    riskReward: tpRiskRewardLabel(timeframe),
    tpMultiples: [m1, m2, m3],
  };
}
