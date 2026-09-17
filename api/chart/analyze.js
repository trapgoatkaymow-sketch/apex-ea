import { applyCorsHeaders, endOptions } from "../_cors.js";
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
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[\/_\-]/g, "")
    .replace(/[^A-Z0-9.]/g, "");
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

const MIN_CHART_CONFIDENCE = 72;

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
 */
function ensureMultiTpLevels({ side, entry, stopLoss }) {
  const dir = String(side || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
  let e = toFiniteNumber(entry);
  let sl = toFiniteNumber(stopLoss);

  if (e == null) e = 1;
  const riskMag = Math.max(
    Math.abs(e) * 0.0025,
    e >= 1000 ? 3 : e >= 100 ? 1 : e >= 10 ? 0.05 : 0.0015
  );

  if (dir === "BUY") {
    if (sl == null || !(sl < e)) sl = e - riskMag;
  } else if (sl == null || !(sl > e)) {
    sl = e + riskMag;
  }

  const risk = Math.abs(e - sl);
  const tp1 = dir === "BUY" ? e + risk * 1 : e - risk * 1;
  const tp2 = dir === "BUY" ? e + risk * 2 : e - risk * 2;
  const tp3 = dir === "BUY" ? e + risk * 3 : e - risk * 3;

  return {
    side: dir,
    entry: formatPrice(e),
    stopLoss: formatPrice(sl),
    takeProfit1: formatPrice(tp1),
    takeProfit2: formatPrice(tp2),
    takeProfit3: formatPrice(tp3),
    takeProfit: formatPrice(tp3),
  };
}

function resolveCatalogSymbol(symbol, catalog = []) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return "";
  const base = normalized.split(".")[0];
  const catalogHit = (Array.isArray(catalog) ? catalog : []).find(
    (item) => normalizeSymbol(item).split(".")[0] === base
  );
  return catalogHit ? normalizeSymbol(catalogHit) : normalized;
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
    side: parsed?.side || parsed?.direction,
    entry: parsed?.entry ?? parsed?.entryPrice,
    stopLoss: parsed?.stopLoss ?? parsed?.sl,
    takeProfit1: parsed?.takeProfit1 ?? parsed?.tp1,
    takeProfit2: parsed?.takeProfit2 ?? parsed?.tp2,
    takeProfit3: parsed?.takeProfit3 ?? parsed?.tp3,
    takeProfit: parsed?.takeProfit ?? parsed?.tp,
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
      max_tokens: 520,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict trading-chart analyst. Return JSON only with schema: " +
            '{"isChart":boolean,"chartConfidence":0-100,"status":"no_chart"|"setup_ready",' +
            '"symbol":string|null,"side":"BUY"|"SELL","confidence":0-100,' +
            '"entry":number,"stopLoss":number,' +
            '"takeProfit1":number,"takeProfit2":number,"takeProfit3":number,' +
            '"riskReward":string,"timeframe":string,"analysis":string,"reasons":string[]}. ' +
            "FIRST decide if the image is a genuine financial trading chart " +
            "(candlesticks/OHLC, price axis, grid, trading platform layout). " +
            "Photographs, people, buildings, cars, landscapes, websites, and random screenshots are NOT charts. " +
            "Text resembling a symbol alone is NOT a chart. " +
            "If not a chart: status=no_chart, isChart=false, and leave trade fields null. " +
            "If it IS a chart: ALWAYS return a COMPLETE trade setup with THREE take-profit levels. NEVER say incomplete. " +
            "ALWAYS provide side, confidence, entry, stopLoss, takeProfit1, takeProfit2, takeProfit3, riskReward, timeframe, and analysis. " +
            "Set take-profit targets using fixed risk/reward multiples of the stop distance: " +
            "TP1 = 1:1, TP2 = 1:2, TP3 = 1:3. Set riskReward to \"1:1 · 1:2 · 1:3\". " +
            "Read entry and stop from chart structure (support/resistance, swings). " +
            "BUY must satisfy: stopLoss < entry < takeProfit1 < takeProfit2 < takeProfit3. " +
            "SELL must satisfy: stopLoss > entry > takeProfit1 > takeProfit2 > takeProfit3. " +
            "Read the instrument from the chart header/title/tab when visible — OCR the exact characters. " +
            "NEVER invent a popular pair (EURUSD/XAUUSD/BTCUSD) when the header shows a different symbol. " +
            "If a symbol hint is provided and it matches the chart, keep it; otherwise prefer the visible header text. " +
            "If the setup is imperfect, still choose the strongest available BUY or SELL and compute reasonable multi-TP levels. " +
            "Do not omit Entry, SL, TP1, TP2, or TP3 for a valid chart.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Validate whether this is a trading chart. If yes, generate a complete trade setup with Entry, SL, TP1, TP2, and TP3. " +
                "Read the symbol from the chart header exactly — do not guess from the catalog." +
                (hintSymbol
                  ? ` Prefer this already-detected symbol if it matches the chart: ${normalizeSymbol(hintSymbol)}.`
                  : "") +
                (catalogHint
                  ? ` Catalog for exact-match mapping only: ${catalogHint}.`
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
