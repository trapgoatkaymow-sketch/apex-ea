/**
 * Silent START → open: after a short delay, run the same OpenAI + SL/TP
 * ladder as Chart Scanner (no scanner UI) for every pair in Your pairs.
 *
 * Each pair opens its configured Number of trades (TP1/TP2/TP3 cycle).
 * All pairs execute at the same time (Promise.all).
 *
 * TP ladder (non-H4, same as scanner): TP1 1:2 · TP2 1:3 · TP3 1:4
 * Stop loss comes from OpenAI and is widened with buildSafeMultiTpLevels.
 */
import { apiUrl } from "./apiOrigin.js";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";
import { recordTrade } from "./dailyTradeHistory.js";
import {
  buildScannerFillComment,
  getSymbolQuote,
  placeTrade,
} from "./metaApi.js";
import { consumeScan, loadScansLeft } from "./scanQuota.js";
import {
  buildSafeMultiTpLevels,
  normalizeChartTimeframe,
  normalizeTradeSide,
  tpRiskRewardLabel,
} from "./tradeLevels.js";

/** Delay after START before the silent OpenAI scan + open runs. */
export const START_SILENT_OPEN_DELAY_MS = 20_000;

/** Scanner timeframes used by the START button open. */
export const START_SCANNER_TIMEFRAMES = ["M15", "M30", "H1"];

const TF_FOR_TP_SLOT = ["M15", "M30", "H1"];

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
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
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

/**
 * Every symbol in Your pairs → "On your app".
 * Source of truth is appSymbols (union of eas[].symbols), same as PairsSheet.
 */
export function listAppPairs(activeBot, eas = [], appSymbols = null) {
  const fromApp =
    appSymbols instanceof Set
      ? Array.from(appSymbols)
      : Array.isArray(appSymbols)
        ? appSymbols
        : [];

  // Primary: exactly what the Pairs sheet shows under "On your app".
  if (fromApp.length) {
    return dedupeSymbols(fromApp);
  }

  // Fallbacks if appSymbols was not passed (older callers).
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

/** First pair — kept for callers that only need a quick presence check. */
export function pickSelectedSymbol(activeBot, eas = [], appSymbols = null) {
  return listAppPairs(activeBot, eas, appSymbols)[0] || "";
}

/**
 * OpenAI symbol scan (no screenshot) — same backend ladder as Chart Scanner.
 */
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

/**
 * Build one scanner-aligned setup from live price + OpenAI stop.
 * Always uses the non-H4 TP ladder: 1:2 / 1:3 / 1:4.
 */
function buildScannerAlignedSetup({
  symbol,
  side,
  entry,
  stopLoss,
  timeframe = "M15",
  analysis = "",
  confidence = 70,
  source = "openai-symbol",
} = {}) {
  const tfRaw = normalizeChartTimeframe(timeframe || "M15");
  // Force non-H4 so TP1/TP2/TP3 stay 1:2 / 1:3 / 1:4 like the scanner default.
  const tf = tfRaw === "H4" ? "M15" : tfRaw || "M15";
  const levels = buildSafeMultiTpLevels({
    symbol,
    side: normalizeTradeSide(side, { entry, stopLoss, trustSide: true }),
    entry,
    stopLoss,
    timeframe: tf,
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
    riskReward: levels.riskReward || tpRiskRewardLabel(tf),
    timeframe: tf,
    analysis: String(analysis || "").trim(),
    confidence,
    source,
  };
}

/**
 * Trade index → TP target (cycles forever), same as Chart Scanner Execute:
 *   T1 → TP1, T2 → TP2, T3 → TP3, T4 → TP1, …
 */
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

/**
 * Build Exact Number of trades threads for one pair.
 * Shared SL from the OpenAI scan; TP cycles 1:2 / 1:3 / 1:4.
 */
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
      timeframe: TF_FOR_TP_SLOT[slot] || "M15",
      target,
      tradeNo,
      volume,
      takeProfit,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      side: signal.side,
      signal,
    });
  }
  return threads;
}

