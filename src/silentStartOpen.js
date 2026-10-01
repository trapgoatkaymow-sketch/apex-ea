/**
 * Silent START → Chart Scanner style open (no scanner UI):
 *   15s “Opening positions” countdown → OpenAI scan (M30/H1/H4) → open
 *   Number of trades for every pair in Your pairs.
 *
 * START always uses the scanner non-H4 ladder:
 *   TP1 1:2 · TP2 1:3 · TP3 1:4
 *
 * When OpenAI is down / out of credits, START switches to the built-in
 * Safe Scalper strategy (not a blind BUY) so accounts are not blown.
 */
import { apiUrl } from "./apiOrigin.js";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";
import { recordTrade } from "./dailyTradeHistory.js";
import {
  buildScannerFillComment,
  getSymbolQuote,
  placeTrade,
} from "./metaApi.js";
import {
  buildSafeMultiTpLevels,
  defaultStopDistance,
  normalizeChartTimeframe,
  normalizeTradeSide,
  tpRiskRewardLabel,
} from "./tradeLevels.js";

/** Built-in START strategy when OpenAI credits/API fail. */
export const START_OFFLINE_STRATEGY = "safe-scalper";

/** Delay after START before the silent OpenAI scan + open runs. */
export const START_SILENT_OPEN_DELAY_MS = 15_000;

/** Scanner timeframes used by the START button (like EA Chart). */
export const START_SCANNER_TIMEFRAMES = ["M30", "H1", "H4"];

const TF_FOR_TP_SLOT = ["M30", "H1", "H4"];

/** Seconds left for the START “Opening positions” countdown. */
export function formatStartCountdownSeconds(ms) {
  return String(Math.max(0, Math.ceil(Number(ms) / 1000)));
}

/** @deprecated use formatStartCountdownSeconds — kept for older imports */
export function formatStartCountdown(ms) {
  return formatStartCountdownSeconds(ms);
}

function clampLot(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  return Number(Math.min(1000, n).toFixed(4));
}

