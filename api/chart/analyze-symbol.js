/**
 * OpenAI symbol scan for silent START — same TP ladder as Chart Scanner
 * (M15/M30/H1 → TP1 1:2, TP2 1:3, TP3 1:4) without requiring a screenshot.
 */
import { applyCorsHeaders, endOptions } from "../_cors.js";
import { normalizeBrokerSymbol } from "../_symbolResolve.js";
import {
  buildSafeMultiTpLevels,
  normalizeChartTimeframe,
  normalizeTradeSide,
  tpRiskRewardLabel,
} from "../_tradeLevels.js";

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
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function analyzeSymbolSetupWithOpenAI({
  symbol = "",
  price = null,
  timeframes = ["M15", "M30", "H1"],
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

  const tfList = (Array.isArray(timeframes) ? timeframes : ["M15", "M30", "H1"])
    .map((t) => normalizeChartTimeframe(t))
    .filter(Boolean);
  const tfs = tfList.length ? tfList : ["M15", "M30", "H1"];

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
            "You are a MetaTrader market analyst. Return JSON only: " +
            '{"side":"BUY"|"SELL","confidence":0-100,"timeframe":"M15"|"M30"|"H1",' +
            '"stopLoss":number,"analysis":string}. ' +
            "Choose BUY or SELL for the symbol at the live price using typical M15/M30/H1 structure bias. " +
            "Do NOT default to BUY. stopLoss must be a realistic protective stop FAR enough from entry for the instrument " +
            "(XAUUSD ≥ ~$3–$8, FX ≥ ~15 pips, US30/NAS100 ≥ ~25 points). " +
            "BUY: stopLoss < entry. SELL: stopLoss > entry. " +
            "timeframe must be one of M15, M30, H1. analysis: one short sentence why.",
        },
        {
          role: "user",
          content:
            `Symbol: ${sym}. Live price: ${live}. ` +
            `Allowed timeframes: ${tfs.join(", ")}. ` +
            (preferredSide
              ? `Client pair preference (soft): ${preferredSide}. Prefer chart logic over preference. `
              : "") +
            "Return side, stopLoss, timeframe (M15/M30/H1), confidence, analysis.",
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
  const timeframe = normalizeChartTimeframe(parsed?.timeframe || "M15");
  const tf = ["M15", "M30", "H1"].includes(timeframe) ? timeframe : "M15";
  const levels = buildSafeMultiTpLevels({
    symbol: sym,
    side,
    entry: live,
    stopLoss: parsed?.stopLoss,
    // Non-H4 → TP1 1:2, TP2 1:3, TP3 1:4 (same as Chart Scanner).
    timeframe: tf === "H4" ? "M15" : tf,
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
      timeframes: body.timeframes || ["M15", "M30", "H1"],
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
