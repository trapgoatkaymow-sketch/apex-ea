/**
 * Configurable trade-management settings for multi-TP execution.
 * Defaults: TP1 30% · TP2 30% · TP3 40%
 * Stored in localStorage so they can be changed without code edits.
 *
 * SL→BE after TP1 and Protect after TP2 are always on.
 */

import { tpRiskRewardLabel } from "./tradeLevels.js";

const STORAGE_KEY = "apexea-trade-management";

export const DEFAULT_TRADE_MANAGEMENT = {
  /** Fraction of total volume closed at each TP (must sum to ~1). */
  tp1ClosePercent: 30,
  tp2ClosePercent: 30,
  tp3ClosePercent: 40,
  /** Always enabled — remaining legs move SL to breakeven after TP1. */
  moveSlToBreakevenAfterTp1: true,
  /** Always enabled — remaining legs protect profit after TP2. */
  protectProfitAfterTp2: true,
  /** Minimum lot size when splitting legs. */
  minLot: 0.01,
};

export function normalizeTradeManagement(raw = {}) {
  const tp1 = Math.max(0, Math.min(100, Number(raw.tp1ClosePercent) || DEFAULT_TRADE_MANAGEMENT.tp1ClosePercent));
  const tp2 = Math.max(0, Math.min(100, Number(raw.tp2ClosePercent) || DEFAULT_TRADE_MANAGEMENT.tp2ClosePercent));
  let tp3 = Math.max(0, Math.min(100, Number(raw.tp3ClosePercent) || DEFAULT_TRADE_MANAGEMENT.tp3ClosePercent));
  const sum = tp1 + tp2 + tp3;
  if (sum <= 0) {
    return { ...DEFAULT_TRADE_MANAGEMENT };
  }
  // Keep relative weights but ensure they sum to 100 for display.
  if (Math.abs(sum - 100) > 0.5) {
    const scale = 100 / sum;
    return {
      tp1ClosePercent: Math.round(tp1 * scale),
      tp2ClosePercent: Math.round(tp2 * scale),
      tp3ClosePercent: Math.max(
        0,
        100 - Math.round(tp1 * scale) - Math.round(tp2 * scale)
      ),
      moveSlToBreakevenAfterTp1: true,
      protectProfitAfterTp2: true,
      minLot: Math.max(0.01, Number(raw.minLot) || 0.01),
    };
  }
  return {
    tp1ClosePercent: tp1,
    tp2ClosePercent: tp2,
    tp3ClosePercent: tp3,
    moveSlToBreakevenAfterTp1: true,
    protectProfitAfterTp2: true,
    minLot: Math.max(0.01, Number(raw.minLot) || 0.01),
  };
}

export function loadTradeManagement() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TRADE_MANAGEMENT };
    const normalized = normalizeTradeManagement(JSON.parse(raw));
    // Persist forced protection flags so older stored `false` values do not linger.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // ignore
    }
    return normalized;
  } catch {
    return { ...DEFAULT_TRADE_MANAGEMENT };
  }
}

export function saveTradeManagement(next) {
  const normalized = normalizeTradeManagement(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore
  }
  return normalized;
}

function roundLot(value, minLot = 0.01) {
  const n = Math.max(0, Number(value) || 0);
  const rounded = Math.round(n * 100) / 100;
  if (rounded > 0 && rounded < minLot) return minLot;
  return rounded;
}

/** Max TP threads per Execute / START open (TP1 → TP2 → TP3). */
export const MAX_TP_THREADS = 3;

/** Clamp the "Number of trades" stepper to 1..3. */
export function clampTradeThreadCount(value) {
  const n = Math.floor(Number(value) || 1);
  return Math.min(MAX_TP_THREADS, Math.max(1, n));
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

/**
 * Split TOTAL lot across N threads. Never multiplies risk by thread count.
 * If total is too small for N×minLot, collapse to a single ticket.
 */
export function splitTotalLotAcrossThreads(totalVolume, threadCount, minLot = 0.01) {
  const floor = Math.max(0.01, Number(minLot) || 0.01);
  const total = roundLot(Math.max(floor, Number(totalVolume) || floor), floor);
  const n = Math.max(1, Math.min(MAX_TP_THREADS, Math.floor(Number(threadCount) || 1)));
  if (n === 1 || total < floor * n) {
    return [total];
  }
  const vols = [];
  let allocated = 0;
  for (let i = 0; i < n; i += 1) {
    const isLast = i === n - 1;
    let volume = isLast
      ? roundLot(total - allocated, floor)
      : roundLot(total / n, floor);
    if (!isLast && allocated + volume > total) {
      volume = roundLot(Math.max(0, total - allocated), floor);
    }
    if (volume > 0) {
      vols.push(volume);
      allocated = Math.round((allocated + volume) * 100) / 100;
    }
  }
  if (!vols.length) return [total];
  const sum = vols.reduce((acc, v) => acc + v, 0);
  const drift = Math.round((total - sum) * 100) / 100;
  if (drift !== 0) {
    vols[vols.length - 1] = roundLot(
      Math.max(floor, vols[vols.length - 1] + drift),
      floor
    );
  }
  return vols;
}

/**
 * Build Execute/START threads from a multi-TP signal.
 * `lot` is the TOTAL size for the whole open — split across threads.
 */
export function buildTpThreads({ tradeCount = 1, lot = 0.01, signal = {} } = {}) {
  const count = clampTradeThreadCount(tradeCount);
  const pending = [];
  for (let i = 0; i < count; i += 1) {
    const { target, takeProfitKey, tradeNo } = targetForTradeIndex(i);
    const takeProfit = Number(signal?.[takeProfitKey]);
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) continue;
    pending.push({
      index: i,
      tradeNo,
      target,
      takeProfitKey,
      takeProfit,
      timeframe: target === "TP1" ? "M30" : target === "TP2" ? "H1" : "H4",
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      side: signal.side,
    });
  }
  if (!pending.length) return [];
  const volumes = splitTotalLotAcrossThreads(lot, pending.length);
  // If lot was too small to split, keep a single TP1 thread with full size.
  if (volumes.length === 1 && pending.length > 1) {
    return [
      {
        ...pending[0],
        target: "TP1",
        takeProfitKey: "takeProfit1",
        takeProfit: Number(signal?.takeProfit1) || pending[0].takeProfit,
        volume: volumes[0],
      },
    ];
  }
  return pending.map((row, i) => ({
    ...row,
    volume: volumes[i] ?? volumes[volumes.length - 1],
  }));
}

