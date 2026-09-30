/**
 * Silent START → open: after a short delay, run OpenAI + scanner SL/TP
 * for every pair in Your pairs, then place each pair's Number of trades.
 *
 * TP ladder (non-H4): TP1 1:2 · TP2 1:3 · TP3 1:4
 * One batched OrderSend per pair (count + takeProfits) so START stays reliable.
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

function clampTrades(value) {
  const n = Math.floor(Number(value) || 1);
  return Math.min(20, Math.max(1, n));
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Rough mid-market anchors when live quote is briefly unavailable. */
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

/** First pair — kept for callers that only need a quick presence check. */
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

async function fetchQuoteWithRetry({
  accountId,
  symbol,
  side = "BUY",
  attempts = 3,
} = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const quote = await getSymbolQuote({ accountId, symbol, side });
      const price = toFiniteNumber(quote?.price);
      if (price != null && price > 0) return quote;
      lastError = new Error("No live price for symbol");
    } catch (error) {
      lastError = error;
    }
    if (i < attempts - 1) await sleep(350 * (i + 1));
  }
  const err = new Error(lastError?.message || "Could not fetch live quote");
  err.status = lastError?.status || 404;
  throw err;
}

/**
 * Scan + open one pair.
 * Uses one batched placeTrade(count + takeProfits) so Number of trades opens
 * without flooding MT5 with parallel OrderSends.
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

  let tradeSymbol = normalizeBrokerSymbol(symbol) || symbol;
  let livePrice = null;
  let quoteError = "";

  try {
    const quote = await fetchQuoteWithRetry({
      accountId,
      symbol,
      side: preferredSide || "BUY",
      attempts: 3,
    });
    livePrice = toFiniteNumber(quote?.price);
    tradeSymbol = normalizeBrokerSymbol(quote?.symbol || symbol) || symbol;
  } catch (error) {
    quoteError = error?.message || "Could not fetch live quote";
    livePrice = estimateEntryForSymbol(symbol);
  }

  if (livePrice == null || livePrice <= 0) {
    return {
      ok: false,
      symbol: tradeSymbol,
      opened: 0,
      tradeCount,
      error: quoteError || "No live price for symbol",
    };
  }

  let ai = null;
  let aiError = "";
  try {
    ai = await analyzeSymbolWithOpenAI({
      symbol: tradeSymbol,
      price: livePrice,
      preferredSide,
      timeframes: START_SCANNER_TIMEFRAMES,
    });
  } catch (error) {
    aiError = error?.message || "OpenAI scan failed";
  }

  const signal = buildScannerAlignedSetup({
    symbol: tradeSymbol,
    side: ai?.side || preferredSide || "BUY",
    entry: livePrice,
    stopLoss: ai?.stopLoss,
    timeframe: ai?.timeframe || "M15",
    analysis: ai?.analysis || (aiError ? `Local fallback · ${aiError}` : ""),
    confidence: ai?.confidence || 65,
    source: ai?.source || (aiError ? "local-fallback" : "openai-symbol"),
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

  const takeProfits = [
    signal.takeProfit1,
    signal.takeProfit2,
    signal.takeProfit3,
  ];

  try {
    // One API call opens Number of trades with TP1/TP2/TP3 cycling server-side.
    const fill = await placeTrade({
      accountId,
      symbol: tradeSymbol,
      volume: lot,
      side: signal.side,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit1,
      takeProfits,
      count: tradeCount,
      region,
      comment,
      source: "chart-scanner",
    });
    const opened = Math.max(
      1,
      Math.min(tradeCount, Number(fill?.count) || tradeCount)
    );
    const filledSymbol =
      normalizeBrokerSymbol(fill?.symbol || tradeSymbol) || tradeSymbol;

    for (let i = 0; i < opened; i += 1) {
      const slot = i % 3;
      const target = slot === 0 ? "TP1" : slot === 1 ? "TP2" : "TP3";
      recordTrade({
        botName,
        symbol: filledSymbol,
        lotSize: lot,
        action: signal.side,
        side: signal.side,
        comment,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: takeProfits[slot],
        target: `${target}/M15`,
      });
    }

    return {
      ok: true,
      symbol: filledSymbol,
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
      targets: Array.from({ length: opened }, (_, i) =>
        i % 3 === 0 ? "TP1" : i % 3 === 1 ? "TP2" : "TP3"
      ),
      warning: quoteError || aiError || null,
      error: null,
    };
  } catch (error) {
    // Fallback: open one-by-one if the batched call fails.
    let opened = 0;
    let lastError = error?.message || "Trade failed";
    for (let i = 0; i < tradeCount; i += 1) {
      const slot = i % 3;
      const takeProfit = takeProfits[slot];
      const target = slot === 0 ? "TP1" : slot === 1 ? "TP2" : "TP3";
      try {
        const fill = await placeTrade({
          accountId,
          symbol: tradeSymbol,
          volume: lot,
          side: signal.side,
          stopLoss: signal.stopLoss,
          takeProfit,
          count: 1,
          region,
          comment,
          source: "chart-scanner",
        });
        opened += 1;
        recordTrade({
          botName,
          symbol:
            normalizeBrokerSymbol(fill?.symbol || tradeSymbol) || tradeSymbol,
          lotSize: lot,
          action: signal.side,
          side: signal.side,
          comment,
          entry: signal.entry,
          stopLoss: signal.stopLoss,
          takeProfit,
          target: `${target}/M15`,
        });
      } catch (inner) {
        lastError = inner?.message || lastError;
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
      lot,
      error: opened > 0 ? lastError : lastError || "Open failed",
    };
  }
}

/**
 * Silently open every Your pairs symbol with its Number of trades.
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

  const comment = buildScannerFillComment({
    botName: activeBot?.name,
    variant: variant === "v2" ? "v2" : "default",
    premium: variant === "v2",
  });
  const botName = activeBot?.name || "Bot";
  const region = mt5Session?.region || "";

  const firstMeta = getSymbolMeta?.(pairs[0]) || {};
  publishOrbTrade?.({
    botName,
    comment,
    symbol: pairs[0],
    lotSize: clampLot(firstMeta.lotSize),
    action:
      String(firstMeta.action || "BUY").toUpperCase() === "SELL"
        ? "SELL"
        : "BUY",
    side:
      String(firstMeta.action || "BUY").toUpperCase() === "SELL"
        ? "SELL"
        : "BUY",
    entry: null,
    stopLoss: null,
    takeProfit: null,
    target: "TP1",
  });

  // Open pairs with light concurrency so MT5 session is not flooded.
  const results = new Array(pairs.length);
  const concurrency = Math.min(2, pairs.length);
  let cursor = 0;
  async function worker() {
    while (cursor < pairs.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await openPairSilent({
        symbol: pairs[idx],
        accountId,
        region,
        getSymbolMeta,
        comment,
        botName,
      });
    }
  }
  await Promise.all(
    Array.from({ length: concurrency }, () => worker())
  );

  const okRows = results.filter((row) => row?.ok);
  const opened = results.reduce(
    (sum, row) => sum + (Number(row?.opened) || 0),
    0
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
      error: lastError || "Open failed — reconnect MetaTrader and try again",
    };
  }

  // Charge one scan only after at least one fill succeeded.
  consumeScan(variant);

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
