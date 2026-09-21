import { normalizeBrokerSymbol } from "./brokerSymbol.js";

const STORAGE_KEY = "apexea-trade-history-v2";
const LEGACY_KEY = "apexea-daily-trades-v1";
const MAX_TRADES = 200;

function normalizeSide(value) {
  const raw = String(value || "TRADE").trim().toUpperCase();
  if (raw === "BUY" || raw === "SELL") return raw;
  if (raw.includes("BUY")) return "BUY";
  if (raw.includes("SELL")) return "SELL";
  return raw || "TRADE";
}

function normalizeTrade(row = {}) {
  const at = Number(row?.at) || 0;
  if (!at) return null;
  const entry = Number(row.entry);
  const takeProfit = Number(row.takeProfit ?? row.tp);
  const stopLoss = Number(row.stopLoss ?? row.sl);
  return {
    id: String(row?.id || `${at}-${row?.symbol || ""}`),
    at,
    botName: String(row?.botName || "Bot").trim() || "Bot",
    symbol: normalizeBrokerSymbol(row?.symbol || "").replace(/[-–—]+$/g, "") || "—",
    lotSize: Number(row?.lotSize) > 0 ? Number(row.lotSize) : 0.01,
    action: normalizeSide(row?.action || row?.side),
    comment: String(row?.comment || "").trim(),
    entry: Number.isFinite(entry) && entry > 0 ? entry : null,
    takeProfit: Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : null,
    stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null,
    target: String(row?.target || "").trim().toUpperCase(),
  };
}

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (raw && typeof raw === "object" && Array.isArray(raw.trades)) {
      return raw.trades.map(normalizeTrade).filter(Boolean);
    }
  } catch {
    // fall through to legacy
  }

  // Migrate old daily history once (no longer wipe at midnight).
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    const trades = Array.isArray(legacy?.trades)
      ? legacy.trades.map(normalizeTrade).filter(Boolean)
      : [];
    if (trades.length) {
      writeStore(trades);
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // ignore
      }
      return trades;
    }
  } catch {
    // ignore
  }
  return [];
}

function writeStore(trades) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ trades: (trades || []).slice(0, MAX_TRADES) })
    );
  } catch {
    // ignore quota
  }
}

/** All saved taken trades — persists across days until cleared. */
export function loadTradeHistory() {
  return readStore().sort((a, b) => b.at - a.at);
}

/** @deprecated use loadTradeHistory — kept for older imports */
export function loadTodayTrades() {
  return loadTradeHistory();
}

export function recordTrade(details = {}) {
  const trades = readStore();
  const entry = normalizeTrade({
    id: `${Date.now()}-${String(details.symbol || "SYM")}-${Math.random()
      .toString(36)
      .slice(2, 7)}`,
    at: Number(details.at) || Date.now(),
    botName: details.botName,
    symbol: details.symbol,
    lotSize: details.lotSize,
    action: details.action || details.side,
    comment: details.comment,
    entry: details.entry,
    takeProfit: details.takeProfit ?? details.tp,
    stopLoss: details.stopLoss ?? details.sl,
    target: details.target,
  });
  if (!entry) return loadTradeHistory();

  const dup = trades.some(
    (row) =>
      Math.abs(Number(row.at) - entry.at) < 1500 &&
      row.symbol === entry.symbol &&
      row.action === entry.action &&
      Number(row.lotSize) === entry.lotSize &&
      String(row.target || "") === String(entry.target || "")
  );
  if (dup) return loadTradeHistory();

  trades.unshift(entry);
  writeStore(trades);
  return loadTradeHistory();
}

/** @deprecated use recordTrade */
export function recordTodayTrade(details = {}) {
  return recordTrade(details);
}

export function clearTradeHistory() {
  writeStore([]);
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
  return [];
}

export function formatRelativeTradeTime(at, now = Date.now()) {
  const ms = Math.max(0, now - Number(at || 0));
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function formatPrice(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Math.abs(n) >= 100) return n.toFixed(2).replace(/\.?0+$/, "") || String(n);
  return String(n);
}

/** Plain-text copy format (one trade per line). */
export function formatTradeHistoryLines(trades = []) {
  if (!trades.length) {
    return "No trades taken yet.";
  }
  return trades
    .map((row) => {
      const side = normalizeSide(row.action);
      const age = formatRelativeTradeTime(row.at);
      const levels = [
        row.entry != null ? `E ${formatPrice(row.entry)}` : null,
        row.takeProfit != null ? `TP ${formatPrice(row.takeProfit)}` : null,
        row.stopLoss != null ? `SL ${formatPrice(row.stopLoss)}` : null,
      ]
        .filter(Boolean)
        .join("  ");
      return levels
        ? `${row.symbol} ${side} · ${levels} · ${age}`
        : `${row.symbol} was a ${side} · ${age}`;
    })
    .join("\n");
}

export { formatPrice as formatHistoryPrice };
