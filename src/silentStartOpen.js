/**
 * Silent START → open: after a short delay, run the same OpenAI + SL/TP
 * ladder as Chart Scanner (no scanner UI), then place TP1/TP2/TP3 threads.
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

function clampLot(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  return Number(Math.min(1000, n).toFixed(4));
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Pick the selected / first pair from "Your pairs".
 * PairsSheet writes to eas[].symbols (appSymbols) — not bots[].symbols /
 * clientSymbols — so START must read the same list the user just edited.
 */
export function pickSelectedSymbol(activeBot, eas = [], appSymbols = null) {
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
  const fromApp =
    appSymbols instanceof Set
      ? Array.from(appSymbols)
      : Array.isArray(appSymbols)
        ? appSymbols
        : [];
  const fromClient = Array.isArray(ea?.clientSymbols) ? ea.clientSymbols : [];
  const fromBot = Array.isArray(activeBot?.symbols) ? activeBot.symbols : [];

  const list = [...fromEa, ...fromAllEas, ...fromApp, ...fromClient, ...fromBot]
    .map((s) => normalizeBrokerSymbol(s))
    .filter(Boolean);
  // Prefer active EA order; de-dupe while keeping first hit.
  const seen = new Set();
  const unique = [];
  for (const s of list) {
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }
  return unique[0] || "";
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
 * One open thread per TP target — same map as Chart Scanner Execute.
 * Trade 1 → TP1 (1:2), Trade 2 → TP2 (1:3), Trade 3 → TP3 (1:4).
 * Shared SL from the OpenAI scan (widened to instrument floors).
 */
function buildTpThreads({ signal, lot }) {
  const map = [
    {
      timeframe: "M15",
      target: "TP1",
      takeProfitKey: "takeProfit1",
      tradeNo: 1,
    },
    {
      timeframe: "M30",
      target: "TP2",
      takeProfitKey: "takeProfit2",
      tradeNo: 2,
    },
    {
      timeframe: "H1",
      target: "TP3",
      takeProfitKey: "takeProfit3",
      tradeNo: 3,
    },
  ];
  const threads = [];
  for (const row of map) {
    const takeProfit = toFiniteNumber(signal?.[row.takeProfitKey]);
    if (takeProfit == null || takeProfit <= 0) continue;
    threads.push({
      timeframe: row.timeframe,
      target: row.target,
      tradeNo: row.tradeNo,
      volume: lot,
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
 * Silently open TP threads for the selected symbol (no Chart Scanner UI).
 * Flow matches scanner: live quote → OpenAI side/SL → 1:2/1:3/1:4 TPs → place.
 * @returns {Promise<{ ok: boolean, symbol?: string, opened?: number, error?: string }>}
 */
export async function runSilentStartOpen({
  activeBot,
  eas,
  appSymbols = null,
  mt5Session,
  getSymbolMeta,
  publishOrbTrade,
  variant = "zeta",
} = {}) {
  const accountId = String(mt5Session?.accountId || "").trim();
  if (!accountId) {
    return { ok: false, error: "Connect MetaTrader before START open" };
  }

  const symbol = pickSelectedSymbol(activeBot, eas, appSymbols);
  if (!symbol) {
    return { ok: false, error: "Add a pair first (selected symbol required)" };
  }

  const remaining = loadScansLeft(variant);
  if (remaining <= 0) {
    return { ok: false, error: "No charts left today" };
  }

  const meta = getSymbolMeta?.(symbol) || {};
  const actionRaw = String(meta.action || "BOTH").toUpperCase();
  const preferredSide =
    actionRaw === "SELL" ? "SELL" : actionRaw === "BUY" ? "BUY" : "";
  const lot = clampLot(meta.lotSize);

  // 1) Live broker quote — never use hardcoded estimate prices for SL/TP.
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
      error: error?.message || "Could not fetch live quote",
    };
  }
  const livePrice = toFiniteNumber(quote?.price);
  const tradeSymbol =
    normalizeBrokerSymbol(quote?.symbol || symbol) || symbol;
  if (livePrice == null || livePrice <= 0) {
    return { ok: false, symbol: tradeSymbol, error: "No live price for symbol" };
  }

  // 2) OpenAI scan — same engine as Chart Scanner (side + protective stop).
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
      error: error?.message || "OpenAI scan failed",
    };
  }

  // Prefer live ask/bid over AI entry; keep AI stop + side.
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
      error: "Could not build scanner SL/TP1/TP2/TP3",
    };
  }

  const threads = buildTpThreads({ signal, lot });
  if (!threads.length) {
    return {
      ok: false,
      symbol: tradeSymbol,
      error: "Could not build M15/M30/H1 scanner threads",
    };
  }

  consumeScan(variant);

  const comment = buildScannerFillComment({
    botName: activeBot?.name,
    variant: "default",
    premium: false,
  });

  publishOrbTrade?.({
    botName: activeBot?.name || "Bot",
    comment,
    symbol: tradeSymbol,
    lotSize: lot,
    action: signal.side,
    side: signal.side,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit1,
    target: "TP1",
  });

  let opened = 0;
  let lastError = "";
  const openedTfs = [];
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
        region: mt5Session?.region || "",
        comment,
        source: "chart-scanner",
      });
      opened += 1;
      openedTfs.push(thread.timeframe);
      openedTargets.push(thread.target);
      recordTrade({
        botName: activeBot?.name || "Bot",
        symbol: normalizeBrokerSymbol(fill?.symbol || tradeSymbol) || tradeSymbol,
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
    }
  }

  if (!opened) {
    return {
      ok: false,
      symbol: tradeSymbol,
      opened: 0,
      error: lastError || "Open failed",
    };
  }
  return {
    ok: true,
    symbol: tradeSymbol,
    opened,
    side: signal.side,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit1: signal.takeProfit1,
    takeProfit2: signal.takeProfit2,
    takeProfit3: signal.takeProfit3,
    riskReward: signal.riskReward,
    timeframes: openedTfs,
    targets: openedTargets,
    error: lastError || null,
  };
}
