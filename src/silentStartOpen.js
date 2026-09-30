/**
 * Silent START → Chart Scanner style open (no scanner UI):
 *   wait 15s → live quote → OpenAI scan (M30/H1/H4) → open Number of trades
 *   for every pair in Your pairs, with the same SL/TP ladder as EA Chart.
 *
 * Ladder (same as Chart Scanner):
 *   H4 → TP1 1:1 · TP2 1:2 · TP3 1:3
 *   M30/H1 → TP1 1:2 · TP2 1:3 · TP3 1:4
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
export const START_SILENT_OPEN_DELAY_MS = 15_000;

/** Scanner timeframes used by the START button (like EA Chart). */
export const START_SCANNER_TIMEFRAMES = ["M30", "H1", "H4"];

const TF_FOR_TP_SLOT = ["M30", "H1", "H4"];

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
  timeframe = "M30",
  analysis = "",
  confidence = 70,
  source = "openai-symbol",
} = {}) {
  const tfRaw = normalizeChartTimeframe(timeframe || "M30");
  const tf = ["M30", "H1", "H4"].includes(tfRaw) ? tfRaw : "M30";
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

/** Same TP cycle as Chart Scanner Execute: T1→TP1, T2→TP2, T3→TP3, … */
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

async function fetchQuoteFast({ accountId, symbol, side = "BUY" } = {}) {
  let lastError = null;
  for (let i = 0; i < 2; i += 1) {
    try {
      const quote = await getSymbolQuote({
        accountId,
        symbol,
        side,
        fast: true,
      });
      const price = toFiniteNumber(quote?.price);
      if (price != null && price > 0) return quote;
      lastError = new Error("No live price for symbol");
    } catch (error) {
      lastError = error;
    }
    if (i < 1) await sleep(250);
  }
  const err = new Error(lastError?.message || "Could not fetch live quote");
  err.status = lastError?.status || 404;
  throw err;
}

/**
 * Chart-Scanner-style open for one pair:
 * quote → OpenAI (M30/H1/H4) → sequential placeTrade per TP thread.
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
    const quote = await fetchQuoteFast({
      accountId,
      symbol,
      side: preferredSide || "BUY",
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
    timeframe: ai?.timeframe || "M30",
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

  // Chart Scanner Execute style: open threads in order (never flood MT5).
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
      });
      opened += 1;
      openedTargets.push(thread.target);
      recordTrade({
        botName,
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
    warning: quoteError || aiError || null,
    error: opened > 0 ? lastError || null : lastError || "Open failed",
  };
}

/**
 * Silently open every Your pairs symbol like EA Chart Scanner Execute.
 * Pairs run one after another so quote/OpenAI/OrderSend stay reliable.
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

  const results = [];
  for (const symbol of pairs) {
    // Sequential — same reliability as tapping Execute on EA Chart per pair.
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
  }

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
    timeframe: primary?.timeframe,
    error: lastError,
  };
}