/**
 * Split total lot across TP1/TP2/TP3 using configured percentages.
 * Returns up to 3 legs: { target: "TP1"|"TP2"|"TP3", volume, takeProfitKey }
 */
export function splitVolumeAcrossTargets(totalVolume, management = DEFAULT_TRADE_MANAGEMENT) {
  const cfg = normalizeTradeManagement(management);
  const total = Math.max(cfg.minLot, Number(totalVolume) || cfg.minLot);
  const weights = [
    { target: "TP1", takeProfitKey: "takeProfit1", pct: cfg.tp1ClosePercent },
    { target: "TP2", takeProfitKey: "takeProfit2", pct: cfg.tp2ClosePercent },
    { target: "TP3", takeProfitKey: "takeProfit3", pct: cfg.tp3ClosePercent },
  ].filter((w) => w.pct > 0);

  if (!weights.length) {
    return [
      {
        target: "TP3",
        takeProfitKey: "takeProfit3",
        volume: roundLot(total, cfg.minLot),
        closePercent: 100,
      },
    ];
  }

  // If total is too small to split into multiple min lots, keep a single TP1 leg
  // (never dump the only ticket onto TP3 — thread 1 must stay TP1).
  if (total < cfg.minLot * Math.min(3, weights.length)) {
    return [
      {
        target: "TP1",
        takeProfitKey: "takeProfit1",
        volume: roundLot(total, cfg.minLot),
        closePercent: 100,
      },
    ];
  }

  const legs = [];
  let allocated = 0;
  weights.forEach((w, index) => {
    const isLast = index === weights.length - 1;
    let volume = isLast
      ? roundLot(total - allocated, cfg.minLot)
      : roundLot((total * w.pct) / 100, cfg.minLot);
    if (!isLast && allocated + volume > total) {
      volume = roundLot(Math.max(0, total - allocated), cfg.minLot);
    }
    if (volume > 0) {
      legs.push({
        target: w.target,
        takeProfitKey: w.takeProfitKey,
        volume,
        closePercent: w.pct,
      });
      allocated = Math.round((allocated + volume) * 100) / 100;
    }
  });

  if (!legs.length) {
    return [
      {
        target: "TP3",
        takeProfitKey: "takeProfit3",
        volume: roundLot(total, cfg.minLot),
        closePercent: 100,
      },
    ];
  }

  // Fix rounding drift on the last leg.
  const sum = legs.reduce((acc, leg) => acc + leg.volume, 0);
  const drift = Math.round((total - sum) * 100) / 100;
  if (drift !== 0) {
    legs[legs.length - 1].volume = roundLot(
      Math.max(cfg.minLot, legs[legs.length - 1].volume + drift),
      cfg.minLot
    );
  }

  return legs;
}

/**
 * Describe post-fill management rules for UI / logging.
 * Actual broker-side SL moves after TP hits depend on MetaTrader/EA support;
 * we encode the intended plan with the split legs (each TP on its own ticket).
 */
export function describeManagementPlan(management = DEFAULT_TRADE_MANAGEMENT, timeframe = "M15") {
  const cfg = normalizeTradeManagement(management);
  return {
    ...cfg,
    summary: `TP targets · ${tpRiskRewardLabel(timeframe)}`,
    breakevenNote: cfg.moveSlToBreakevenAfterTp1
      ? "After TP1, remaining SL moves toward breakeven when supported"
      : "Breakeven move after TP1 disabled",
    protectNote: cfg.protectProfitAfterTp2
      ? "After TP2, remaining SL protects further profit when supported"
      : "Profit protection after TP2 disabled",
  };
}
