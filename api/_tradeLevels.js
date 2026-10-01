/**
 * Minimum stop / take-profit distance by instrument class.
 * Chart AI often returns SL/TP that are only a few points from entry; brokers
 * then reject or instantly stop-out the fill. These floors keep protective
 * levels safely away from the live price.
 */

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return null;
  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.\-]/g, "");
  // Number("") === 0 — that turned missing SL into price 0 and parked
  // gold stops at the max-distance cap (~75pts / far TPs).
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") {
    return null;
  }
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
 * Default SL distance when AI omits a stop — scalper-tight, not swing-wide.
 */
export function defaultStopDistance(symbol, entryPrice) {
  const core = symbolCoreName(symbol);
  const e = Math.abs(toFiniteNumber(entryPrice) || 0) || 1;
  const min = minStopDistance(symbol, e);

  // Gold M30 noise routinely swings ~10–14 pts — tighter defaults were SL spam.
  if (/^(XAU|GOLD)/.test(core)) return Math.max(min, Math.min(14, e * 0.0032)); // ~13
  if (/^(XAG|SILVER)/.test(core)) return Math.max(min, Math.min(0.25, e * 0.006));
  if (/^BTC/.test(core)) return Math.max(min, Math.min(400, e * 0.004));
  if (/^ETH/.test(core)) return Math.max(min, Math.min(40, e * 0.005));
  if (
    /^(US30|DJ30|DJIA|WS30|DOW|USA30|USWALLST30|NAS100|USTEC|NDX|US100|USATECH|TECH100|SPX|US500|SP500|DE30|DE40|GER40|GER30|GDAXI|DAX|UK100|FTSE|JP225|JPN225|NI225|NIKKEI|AUS200|AU200|ASX|FRA40|CAC|HK50|HSI)/.test(
      core
    )
  ) {
    return Math.max(min, Math.min(60, e * 0.0012));
  }
  if (/OIL|WTI|BRENT|^CL/.test(core)) return Math.max(min, Math.min(0.45, e * 0.006));
  if (/JPY$/.test(core)) return Math.max(min, Math.min(0.25, e * 0.0015));
  if (/^[A-Z]{6}$/.test(core) || /^(EUR|GBP|AUD|NZD|USD|CAD|CHF)/.test(core)) {
    return Math.max(min, Math.min(0.0025, e * 0.0015)); // ~25 pips
  }
  if (e >= 1000) return Math.max(min, Math.min(40, e * 0.0015));
  if (e >= 100) return Math.max(min, Math.min(4, e * 0.004));
  if (e >= 10) return Math.max(min, Math.min(0.35, e * 0.006));
  return Math.max(min, Math.min(0.0025, e * 0.0025));
}

/**
 * Cap how far SL can sit from entry. Blocks wrong-scale AI stops that made
 * TP ≈ 5× price (20882 on gold), but stays scalper-tight so levels are not
 * parked 75+ points away on XAU.
 */
export function maxStopDistance(symbol, entryPrice) {
  const core = symbolCoreName(symbol);
  const e = Math.abs(toFiniteNumber(entryPrice) || 0) || 1;
  const min = minStopDistance(symbol, e);
  const def = defaultStopDistance(symbol, e);

  if (/^(XAU|GOLD)/.test(core)) return Math.max(def, Math.min(22, e * 0.005)); // ~20–22
  if (/^(XAG|SILVER)/.test(core)) return Math.max(def, Math.min(0.6, e * 0.012));
  if (/^BTC/.test(core)) return Math.max(def, Math.min(900, e * 0.01));
  if (/^ETH/.test(core)) return Math.max(def, Math.min(90, e * 0.012));
  if (
    /^(US30|DJ30|DJIA|WS30|DOW|USA30|USWALLST30|NAS100|USTEC|NDX|US100|USATECH|TECH100|SPX|US500|SP500|DE30|DE40|GER40|GER30|GDAXI|DAX|UK100|FTSE|JP225|JPN225|NI225|NIKKEI|AUS200|AU200|ASX|FRA40|CAC|HK50|HSI)/.test(
      core
    )
  ) {
    return Math.max(def, Math.min(120, e * 0.003));
  }
  if (/OIL|WTI|BRENT|^CL/.test(core)) return Math.max(def, Math.min(1.2, e * 0.015));
  if (/JPY$/.test(core)) return Math.max(def, Math.min(0.55, e * 0.0035));
  if (/^[A-Z]{6}$/.test(core) || /^(EUR|GBP|AUD|NZD|USD|CAD|CHF)/.test(core)) {
    return Math.max(def, Math.min(0.006, e * 0.004)); // ~60 pips
  }
  if (e >= 1000) return Math.max(def, Math.min(80, e * 0.004));
  if (e >= 100) return Math.max(def, Math.min(8, e * 0.01));
  if (e >= 10) return Math.max(def, Math.min(0.8, e * 0.015));
  return Math.max(def, Math.min(0.006, e * 0.006));
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
export function tpRewardMultiples(timeframe, overrides = null) {
  if (Array.isArray(overrides) && overrides.length >= 3) {
    return overrides.slice(0, 3).map((n) => Math.max(0.1, Number(n) || 1));
  }
  return isH4Timeframe(timeframe) ? [1, 2, 3] : [2, 3, 4];
}

export function tpRiskRewardLabel(timeframe, overrides = null) {
  const [a, b, c] = tpRewardMultiples(timeframe, overrides);
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
  const defDist =
    entry != null
      ? Math.max(defaultStopDistance(symbol, entry), minDist)
      : 0;

  if (entry != null && entry > 0 && minDist > 0) {
    // Always attach a protective SL when we know the fill — missing SL left
    // positions naked when AI omitted stopLoss or broker dropped a bad one.
    // Use scalper default distance (not the wide max cap).
    if (ensureStop && (!(sl != null && sl > 0))) {
      sl = dir === "BUY" ? entry - defDist : entry + defDist;
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
  /** Optional explicit R:R ladder, e.g. [2,3,4] for START / scanner non-H4. */
  rewardMultiples = null,
} = {}) {
  const dir = normalizeTradeSide(side, { entry, stopLoss });
  let e = toFiniteNumber(entry);
  let sl = toFiniteNumber(stopLoss);
  if (e == null || e <= 0) e = 1;

  const minDist = minStopDistance(symbol, e);
  const maxDist = maxStopDistance(symbol, e);
  // Instrument-aware scalper default — never the old blunt "e>=1000 → 25" floor
  // that parked gold SL ~75pts away after the far-TP guard.
  const fallbackRisk = Math.max(minDist, defaultStopDistance(symbol, e));

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

  const [m1, m2, m3] = tpRewardMultiples(timeframe, rewardMultiples);
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
    riskReward: tpRiskRewardLabel(timeframe, rewardMultiples),
    tpMultiples: [m1, m2, m3],
  };
}
