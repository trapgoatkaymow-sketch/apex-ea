/**
 * Silent START → open: after a short delay, build a setup for the selected
 * symbol and place TP threads on MetaTrader without showing Chart Scanner UI.
 */
import { normalizeBrokerSymbol } from "./brokerSymbol.js";
import { recordTrade } from "./dailyTradeHistory.js";
import {
  buildScannerFillComment,
  placeTrade,
} from "./metaApi.js";
import { consumeScan, loadScansLeft } from "./scanQuota.js";
import {
  buildSafeMultiTpLevels,
  normalizeTradeSide,
} from "./tradeLevels.js";

/** Delay after START before the silent open runs. */
export const START_SILENT_OPEN_DELAY_MS = 20_000;

/** Scanner timeframes used by the START button open. */
export const START_SCANNER_TIMEFRAMES = ["M15", "M30", "H1"];

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
    [/^(XAU|GOLD)/, 2650],
    [/^(XAG|SILVER)/, 31],
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

function clampLot(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  return Number(Math.min(1000, n).toFixed(4));
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

/** Build a scanner-style setup for one START timeframe (M15 / M30 / H1). */
function buildSetup(symbol, preferredSide = "BUY", timeframe = "M15") {
  const side = normalizeTradeSide(preferredSide, { trustSide: true });
  const entry = estimateEntryForSymbol(symbol);
  const levels = buildSafeMultiTpLevels({
    symbol,
    side,
    entry,
    timeframe,
  });
  return {
    symbol,
    detectedSymbol: symbol,
    side,
    timeframe,
    ...levels,
    source: "silent-start",
  };
}

/**
 * One open thread per scanner timeframe: M15 → TP1, M30 → TP2, H1 → TP3.
 * Matches Chart Scanner thread mapping while covering the three START TFs.
 */
function buildTimeframeThreads({ symbol, side, lot }) {
  const map = [
    { timeframe: "M15", target: "TP1", takeProfitKey: "takeProfit1", tradeNo: 1 },
    { timeframe: "M30", target: "TP2", takeProfitKey: "takeProfit2", tradeNo: 2 },
    { timeframe: "H1", target: "TP3", takeProfitKey: "takeProfit3", tradeNo: 3 },
  ];
  const threads = [];
  for (const row of map) {
    const signal = buildSetup(symbol, side, row.timeframe);
    const takeProfit = Number(signal?.[row.takeProfitKey]);
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) continue;
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
  const side =
    actionRaw === "SELL" ? "SELL" : actionRaw === "BUY" ? "BUY" : "BUY";
  const lot = clampLot(meta.lotSize);
  // START always uses scanner M15 + M30 + H1 (not a single hardcoded TF).
  const threads = buildTimeframeThreads({ symbol, side, lot });
  if (!threads.length) {
    return { ok: false, error: "Could not build M15/M30/H1 scanner threads" };
  }

  consumeScan(variant);

  const comment = buildScannerFillComment({
    botName: activeBot?.name,
    variant: "default",
    premium: false,
  });

  const primary = threads[0];
  publishOrbTrade?.({
    botName: activeBot?.name || "Bot",
    comment,
    symbol,
    lotSize: lot,
    action: primary.side,
    side: primary.side,
    entry: primary.entry,
    stopLoss: primary.stopLoss,
    takeProfit: primary.takeProfit,
    target: primary.target,
  });

  let opened = 0;
  let lastError = "";
  const openedTfs = [];
  for (const thread of threads) {
    try {
      const fill = await placeTrade({
        accountId,
        symbol,
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
      recordTrade({
        botName: activeBot?.name || "Bot",
        symbol: normalizeBrokerSymbol(fill?.symbol || symbol) || symbol,
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
    return { ok: false, symbol, opened: 0, error: lastError || "Open failed" };
  }
  return {
    ok: true,
    symbol,
    opened,
    side: primary.side,
    timeframes: openedTfs,
    error: lastError || null,
  };
}