function clampTrades(value) {
  const n = Math.floor(Number(value) || 1);
  return Math.min(20, Math.max(1, n));
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return null;
  const cleaned = String(value).replace(/,/g, "").replace(/[^\d.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function abortSignalAfter(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function dedupeSymbols(list) {
  const seen = new Set();
  const unique = [];
  for (const raw of list || []) {
    const s = normalizeBrokerSymbol(raw);
    if (!s) continue;
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }
  return unique;
}

function estimateEntryForSymbol(symbol) {
  const raw = String(symbol || "")
    .toUpperCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/CASH$/i, "")
    .replace(/\.(MIC|M|PRO|RAW|ECN|STD|CASH|SPOT)$/i, "");
  const base = raw.split(".")[0] || raw;
  const table = [
    [/^(US30|DJ30|WS30|DJI|USA30|USWALLST30|DOW30)/, 45000],
    [/^(NAS100|USTEC|NDX|NASDAQ|US100|USATECH100|TECH100)/, 20000],
    [/^(SPX500|US500|SP500|SPX)/, 5600],
    [/^(GER40|DE40|DAX|DE30|GER30|GDAXI)/, 18500],
    [/^(UK100|FTSE)/, 8200],
    [/^(JP225|JPN225|NI225|NIKKEI)/, 38000],
    [/^(XAU|GOLD)/, 4200],
    [/^(XAG|SILVER)/, 38],
    [/^(BTC)/, 95000],
    [/^(ETH)/, 3500],
    [/^(USOIL|WTI|CL)/, 75],
    [/^(UKOIL|BRENT)/, 80],
    [/^(EURUSD|EUR)/, 1.085],
    [/^(GBPUSD|GBP)/, 1.27],
    [/^(USDJPY|JPY)/, 149.5],
    [/^(AUDUSD|AUD)/, 0.65],
    [/^(NZDUSD|NZD)/, 0.6],
    [/^(USDCAD|CAD)/, 1.36],
    [/^(USDCHF|CHF)/, 0.88],
  ];
  for (const [re, price] of table) {
    if (re.test(base) || re.test(raw)) return price;
  }
  if (/USD$/.test(base) || /^USD/.test(base)) return 1.1;
  if (/JPY$/.test(base)) return 150;
  return 100;
}

/** Every symbol in Your pairs → "On your app". */
export function listAppPairs(activeBot, eas = [], appSymbols = null) {
  const fromApp =
    appSymbols instanceof Set
      ? Array.from(appSymbols)
      : Array.isArray(appSymbols)
        ? appSymbols
        : [];

  if (fromApp.length) {
    return dedupeSymbols(fromApp);
  }

  const botId = String(activeBot?.id || "").trim();
  const rows = Array.isArray(eas) ? eas : [];
  const ea =
    (botId && rows.find((row) => String(row?.id || "").trim() === botId)) ||
    rows[0] ||
    null;
  const fromEa = Array.isArray(ea?.symbols) ? ea.symbols : [];
  const fromAllEas = rows.flatMap((row) =>
    Array.isArray(row?.symbols) ? row.symbols : []
  );
  const fromClient = Array.isArray(ea?.clientSymbols) ? ea.clientSymbols : [];
  const fromBot = Array.isArray(activeBot?.symbols) ? activeBot.symbols : [];
  return dedupeSymbols([
    ...fromEa,
    ...fromAllEas,
    ...fromClient,
    ...fromBot,
  ]);
}

export function pickSelectedSymbol(activeBot, eas = [], appSymbols = null) {
  return listAppPairs(activeBot, eas, appSymbols)[0] || "";
}

async function analyzeSymbolWithOpenAI({
  symbol,
  price,
  preferredSide = "",
  timeframes = START_SCANNER_TIMEFRAMES,
} = {}) {
  const response = await fetch(apiUrl("/api/chart/analyze-symbol"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      symbol,
      price,
      timeframes,
      side: preferredSide || undefined,
    }),
    cache: "no-store",
    signal: abortSignalAfter(22_000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `Symbol analysis failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** START button R:R — same as Chart Scanner non-H4 ladder. */
export const START_TP_REWARD_MULTIPLES = [2, 3, 4];

/**
 * Protective START plan when OpenAI is unavailable.
 * Rules (anti-blow):
 *  1. Live quote required — never trade on a table estimate
 *  2. Mentor Action must be BUY or SELL — never guess BOTH → BUY
 *  3. Half lot + 1 trade (TP1 only) — cut exposure vs full AI open
 *  4. Tight scalper SL from defaultStopDistance
 */
export function buildStartSafeScalperPlan({
  symbol = "",
  livePrice = null,
  preferredSide = "",
  lot = 0.01,
  hasLiveQuote = false,
} = {}) {
  const sym = normalizeBrokerSymbol(symbol) || String(symbol || "").trim();
  const entry = toFiniteNumber(livePrice);
  if (!hasLiveQuote || entry == null || entry <= 0) {
    return {
      skip: true,
      source: START_OFFLINE_STRATEGY,
      error: `Safe Scalper: need a live ${sym || "pair"} quote (AI offline)`,
    };
  }

  const sideRaw = String(preferredSide || "")
    .trim()
    .toUpperCase();
  const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : "";
  if (!side) {
    return {
      skip: true,
      source: START_OFFLINE_STRATEGY,
      error: `Safe Scalper: set Action to BUY or SELL on ${
        sym || "this pair"
      } (AI offline — no blind trades)`,
    };
  }

  const risk = defaultStopDistance(sym, entry);
  const stopLoss = side === "BUY" ? entry - risk : entry + risk;
  const safeLot = clampLot(Math.max(0.01, clampLot(lot) * 0.5));

  return {
    skip: false,
    source: START_OFFLINE_STRATEGY,
    side,
    entry,
    stopLoss,
    lot: safeLot,
    tradeCount: 1,
    timeframe: "M30",
    confidence: 55,
    analysis:
      "Safe Scalper (AI offline): mentor BUY/SELL only, half lot, 1 trade (TP1 1:2), tight SL — protects the account when OpenAI credits are low.",
  };
}

function buildScannerAlignedSetup({
  symbol,
  side,
  entry,
  stopLoss,
  timeframe = "M30",
  analysis = "",
  confidence = 70,
  source = "openai-symbol",
} = {}) {
  const tfRaw = normalizeChartTimeframe(timeframe || "M30");
  const tf = ["M30", "H1", "H4"].includes(tfRaw) ? tfRaw : "M30";
  // Always TP1 1:2 · TP2 1:3 · TP3 1:4 — even when AI labels the chart H4.
  const levels = buildSafeMultiTpLevels({
    symbol,
    side: normalizeTradeSide(side, { entry, stopLoss, trustSide: true }),
    entry,
    stopLoss,
    timeframe: tf,
    rewardMultiples: START_TP_REWARD_MULTIPLES,
  });
  return {
    symbol,
    detectedSymbol: symbol,
    side: levels.side,
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit1: levels.takeProfit1,
    takeProfit2: levels.takeProfit2,
    takeProfit3: levels.takeProfit3,
    takeProfit: levels.takeProfit3,
    riskReward:
      levels.riskReward ||
      tpRiskRewardLabel(tf, START_TP_REWARD_MULTIPLES),
    timeframe: tf,
    analysis: String(analysis || "").trim(),
    confidence,
    source,
  };
}

function targetForTradeIndex(index) {
  const n = Math.max(0, Math.floor(Number(index) || 0));
  const slot = n % 3;
  if (slot === 0) {
    return { target: "TP1", takeProfitKey: "takeProfit1", tradeNo: n + 1 };
  }
  if (slot === 1) {
    return { target: "TP2", takeProfitKey: "takeProfit2", tradeNo: n + 1 };
  }
  return { target: "TP3", takeProfitKey: "takeProfit3", tradeNo: n + 1 };
}

function buildTpThreads({ signal, lot, tradeCount }) {
  const count = clampTrades(tradeCount);
  const volume = clampLot(lot);
  const threads = [];
  for (let i = 0; i < count; i += 1) {
    const { target, takeProfitKey, tradeNo } = targetForTradeIndex(i);
    const takeProfit = toFiniteNumber(signal?.[takeProfitKey]);
    if (takeProfit == null || takeProfit <= 0) continue;
    const slot = i % 3;
    threads.push({
      timeframe: TF_FOR_TP_SLOT[slot] || "M30",
      target,
      tradeNo,
      volume,
      takeProfit,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      side: signal.side,
    });
  }
  return threads;
}

/**
 * Chart-Scanner-style open for one pair.
 * Quote is best-effort (never blocks the open); placeTrade re-anchors to live.
 */
async function openPairSilent({
  symbol,
  accountId,
  region = "",
  getSymbolMeta,
  comment,
  botName = "Bot",
} = {}) {
  const meta = getSymbolMeta?.(symbol) || {};
  const actionRaw = String(meta.action || "BOTH").toUpperCase();
  const preferredSide =
    actionRaw === "SELL" ? "SELL" : actionRaw === "BUY" ? "BUY" : "";
  let lot = clampLot(meta.lotSize);
  let tradeCount = clampTrades(meta.trades);

  let tradeSymbol = normalizeBrokerSymbol(symbol) || symbol;
  let livePrice = estimateEntryForSymbol(symbol);
  let hasLiveQuote = false;

  // Best-effort fast quote — Safe Scalper requires this when AI is down.
  try {
    const quote = await getSymbolQuote({
      accountId,
      symbol,
      side: preferredSide || "BUY",
      fast: true,
      signal: abortSignalAfter(8_000),
    });
    const price = toFiniteNumber(quote?.price);
    if (price != null && price > 0) {
      livePrice = price;
      tradeSymbol = normalizeBrokerSymbol(quote?.symbol || symbol) || symbol;
      hasLiveQuote = true;
    }
  } catch {
    // keep estimate — AI path can still open; Safe Scalper will skip
  }

  let ai = null;
  try {
    ai = await analyzeSymbolWithOpenAI({
      symbol: tradeSymbol,
      price: livePrice,
      preferredSide,
      timeframes: START_SCANNER_TIMEFRAMES,
    });
  } catch {
    // Safe Scalper below — never blind BUY on full size
  }

  let signal;
  let mode = "openai";

  if (ai?.side) {
    signal = buildScannerAlignedSetup({
      symbol: tradeSymbol,
      side: ai.side,
      entry: livePrice,
      stopLoss: ai.stopLoss,
      timeframe: ai.timeframe || "M30",
      analysis: ai.analysis || "",
      confidence: ai.confidence || 65,
      source: ai.source || "openai-symbol",
    });
  } else {
    mode = START_OFFLINE_STRATEGY;
    const plan = buildStartSafeScalperPlan({
      symbol: tradeSymbol,
      livePrice,
      preferredSide,
      lot,
      hasLiveQuote,
    });
    if (plan.skip) {
      return {
        ok: false,
        skipped: true,
        symbol: tradeSymbol,
        opened: 0,
        tradeCount: 0,
        source: plan.source,
        mode,
        error: plan.error,
      };
    }
    lot = plan.lot;
    tradeCount = plan.tradeCount;
    signal = buildScannerAlignedSetup({
      symbol: tradeSymbol,
      side: plan.side,
      entry: plan.entry,
      stopLoss: plan.stopLoss,
      timeframe: plan.timeframe,
      analysis: plan.analysis,
      confidence: plan.confidence,
      source: plan.source,
    });
  }

  const threads = buildTpThreads({ signal, lot, tradeCount });
  if (!threads.length) {
    return {
      ok: false,
      symbol: tradeSymbol,
      opened: 0,
      tradeCount,
      mode,
      error: "Could not build trade threads",
    };
  }

  let opened = 0;
  let lastError = "";
  const openedTargets = [];

  for (const thread of threads) {
    try {
      const fill = await placeTrade({
        accountId,
        symbol: tradeSymbol,
        volume: thread.volume,
        side: thread.side,
        stopLoss: thread.stopLoss,
        takeProfit: thread.takeProfit,
        count: 1,
        region,
        comment,
        source: "chart-scanner",
        signal: abortSignalAfter(60_000),
      });
      opened += 1;
      openedTargets.push(thread.target);
      recordTrade({
        botName,
        symbol:
          normalizeBrokerSymbol(fill?.symbol || tradeSymbol) || tradeSymbol,
        lotSize: thread.volume,
        action: thread.side,
        side: thread.side,
        comment,
        entry: thread.entry,
        stopLoss: thread.stopLoss,
        takeProfit: thread.takeProfit,
        target: `${thread.target}/${thread.timeframe}`,
      });
    } catch (error) {
      lastError = error?.message || "Trade failed";
      // If session died, stop burning time on more threads for this pair.
      if (/session expired|reconnect|not connect/i.test(lastError)) break;
    }
  }

  return {
    ok: opened > 0,
    symbol: tradeSymbol,
    opened,
    tradeCount,
    side: signal.side,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit1,
    takeProfit2: signal.takeProfit2,
    takeProfit3: signal.takeProfit3,
    riskReward: signal.riskReward,
    timeframe: signal.timeframe,
    lot,
    targets: openedTargets,
    source: signal.source,
    mode,
    error: opened > 0 ? lastError || null : lastError || "Open failed",
  };
}

/**
 * Silently open every Your pairs symbol like EA Chart Scanner Execute.
 * Does NOT consume chart-scan quota (START must always be able to open).
 */
export async function runSilentStartOpen({
  activeBot,
  eas,
  appSymbols = null,
  pairs: pairsOverride = null,
  mt5Session,
  getSymbolMeta,
  publishOrbTrade,
  variant = "zeta",
  onProgress,
} = {}) {
  const accountId = String(mt5Session?.accountId || "").trim();
  if (!accountId) {
    return { ok: false, error: "Connect MetaTrader before START open" };
  }

  const pairs = dedupeSymbols(
    Array.isArray(pairsOverride) && pairsOverride.length
      ? pairsOverride
      : listAppPairs(activeBot, eas, appSymbols)
  );
  if (!pairs.length) {
    return { ok: false, error: "Add a pair first (selected symbol required)" };
  }

  const comment = buildScannerFillComment({
    botName: activeBot?.name,
    variant: variant === "v2" ? "v2" : "default",
    premium: variant === "v2",
  });
  const botName = activeBot?.name || "Bot";
  const region = mt5Session?.region || "";

  onProgress?.({ phase: "scanning", pairCount: pairs.length });

  const results = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const symbol = pairs[i];
    onProgress?.({
      phase: "opening",
      symbol,
      index: i + 1,
      pairCount: pairs.length,
    });
    // Sequential — same reliability as EA Chart Execute.
    // eslint-disable-next-line no-await-in-loop
    const row = await openPairSilent({
      symbol,
      accountId,
      region,
      getSymbolMeta,
      comment,
      botName,
    });
    results.push(row);

    if (row?.ok && !results.some((r, idx) => idx < results.length - 1 && r?.ok)) {
      publishOrbTrade?.({
        botName,
        comment,
        symbol: row.symbol,
        lotSize: row.lot,
        action: row.side,
        side: row.side,
        entry: row.entry,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit1,
        target: "TP1",
      });
    }
  }

  const okRows = results.filter((row) => row?.ok);
  const opened = results.reduce(
    (sum, row) => sum + (Number(row?.opened) || 0),
    0
  );
  const usedSafeScalper = results.some(
    (row) => row?.mode === START_OFFLINE_STRATEGY || row?.source === START_OFFLINE_STRATEGY
  );
  const lastError =
    results.find((row) => row?.error && !row?.ok)?.error ||
    results.find((row) => row?.error)?.error ||
    null;

  if (!opened) {
    return {
      ok: false,
      opened: 0,
      pairs: results,
      symbols: pairs,
      mode: usedSafeScalper ? START_OFFLINE_STRATEGY : "openai",
      error: lastError || "Open failed — reconnect MetaTrader and try again",
    };
  }

  const primary = okRows[0];
  return {
    ok: true,
    opened,
    pairCount: pairs.length,
    successPairs: okRows.length,
    symbols: okRows.map((row) => row.symbol),
    pairs: results,
    side: primary?.side,
    symbol: primary?.symbol,
    entry: primary?.entry,
    stopLoss: primary?.stopLoss,
    takeProfit1: primary?.takeProfit1,
    takeProfit2: primary?.takeProfit2,
    takeProfit3: primary?.takeProfit3,
    riskReward: primary?.riskReward,
    timeframe: primary?.timeframe,
    mode: usedSafeScalper ? START_OFFLINE_STRATEGY : primary?.mode || "openai",
    source: primary?.source,
    error: lastError,
  };
}