/**
 * Scan + open one pair: live quote → OpenAI → Number of trades threads.
 * Fires all placeTrade calls for that pair concurrently.
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
  const lot = clampLot(meta.lotSize);
  const tradeCount = clampTrades(meta.trades);

  let quote;
  try {
    quote = await getSymbolQuote({
      accountId,
      symbol,
      side: preferredSide || "BUY",
    });
  } catch (error) {
    return {
      ok: false,
      symbol,
      opened: 0,
      tradeCount,
      error: error?.message || "Could not fetch live quote",
    };
  }

  const livePrice = toFiniteNumber(quote?.price);
  const tradeSymbol =
    normalizeBrokerSymbol(quote?.symbol || symbol) || symbol;
  if (livePrice == null || livePrice <= 0) {
    return {
      ok: false,
      symbol: tradeSymbol,
      opened: 0,
      tradeCount,
      error: "No live price for symbol",
    };
  }

  let ai;
  try {
    ai = await analyzeSymbolWithOpenAI({
      symbol: tradeSymbol,
      price: livePrice,
      preferredSide,
      timeframes: START_SCANNER_TIMEFRAMES,
    });
  } catch (error) {
    return {
      ok: false,
      symbol: tradeSymbol,
      opened: 0,
      tradeCount,
      error: error?.message || "OpenAI scan failed",
    };
  }

  const signal = buildScannerAlignedSetup({
    symbol: tradeSymbol,
    side: ai?.side || preferredSide || "BUY",
    entry: livePrice,
    stopLoss: ai?.stopLoss,
    timeframe: ai?.timeframe || "M15",
    analysis: ai?.analysis || "",
    confidence: ai?.confidence,
    source: ai?.source || "openai-symbol",
  });

  if (
    toFiniteNumber(signal.stopLoss) == null ||
    toFiniteNumber(signal.takeProfit1) == null ||
    toFiniteNumber(signal.takeProfit2) == null ||
    toFiniteNumber(signal.takeProfit3) == null
  ) {
    return {
      ok: false,
      symbol: tradeSymbol,
      opened: 0,
      tradeCount,
      error: "Could not build scanner SL/TP1/TP2/TP3",
    };
  }

  const threads = buildTpThreads({ signal, lot, tradeCount });
  if (!threads.length) {
    return {
      ok: false,
      symbol: tradeSymbol,
      opened: 0,
      tradeCount,
      error: "Could not build trade threads",
    };
  }

  // Place every thread for this pair at the same time.
  const settled = await Promise.all(
    threads.map(async (thread) => {
      try {
        const fill = await placeTrade({
          accountId,
          symbol: tradeSymbol,
          volume: thread.volume,
          side: thread.side,
          stopLoss: thread.stopLoss,
          takeProfit: thread.takeProfit,
          region,
          comment,
          source: "chart-scanner",
        });
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
        return { ok: true, thread, fill };
      } catch (error) {
        return {
          ok: false,
          thread,
          error: error?.message || "Trade failed",
        };
      }
    })
  );

  const opened = settled.filter((row) => row.ok).length;
  const lastError =
    settled.find((row) => !row.ok)?.error ||
    (opened ? null : "Open failed");

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
    lot,
    targets: settled.filter((r) => r.ok).map((r) => r.thread.target),
    error: lastError,
  };
}

/**
 * Silently open every Your pairs symbol with its Number of trades.
 * All pairs are scanned + opened concurrently.
 * @returns {Promise<{ ok: boolean, opened?: number, pairs?: object[], error?: string }>}
 */
export async function runSilentStartOpen({
  activeBot,
  eas,
  appSymbols = null,
  /** Frozen "On your app" list from the START press (preferred). */
  pairs: pairsOverride = null,
  mt5Session,
  getSymbolMeta,
  publishOrbTrade,
  variant = "zeta",
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

  const remaining = loadScansLeft(variant);
  if (remaining <= 0) {
    return { ok: false, error: "No charts left today" };
  }

  // One START session = one chart scan credit (multi-pair fan-out).
  consumeScan(variant);

  const comment = buildScannerFillComment({
    botName: activeBot?.name,
    variant: "default",
    premium: false,
  });
  const botName = activeBot?.name || "Bot";
  const region = mt5Session?.region || "";

  // Announce the first pair on the orb; all pairs still open together.
  const firstMeta = getSymbolMeta?.(pairs[0]) || {};
  publishOrbTrade?.({
    botName,
    comment,
    symbol: pairs[0],
    lotSize: clampLot(firstMeta.lotSize),
    action: String(firstMeta.action || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
    side: String(firstMeta.action || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
    entry: null,
    stopLoss: null,
    takeProfit: null,
    target: "TP1",
  });

  // Every Your pairs symbol runs at the same time.
  const results = await Promise.all(
    pairs.map((symbol) =>
      openPairSilent({
        symbol,
        accountId,
        region,
        getSymbolMeta,
        comment,
        botName,
      })
    )
  );

  const okRows = results.filter((row) => row?.ok);
  const opened = results.reduce((sum, row) => sum + (Number(row?.opened) || 0), 0);
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
      error: lastError || "Open failed",
    };
  }

  // Refresh orb with the first successful fill details.
  const primary = okRows[0];
  if (primary) {
    publishOrbTrade?.({
      botName,
      comment,
      symbol: primary.symbol,
      lotSize: primary.lot,
      action: primary.side,
      side: primary.side,
      entry: primary.entry,
      stopLoss: primary.stopLoss,
      takeProfit: primary.takeProfit1,
      target: "TP1",
    });
  }

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
    error: lastError,
  };
}
