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

const MIN_CHART_CONFIDENCE = 68;
const MIN_SYMBOL_CONFIDENCE = 70;

function buildNoChartResult() {
  return {
    status: "no_chart",
    isChart: false,
    symbol: null,
    message: "No trading chart detected",
    uiMessage: "Please upload a clear trading chart.",
    chartConfidence: 0,
    symbolConfidence: 0,
    source: "openai",
  };
}

function buildSymbolUnclearResult(chartConfidence = 0) {
  return {
    status: "symbol_unclear",
    isChart: true,
    symbol: null,
    message: "Chart detected — symbol unclear",
    uiMessage: "Chart detected — symbol unclear",
    chartConfidence,
    symbolConfidence: 0,
    source: "openai",
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

function normalizeAnalysis(parsed = {}) {
  const chartConfidence = Math.max(
    0,
    Math.min(100, Number(parsed?.chartConfidence ?? parsed?.confidence) || 0)
  );
  const symbolConfidence = Math.max(
    0,
    Math.min(100, Number(parsed?.symbolConfidence) || 0)
  );
  const isChart =
    parsed?.isChart === true &&
    chartConfidence >= MIN_CHART_CONFIDENCE &&
    parsed?.status !== "no_chart";

  if (!isChart) {
    return buildNoChartResult();
  }

  const rawSymbol = normalizeSymbol(parsed?.symbol || "");
  const confidentSymbol =
    parsed?.status === "symbol_detected" &&
    rawSymbol &&
    symbolConfidence >= MIN_SYMBOL_CONFIDENCE;

  if (!confidentSymbol) {
    return buildSymbolUnclearResult(chartConfidence);
  }

  return {
    status: "symbol_detected",
    isChart: true,
    symbol: rawSymbol,
    message: `Symbol detected: ${rawSymbol}`,
    uiMessage: rawSymbol,
    chartConfidence,
    symbolConfidence,
    source: "openai",
  };
}

export async function detectSymbolWithOpenAI({ image, catalog = [] } = {}) {
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
      max_tokens: 180,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict trading-chart image analyzer. Return JSON only with this schema: " +
            '{"isChart":boolean,"chartConfidence":0-100,"symbol":string|null,"symbolConfidence":0-100,"status":"no_chart"|"symbol_detected"|"symbol_unclear"}. ' +
            "Set isChart=true ONLY when the image clearly shows a genuine financial trading chart (MetaTrader, TradingView, cTrader, etc.) " +
            "with visible chart structure: candlesticks or OHLC bars, price movement, price/time axes, gridlines, and a trading-platform layout. " +
            "Do NOT treat photographs, people, buildings, cars, landscapes, random screenshots, websites, documents, or plain text/numbers as charts. " +
            "Text resembling a symbol (e.g. EURUSD) is NEVER enough for isChart=true without clear chart visuals. " +
            "If isChart=false, set status=no_chart, symbol=null, symbolConfidence=0. " +
            "If isChart=true but the instrument label is not clearly visible on the chart, set status=symbol_unclear and symbol=null. " +
            "Only set status=symbol_detected when the instrument is clearly readable on the chart header/title/tab " +
            "(e.g. EURUSD, XAUUSD, BTCUSD, NAS100, US30, GBPJPY). Read the exact visible characters — " +
            "do not substitute a popular pair (never invent EURUSD/XAUUSD/BTCUSD when the header shows something else). " +
            "NEVER guess a symbol from chart shape, price scale, or a known-symbols list. When uncertain, use symbol_unclear. " +
            "Keep broker suffixes when clearly visible (e.g. EURUSD.m).",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Analyze this screenshot. First decide if it is a real trading chart. " +
                "Only if it is, OCR-read the instrument symbol from the chart header/title/tab exactly as shown. " +
                "Do not guess. If the label is blurry or missing, return symbol_unclear." +
                (catalogHint
                  ? ` After reading, you may map an exact match onto this catalog (do not pick from it blindly): ${catalogHint}.`
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
    parsed = { isChart: false, status: "no_chart", symbol: null, symbolConfidence: 0 };
  }

  const result = normalizeAnalysis(parsed);
  if (result.status === "symbol_detected" && result.symbol) {
    result.symbol = resolveCatalogSymbol(result.symbol, catalog);
    result.message = `Symbol detected: ${result.symbol}`;
    result.uiMessage = result.symbol;
  }

  return result;
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
    const result = await detectSymbolWithOpenAI({
      image: body.image,
      catalog: body.catalog,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Chart analysis failed",
      details: error.data || null,
    });
  }
}

export const config = { maxDuration: 30 };
