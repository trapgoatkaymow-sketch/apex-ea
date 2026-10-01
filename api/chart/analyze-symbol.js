/**
 * OpenAI symbol scan for silent START — same engine as Chart Scanner,
 * without requiring a screenshot. Timeframes: M30 / H1 / H4.
 *
 * Ladder matches Chart Scanner:
 *   H4 → TP1 1:1 · TP2 1:2 · TP3 1:3
 *   M30/H1 → TP1 1:2 · TP2 1:3 · TP3 1:4
 */
import { applyCorsHeaders, endOptions } from "../_cors.js";
import { normalizeBrokerSymbol } from "../_symbolResolve.js";
import {
  buildSafeMultiTpLevels,
  normalizeChartTimeframe,
  normalizeTradeSide,
  tpRiskRewardLabel,
} from "../_tradeLevels.js";

const DEFAULT_TIMEFRAMES = ["M30", "H1", "H4"];

function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function requireOpenAiKey() {
  const key = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
  if (!key) {
    const err = new Error(
      "OpenAI is not configured. Add OPENAI_API_KEY on Vercel to analyze symbols."
    );
    err.status = 503;
    throw err;
  }
  return key;
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null || value === "") return null;
  const cleaned = String(value).replace(/,/g, "").replace(/[^\d.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function analyzeSymbolSetupWithOpenAI({
  symbol = "",
  price = null,
  timeframes = DEFAULT_TIMEFRAMES,
  preferredSide = "",
} = {}) {
  const apiKey = requireOpenAiKey();
  const sym = normalizeBrokerSymbol(symbol) || String(symbol || "").trim();
  const live = toFiniteNumber(price);
  if (!sym) {
    const err = new Error("Symbol is required");
    err.status = 400;
    throw err;
  }
  if (live == null || live <= 0) {
    const err = new Error("Live price is required for symbol scan");
    err.status = 400;
    throw err;
  }

  const tfList = (Array.isArray(timeframes) ? timeframes : DEFAULT_TIMEFRAMES)
    .map((t) => normalizeChartTimeframe(t))
    .filter(Boolean);
  const tfs = tfList.length ? tfList : [...DEFAULT_TIMEFRAMES];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a MetaTrader market analyst (same role as Apex EA Chart Scanner). Return JSON only: " +
            '{"side":"BUY"|"SELL","confidence":0-100,"timeframe":"M30"|"H1"|"H4",' +
            '"stopLoss":number,"analysis":string}. ' +
            "START always trades M30 + H1 + H4 together. Decide BUY or SELL from confluence across ALL three " +
            "(M30, H1, and H4 structure / bias) — not a single lower timeframe alone. " +
            "Do NOT default to BUY or SELL — pick the side the three timeframes support. " +
            "stopLoss must be a realistic protective stop FAR enough from entry for the instrument " +
            "(XAUUSD ≥ ~$3–$8, FX ≥ ~15 pips, US30/NAS100 ≥ ~25 points). " +
            "BUY: stopLoss MUST be below entry. SELL: stopLoss MUST be above entry. " +
            "timeframe = the strongest of M30/H1/H4 that supports the side. analysis: one short sentence citing M30/H1/H4.",
        },
        {
          role: "user",
          content:
            `Symbol: ${sym}. Live price: ${live}. ` +
            `Required timeframes (use all): ${tfs.join(", ")}. ` +
            (preferredSide
              ? `Client pair preference (soft): ${preferredSide}. Prefer multi-TF chart logic over preference. `
              : "") +
            "Return side from M30+H1+H4 confluence, stopLoss, primary timeframe (M30/H1/H4), confidence, analysis.",
        },
      ],
    }),
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { error: raw };
  }
  if (!response.ok) {
    const message =
      data?.error?.message || data?.message || `OpenAI error ${response.status}`;
    const err = new Error(message);
    err.status =
      response.status >= 400 && response.status < 600 ? response.status : 502;
    err.data = data;
    throw err;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
  } catch {
    parsed = {};
  }

  const side = normalizeTradeSide(parsed?.side || preferredSide || "BUY", {
    trustSide: true,
  });
  const timeframe = normalizeChartTimeframe(parsed?.timeframe || "M30");
  const tf = ["M30", "H1", "H4"].includes(timeframe) ? timeframe : "M30";
  // Chart Scanner ladder: H4 → 1:1/1:2/1:3 · M30/H1 → 1:2/1:3/1:4
  // trustSide keeps AI BUY/SELL; wrong-side SL is repaired (not flipped to SELL).
  const levels = buildSafeMultiTpLevels({
    symbol: sym,
    side,
    entry: live,
    stopLoss: parsed?.stopLoss,
    timeframe: tf,
    trustSide: true,
  });

  return {
    status: "setup_ready",
    isChart: true,
    symbol: sym,
    side: levels.side,
    confidence: Math.max(
      55,
      Math.min(95, Math.round(Number(parsed?.confidence) || 70))
    ),
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit1: levels.takeProfit1,
    takeProfit2: levels.takeProfit2,
    takeProfit3: levels.takeProfit3,
    takeProfit: levels.takeProfit3,
    riskReward: levels.riskReward || tpRiskRewardLabel(tf),
    timeframe: tf,
    analysis: String(parsed?.analysis || `${levels.side} ${sym} setup`).trim(),
    source: "openai-symbol",
    message: `${levels.side} ${sym} ready`,
    uiMessage: "Silent START OpenAI scan ready",
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const result = await analyzeSymbolSetupWithOpenAI({
      symbol: body.symbol || body.hintSymbol || "",
      price: body.price ?? body.entry ?? null,
      timeframes: body.timeframes || DEFAULT_TIMEFRAMES,
      preferredSide: body.side || body.action || "",
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Symbol analysis failed",
      details: error.data || null,
    });
  }
}

export const config = { maxDuration: 30 };
