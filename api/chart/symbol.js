import { applyCorsHeaders, endOptions } from "../_cors.js";
import {
  normalizeBrokerSymbol,
  resolveCatalogSymbol,
  symbolCore,
} from "../_symbolResolve.js";
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

/** Normalize broker header text into a tradeable symbol token.
 * Keeps leading/trailing broker dots (e.g. .DE30. / .US30Cash).
 */
function normalizeSymbol(raw) {
  return normalizeBrokerSymbol(raw);
}

function symbolBase(raw) {
  return symbolCore(raw);
}

function looksLikeTradingSymbol(raw) {
  const s = normalizeSymbol(raw);
  if (!s || s.length < 2 || s.length > 32) return false;
  const base = symbolBase(s);
  if (!base || base.length < 2) return false;
  // Must include a letter; reject pure numbers / prices.
  if (!/[A-Z]/.test(base)) return false;
  return /^\.?[A-Z][A-Z0-9.]*\.?$/.test(s);
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

// Phone MT screenshots are noisy — keep thresholds permissive so real headers pass.
const MIN_CHART_CONFIDENCE = 50;
const MIN_SYMBOL_CONFIDENCE = 45;

function buildNoChartResult() {
  return {
    status: "no_chart",
    isChart: false,
    symbol: null,
    suggestedSymbol: null,
    message: "No trading chart detected",
    uiMessage: "Please upload a clear trading chart.",
    chartConfidence: 0,
    symbolConfidence: 0,
    source: "openai",
  };
}

function buildSymbolUnclearResult(chartConfidence = 0, suggestedSymbol = null) {
  return {
    status: "symbol_unclear",
    isChart: true,
    symbol: null,
    suggestedSymbol: suggestedSymbol || null,
    message: "Chart detected — symbol unclear",
    uiMessage: "Chart detected — symbol unclear",
    chartConfidence,
    symbolConfidence: 0,
    source: "openai",
  };
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
  const plausible = looksLikeTradingSymbol(rawSymbol);
  const confidentSymbol =
    plausible &&
    (parsed?.status === "symbol_detected" || symbolConfidence >= MIN_SYMBOL_CONFIDENCE) &&
    symbolConfidence >= MIN_SYMBOL_CONFIDENCE;

  // Also accept a clear OCR string even if the model under-scored confidence slightly.
  const softAccept =
    plausible &&
    rawSymbol.length >= 3 &&
    symbolConfidence >= 35 &&
    parsed?.status !== "symbol_unclear";

  if (confidentSymbol || softAccept) {
    return {
      status: "symbol_detected",
      isChart: true,
      symbol: rawSymbol,
      suggestedSymbol: rawSymbol,
      message: `Symbol detected: ${rawSymbol}`,
      uiMessage: rawSymbol,
      chartConfidence,
      symbolConfidence: Math.max(symbolConfidence, MIN_SYMBOL_CONFIDENCE),
      source: "openai",
    };
  }

  return buildSymbolUnclearResult(
    chartConfidence,
    plausible ? rawSymbol : null
  );
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
      max_tokens: 220,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a trading-chart OCR engine for MetaTrader, TradingView, and cTrader screenshots (phone or desktop). Return JSON only: " +
            '{"isChart":boolean,"chartConfidence":0-100,"symbol":string|null,"symbolConfidence":0-100,"status":"no_chart"|"symbol_detected"|"symbol_unclear","description":string|null}. ' +
            "Set isChart=true when candlesticks/bars, a price axis, and a trading-platform layout are visible — including mobile MetaTrader, " +
            "shared WhatsApp/Telegram screenshots, and nested chart previews. Candle colors may be green/red/purple/blue/any. " +
            "Do NOT treat photos of people, cars, buildings, or landscapes as charts. " +
            "If isChart=false → status=no_chart, symbol=null, symbolConfidence=0. " +
            "If isChart=true → OCR the instrument from the chart HEADER / TITLE / TAB / SYMBOL ROW EXACTLY as shown — " +
            "copy every character including broker dots (examples: .DE30. , .US30Cash , EURUSD.m , NAS100). " +
            "Also read the description line under the ticker when present (e.g. 'German 40 Index', 'Wall Street 30') into description. " +
            "Use the ticker code as symbol (not the long description). " +
            "Detect ANY shared instrument: forex, metals, indices, stocks, crypto, oil, CFDs, synthetics. " +
            "Do NOT strip leading/trailing broker dots. Do NOT rename .DE30. to GER40 or US30. " +
            "The catalog is NOT a multiple-choice list — never pick a popular pair just because it is listed. " +
            "NEVER invent EURUSD/XAUUSD/BTCUSD/US30 when the header shows something else. " +
            "Use symbol_unclear ONLY when header text is truly unreadable. Prefer symbol_detected whenever any instrument text is visible.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Is this a trading chart screenshot? If yes, OCR-read the EXACT instrument ticker from the header/tab " +
                "(keep broker dots like .DE30.) and the short description under it if shown. Do not guess from the catalog." +
                (catalogHint
                  ? ` Optional exact-match catalog (mapping only, never choose blindly): ${catalogHint}.`
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
    result.suggestedSymbol = result.symbol;
    result.message = `Symbol detected: ${result.symbol}`;
    result.uiMessage = result.symbol;
  } else if (result.suggestedSymbol) {
    result.suggestedSymbol = resolveCatalogSymbol(result.suggestedSymbol, catalog);
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
