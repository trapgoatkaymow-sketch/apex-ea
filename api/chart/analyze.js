import { applyCorsHeaders, endOptions } from "../_cors.js";
import {
  normalizeBrokerSymbol,
  resolveCatalogSymbol,
  symbolCore,
} from "../_symbolResolve.js";
import { buildSafeMultiTpLevels, normalizeTradeSide } from "../_tradeLevels.js";
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

function normalizeSymbol(raw) {
  return normalizeBrokerSymbol(raw);
}

function symbolBase(raw) {
  return symbolCore(raw);
}

function requireOpenAiKey() {
  const key = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
  if (!key) {
    const err = new Error(
      "OpenAI is not configured. Add OPENAI_API_KEY on Vercel to analyze chart images."
    );
    err.status = 503;
    throw err;
  }
  return key;
}

const MIN_CHART_CONFIDENCE = 55;

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatPrice(value, digits = 5) {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  const abs = Math.abs(n);
  let d = digits;
  if (abs >= 1000) d = Math.min(digits, 2);
  else if (abs >= 100) d = Math.min(digits, 3);
  else if (abs >= 10) d = Math.min(digits, 4);
  return Number(n.toFixed(d));
}

function formatRiskReward(entry, stopLoss, takeProfit) {
  const e = toFiniteNumber(entry);
  const sl = toFiniteNumber(stopLoss);
  const tp = toFiniteNumber(takeProfit);
  if (e == null || sl == null || tp == null) return "1:2";
  const risk = Math.abs(e - sl);
  const reward = Math.abs(tp - e);
  if (risk <= 0 || reward <= 0) return "1:2";
  return `1:${(reward / risk).toFixed(1)}`;
}

/**
 * Ensure Entry / SL / TP1 / TP2 / TP3 with fixed R:R targets.
 * TP1 = 1:1 · TP2 = 1:2 · TP3 = 1:3 (reward vs stop distance).
 * BUY:  SL < Entry < TP1 < TP2 < TP3
 * SELL: SL > Entry > TP1 > TP2 > TP3
 * Enforces instrument-class minimum stop distance so levels are not too close.
 */
function ensureMultiTpLevels({ side, entry, stopLoss, symbol = "" }) {
  return buildSafeMultiTpLevels({ side, entry, stopLoss, symbol });
}

function buildNoChartResult() {
  return {
    status: "no_chart",
    isChart: false,
    symbol: null,
    side: null,
    confidence: 0,
    entry: null,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    takeProfit3: null,
    takeProfit: null,
    riskReward: null,
    timeframe: null,
    analysis: null,
    reasons: [],
    message: "No trading chart detected",
    uiMessage: "Please upload a clear trading chart.",
    source: "openai",
  };
}

function normalizeChartArea(raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const x = num(raw.x ?? raw.left);
  const y = num(raw.y ?? raw.top);
  const w = num(raw.w ?? raw.width);
  const h = num(raw.h ?? raw.height);
  if (x == null || y == null || w == null || h == null) return null;
  const clamp = (n) => Math.min(1, Math.max(0, n));
  const cx = clamp(x);
  const cy = clamp(y);
  const cw = clamp(w);
  const ch = clamp(h);
  if (cw < 0.2 || ch < 0.2) return null;
  return {
    x: cx,
    y: cy,
    w: Math.min(cw, 1 - cx),
    h: Math.min(ch, 1 - cy),
  };
}

