/**
 * Client-side mirror of api/_tradeLevels.js — keep floors in sync.
 * Used by chart scanner setup generation before Execute.
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
 * trust stop geometry over a conflicting label (SL below entry = BUY).
 */
export function normalizeTradeSide(side, { entry, stopLoss } = {}) {
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
  if (e != null && sl != null && e !== sl) {
    const fromLevels = sl < e ? "BUY" : "SELL";
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

export function minStopDistance(symbol, entryPrice) {
  const core = symbolCoreName(symbol);
  const e = Math.abs(toFiniteNumber(entryPrice) || 0) || 1;

  if (/^(XAU|GOLD)/.test(core)) return Math.max(1.5, e * 0.0006);
  if (/^(XAG|SILVER)/.test(core)) return Math.max(0.05, e * 0.0015);
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
  if (/JPY$/.test(core)) return Math.max(0.15, e * 0.00012);
  if (/^[A-Z]{6}$/.test(core) || /^(EUR|GBP|AUD|NZD|USD|CAD|CHF)/.test(core)) {
    return Math.max(0.0015, e * 0.00012);
  }
  if (e >= 1000) return Math.max(20, e * 0.0005);
  if (e >= 100) return Math.max(2, e * 0.001);
  if (e >= 10) return Math.max(0.1, e * 0.0015);
  return Math.max(0.0015, e * 0.0015);
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

export function buildSafeMultiTpLevels({
  symbol = "",
  side = "BUY",
  entry,
  stopLoss,
} = {}) {
  const dir = normalizeTradeSide(side, { entry, stopLoss });
  let e = toFiniteNumber(entry);
  let sl = toFiniteNumber(stopLoss);
  if (e == null || e <= 0) e = 1;

  const minDist = minStopDistance(symbol, e);
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
  }

  const entryOut = formatTradePrice(e);
  const slOut = formatTradePrice(sl);
  const safeRisk = Math.max(Math.abs(entryOut - slOut), minDist);

  return {
    side: dir,
    entry: entryOut,
    stopLoss: formatTradePrice(dir === "BUY" ? entryOut - safeRisk : entryOut + safeRisk),
    takeProfit1: formatTradePrice(
      dir === "BUY" ? entryOut + safeRisk * 1 : entryOut - safeRisk * 1
    ),
    takeProfit2: formatTradePrice(
      dir === "BUY" ? entryOut + safeRisk * 2 : entryOut - safeRisk * 2
    ),
    takeProfit3: formatTradePrice(
      dir === "BUY" ? entryOut + safeRisk * 3 : entryOut - safeRisk * 3
    ),
    takeProfit: formatTradePrice(
      dir === "BUY" ? entryOut + safeRisk * 3 : entryOut - safeRisk * 3
    ),
    minDist,
    widened: risk < minDist + 1e-12,
  };
}
