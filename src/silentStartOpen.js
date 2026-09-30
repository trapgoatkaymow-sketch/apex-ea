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
import { buildSafeMultiTpLevels, normalizeTradeSide } from "./tradeLevels.js";

/** Delay after START before the silent open runs. */
export const START_SILENT_OPEN_DELAY_MS = 20_000;

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

function clampTrades(value) {
  const n = Math.floor(Number(value) || 1);
  return Math.min(20, Math.max(1, n));
}

function clampLot(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  return Number(Math.min(1000, n).toFixed(4));
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

/** Pick the selected / first pair on this EA. */
export function pickSelectedSymbol(activeBot, eas = []) {
  const botId = String(activeBot?.id || "").trim();
  const ea = (Array.isArray(eas) ? eas : []).find(
    (row) => String(row?.id || "").trim() === botId
  );
  const fromClient = Array.isArray(ea?.clientSymbols) ? ea.clientSymbols : [];
  const fromBot = Array.isArray(activeBot?.symbols) ? activeBot.symbols : [];
  const list = (fromClient.length ? fromClient : fromBot)
    .map((s) => normalizeBrokerSymbol(s))
    .filter(Boolean);
  return list[0] || "";
}

function buildSetup(symbol, preferredSide = "BUY") {
  const side = normalizeTradeSide(preferredSide, { trustSide: true });
  const entry = estimateEntryForSymbol(symbol);
  return {
    symbol,
    detectedSymbol: symbol,
    side,
    ...buildSafeMultiTpLevels({
      symbol,
      side,
      entry,
      timeframe: "M15",
    }),
    source: "silent-start",
  };
}

/**
 * Silently open TP threads for the selected symbol (no Chart Scanner UI).
 * @returns {Promise<{ ok: boolean, symbol?: string, opened?: number, error?: string }>}
 */
export async function runSilentStartOpen({
  activeBot,
  eas,
  mt5Session,
  getSymbolMeta,
  publishOrbTrade,
  variant = "zeta",
} = {}) {
  const accountId = String(mt5Session?.accountId || "").trim();
  if (!accountId) {
    return { ok: false, error: "Connect MetaTrader before START open" };
  }

  const symbol = pickSelectedSymbol(activeBot, eas);
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
  const tradeCount = clampTrades(meta.trades);
  const lot = clampLot(meta.lotSize);
  const signal = buildSetup(symbol, side);

  const threads = [];
  for (let i = 0; i < tradeCount; i += 1) {
    const { target, takeProfitKey, tradeNo } = targetForTradeIndex(i);
    const takeProfit = Number(signal?.[takeProfitKey]);
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) continue;
    threads.push({ target, takeProfit, tradeNo, volume: lot });
  }
  if (!threads.length) {
    return { ok: false, error: "Could not build TP threads for this symbol" };
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
    symbol,
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
  for (const thread of threads) {
    try {
      const fill = await placeTrade({
        accountId,
        symbol,
        volume: thread.volume,
        side: signal.side,
        stopLoss: signal.stopLoss,
        takeProfit: thread.takeProfit,
        region: mt5Session?.region || "",
        comment,
        source: "chart-scanner",
      });
      opened += 1;
      recordTrade({
        botName: activeBot?.name || "Bot",
        symbol: normalizeBrokerSymbol(fill?.symbol || symbol) || symbol,
        lotSize: thread.volume,
        action: signal.side,
        side: signal.side,
        comment,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: thread.takeProfit,
        target: thread.target,
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
    side: signal.side,
    error: lastError || null,
  };
}