function normalizeTrendlines(raw) {
  if (!Array.isArray(raw)) return [];
  const clamp = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    return Math.min(1, Math.max(0, v));
  };
  return raw
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const x1 = clamp(row.x1);
      const y1 = clamp(row.y1);
      const x2 = clamp(row.x2);
      const y2 = clamp(row.y2);
      if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
      return {
        x1,
        y1,
        x2,
        y2,
        kind: String(row.kind || row.type || "trend")
          .trim()
          .toLowerCase()
          .slice(0, 16),
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function normalizeStructure(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      if (typeof row === "number") {
        return Number.isFinite(row) ? { price: formatPrice(row), label: "LVL" } : null;
      }
      if (!row || typeof row !== "object") return null;
      const price = formatPrice(row.price ?? row.level);
      if (price == null) return null;
      return {
        price,
        label: String(row.label || row.kind || "LVL")
          .trim()
          .toUpperCase()
          .slice(0, 8),
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function normalizeSetup(parsed = {}, { catalog = [], hintSymbol = "" } = {}) {
  const chartConfidence = Math.max(
    0,
    Math.min(100, Number(parsed?.chartConfidence) || 0)
  );
  const isChart =
    parsed?.isChart === true &&
    chartConfidence >= MIN_CHART_CONFIDENCE &&
    parsed?.status !== "no_chart";

  if (!isChart) return buildNoChartResult();

  let symbol = resolveCatalogSymbol(hintSymbol, catalog);
  if (!symbol) symbol = resolveCatalogSymbol(parsed?.symbol || "", catalog);

  const levels = ensureMultiTpLevels({
    symbol,
    side: normalizeTradeSide(parsed?.side || parsed?.direction, {
      entry: parsed?.entry ?? parsed?.entryPrice,
      stopLoss: parsed?.stopLoss ?? parsed?.sl,
    }),
    entry: parsed?.entry ?? parsed?.entryPrice,
    stopLoss: parsed?.stopLoss ?? parsed?.sl,
  });

  const confidence = Math.max(
    55,
    Math.min(95, Math.round(Number(parsed?.confidence) || 70))
  );

  const timeframe = String(parsed?.timeframe || parsed?.tf || "M15")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "") || "M15";

  const analysis = String(
    parsed?.analysis ||
      parsed?.reason ||
      parsed?.summary ||
      `${levels.side} setup from visible price action`
  ).trim();

  const reasons = Array.isArray(parsed?.reasons)
    ? parsed.reasons.map((r) => String(r)).filter(Boolean).slice(0, 4)
    : [analysis];

  // Fixed R:R ladder: TP1 1:1 · TP2 1:2 · TP3 1:3
  const riskReward = "1:1 · 1:2 · 1:3";

  let priceTop = toFiniteNumber(parsed?.priceTop ?? parsed?.axisTop);
  let priceBottom = toFiniteNumber(parsed?.priceBottom ?? parsed?.axisBottom);
  if (
    priceTop != null &&
    priceBottom != null &&
    priceTop < priceBottom
  ) {
    const swap = priceTop;
    priceTop = priceBottom;
    priceBottom = swap;
  }

  return {
    status: "setup_ready",
    isChart: true,
    symbol: symbol || null,
    side: levels.side,
    confidence,
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit1: levels.takeProfit1,
    takeProfit2: levels.takeProfit2,
    takeProfit3: levels.takeProfit3,
    takeProfit: levels.takeProfit3,
    riskReward,
    timeframe,
    analysis,
    reasons,
    chartConfidence,
    priceTop: priceTop == null ? null : formatPrice(priceTop),
    priceBottom: priceBottom == null ? null : formatPrice(priceBottom),
    chartArea: normalizeChartArea(parsed?.chartArea || parsed?.plotArea),
    trendlines: normalizeTrendlines(parsed?.trendlines),
    structure: normalizeStructure(parsed?.structure || parsed?.levels),
    message: `${levels.side} ${symbol || "setup"} ready`,
    uiMessage: "Trade setup ready — press Execute Trade to send to MetaTrader.",
    source: "openai",
  };
}

export async function analyzeChartSetupWithOpenAI({
  image,
  catalog = [],
  hintSymbol = "",
} = {}) {
  const apiKey = requireOpenAiKey();
  const dataUrl = String(image || "");
  if (!dataUrl.startsWith("data:image/")) {
    const err = new Error("Chart image is required");
    err.status = 400;
    throw err;
  }
  if (dataUrl.length > 2_500_000) {
    const err = new Error("Chart image is too large — capture a tighter screenshot");
    err.status = 413;
    throw err;
  }

  const catalogHint = (Array.isArray(catalog) ? catalog : [])
    .map((s) => normalizeSymbol(s))
    .filter(Boolean)
    .slice(0, 40)
    .join(", ");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a trading-chart analyst for MetaTrader / TradingView / cTrader screenshots. Return JSON only with schema: " +
            '{"isChart":boolean,"chartConfidence":0-100,"status":"no_chart"|"setup_ready",' +
            '"symbol":string|null,"side":"BUY"|"SELL","confidence":0-100,' +
            '"entry":number,"stopLoss":number,' +
            '"takeProfit1":number,"takeProfit2":number,"takeProfit3":number,' +
            '"riskReward":string,"timeframe":string,"analysis":string,"reasons":string[],' +
            '"priceTop":number|null,"priceBottom":number|null,' +
            '"chartArea":{"x":0-1,"y":0-1,"w":0-1,"h":0-1}|null,' +
            '"trendlines":[{"x1":0-1,"y1":0-1,"x2":0-1,"y2":0-1,"kind":"trend"|"support"|"resistance"}],' +
            '"structure":[{"price":number,"label":string}]}. ' +
            "Set isChart=true for phone or desktop trading charts with candlesticks/bars and a price axis " +
            "(including shared chat screenshots and nested chart previews). " +
            "Photographs of people, cars, buildings, or landscapes are NOT charts. " +
            "If not a chart: status=no_chart, isChart=false, and leave trade fields null. " +
            "If it IS a chart: ALWAYS return a COMPLETE trade setup with THREE take-profit levels. NEVER say incomplete. " +
            "ALWAYS provide side, confidence, entry, stopLoss, takeProfit1, takeProfit2, takeProfit3, riskReward, timeframe, and analysis. " +
            "DIRECTION IS CRITICAL — wrong BUY/SELL blows accounts. Decide side ONLY from visible chart structure: " +
            "last candles, break of structure, higher-highs/higher-lows vs lower-highs/lower-lows, and where price sits vs support/resistance. " +
            "Green/blue/cyan/teal candles rising = BUY bias. Red/orange/magenta candles falling = SELL bias. " +
            "Do NOT default to BUY. Do NOT invent direction from the symbol name. Prefer the MOST RECENT right-side price action. " +
            "If bullish and bearish clues conflict, choose the clearer recent impulse and lower confidence. " +
            "Set take-profit targets using fixed risk/reward multiples of the stop distance: " +
            "TP1 = 1:1, TP2 = 1:2, TP3 = 1:3. Set riskReward to \"1:1 · 1:2 · 1:3\". " +
            "Read entry and stop from chart structure (support/resistance, swings). " +
            "Keep stopLoss FAR enough from entry for the instrument — never a few ticks: " +
            "FX ≥ ~15 pips, XAUUSD ≥ ~$1.50, US30/NAS100/DE40 ≥ ~25 points, BTC ≥ ~0.2%. " +
            "BUY must satisfy: stopLoss < entry < takeProfit1 < takeProfit2 < takeProfit3. " +
            "SELL must satisfy: stopLoss > entry > takeProfit1 > takeProfit2 > takeProfit3. " +
            "side must be exactly \"BUY\" or \"SELL\" (never LONG/SHORT). " +
            "OCR the instrument from the chart header/title/tab EXACTLY as shown — keep broker dots AND " +
            "lowercase suffixes (e.g. .DE30. , .US30Cash , EURUSD.m , XAUUSDp , US30). " +
            "Keep suffix letters exactly as on the chart — XAUUSDp must stay XAUUSDp (lowercase p), never XAUUSDP. " +
            "Also use the description line under the ticker when present. " +
            "Do NOT rename .DE30. to GER40/US30. Catalog is NOT multiple choice — never invent EURUSD/XAUUSD/BTCUSD. " +
            "If a symbol hint is provided and it matches the chart, keep it; otherwise prefer the visible header text. " +
            "If the setup is imperfect, still choose the strongest available BUY or SELL and compute reasonable multi-TP levels. " +
            "Do not omit Entry, SL, TP1, TP2, or TP3 for a valid chart. " +
            "For overlay drawing: read the visible right-side price axis extremes into priceTop (highest visible) and priceBottom (lowest visible). " +
            "chartArea is the candlestick plot rectangle as fractions of the full image (0-1), excluding headers/toolbars/price axis when possible. " +
            "trendlines: 1-3 structural diagonals (support/resistance/trend) as normalized image coordinates. " +
            "structure: optional horizontal support/resistance prices visible on the chart. " +
            "analysis must briefly explain the structure (trend, break, bounce) in one sentence.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Validate whether this is a trading chart. If yes, generate a complete trade setup with Entry, SL, TP1, TP2, and TP3, " +
                "plus overlay geometry (priceTop, priceBottom, chartArea, trendlines). " +
                "Choose BUY or SELL carefully from the latest candle structure — do not guess randomly. " +
                "OCR the exact symbol from the chart header (any instrument shown) — keep lowercase " +
                "broker suffixes like XAUUSDp / EURUSDm. Do not guess from the catalog." +
                (hintSymbol
                  ? ` Prefer this already-detected symbol if it matches the chart: ${normalizeSymbol(hintSymbol)}.`
                  : "") +
                (catalogHint
                  ? ` Optional exact-match catalog (mapping only): ${catalogHint}.`
                  : ""),
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl,
                detail: "high",
              },
            },
          ],
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
    err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    err.data = data;
    throw err;
  }

  const content = data?.choices?.[0]?.message?.content || "";
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { isChart: false, status: "no_chart" };
  }

  return normalizeSetup(parsed, { catalog, hintSymbol });
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
    const result = await analyzeChartSetupWithOpenAI({
      image: body.image,
      catalog: body.catalog,
      hintSymbol: body.hintSymbol || body.symbol || "",
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Chart setup analysis failed",
      details: error.data || null,
    });
  }
}

export const config = { maxDuration: 30 };
