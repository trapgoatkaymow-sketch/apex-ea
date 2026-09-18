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
  let s = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[\/_\-]/g, "")
    .replace(/[^A-Z0-9.]/g, "");
  s = s.replace(/\.{2,}/g, ".");
  return s;
}

function symbolBase(raw) {
  return normalizeSymbol(raw).replace(/^\.+/, "").replace(/\.+$/, "").split(".")[0];
}

function resolveCatalogSymbol(symbol, catalog = []) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return "";
  const base = symbolBase(normalized);
  const list = Array.isArray(catalog) ? catalog : [];
  const exact = list.find((item) => normalizeSymbol(item) === normalized);
  if (exact) return normalizeSymbol(exact);
  if (/^\./.test(normalized) || /\.$/.test(normalized)) return normalized;
  const baseHit = list.find((item) => symbolBase(item) === base);
  if (baseHit) {
    const catalogNorm = normalizeSymbol(baseHit);
    if (symbolBase(catalogNorm) === base) return catalogNorm;
  }
  return normalized;
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
/** Setups below this confidence stay visible but Execute is discouraged/blocked. */
const MIN_EXECUTE_CONFIDENCE = 70;
const RECOMMENDED_TIMEFRAME = "H1";
const ALLOWED_TIMEFRAMES = new Set([
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
  "1H",
  "4H",
  "15M",
  "30M",
]);
const UNSAFE_TIMEFRAMES = new Set(["M1", "M5", "1M", "5M", "M3", "M2"]);

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeTimeframe(raw) {
  const tf = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^(\d+)(MIN|MINUTE|MINUTES)$/, "$1M")
    .replace(/^(\d+)(HR|HOUR|HOURS)$/, "$1H")
    .replace(/^1H$/, "H1")
    .replace(/^4H$/, "H4")
    .replace(/^15M$/, "M15")
    .replace(/^30M$/, "M30");
  if (!tf) return RECOMMENDED_TIMEFRAME;
  if (UNSAFE_TIMEFRAMES.has(tf)) return RECOMMENDED_TIMEFRAME;
  if (ALLOWED_TIMEFRAMES.has(tf)) {
    if (tf === "1H") return "H1";
    if (tf === "4H") return "H4";
    if (tf === "15M") return "M15";
    if (tf === "30M") return "M30";
    return tf;
  }
  return RECOMMENDED_TIMEFRAME;
}

function minStructuralRisk(entry) {
  const e = Math.abs(toFiniteNumber(entry) || 1);
  // Wider structural stops so tiny scalp SL distances can't blow accounts.
  if (e >= 1000) return Math.max(e * 0.004, 8);
  if (e >= 100) return Math.max(e * 0.0045, 1.8);
  if (e >= 10) return Math.max(e * 0.005, 0.12);
  return Math.max(e * 0.006, 0.004);
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
  const riskMag = minStructuralRisk(e);

  if (dir === "BUY") {
    if (sl == null || !(sl < e)) sl = e - riskMag;
    // Widen stops that are too tight for capital protection.
    if (Math.abs(e - sl) < riskMag) sl = e - riskMag;
  } else {
    if (sl == null || !(sl > e)) sl = e + riskMag;
    if (Math.abs(e - sl) < riskMag) sl = e + riskMag;
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
    Math.min(92, Math.round(Number(parsed?.confidence) || 68))
  );

  const timeframe = normalizeTimeframe(parsed?.timeframe || parsed?.tf);

  const analysis = String(
    parsed?.analysis ||
      parsed?.reason ||
      parsed?.summary ||
      `${levels.side} Capital Guard setup from ${timeframe} structure`
  ).trim();

  const reasons = Array.isArray(parsed?.reasons)
    ? parsed.reasons.map((r) => String(r)).filter(Boolean).slice(0, 4)
    : [analysis];

  // Fixed R:R ladder: TP1 1:1 · TP2 1:2 · TP3 1:3
  const riskReward = "1:1 · 1:2 · 1:3";
  const executeReady = confidence >= MIN_EXECUTE_CONFIDENCE;

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
    recommendedTimeframe: RECOMMENDED_TIMEFRAME,
    strategy: "Capital Guard",
    strategyRules: [
      "Trade with the higher-timeframe trend only",
      "Enter on pullbacks into support/resistance — not mid-range spikes",
      "Use structural stops beyond the last swing (no tight scalp SL)",
      `Best timeframe: ${RECOMMENDED_TIMEFRAME} (also good: H4). Avoid M1–M5`,
      `Execute only when confidence ≥ ${MIN_EXECUTE_CONFIDENCE}%`,
    ],
    executeReady,
    minExecuteConfidence: MIN_EXECUTE_CONFIDENCE,
    analysis,
    reasons,
    chartConfidence,
    message: `${levels.side} ${symbol || "setup"} ready`,
    uiMessage: executeReady
      ? `Capital Guard · ${timeframe} — press Execute Trade when ready.`
      : `Capital Guard · confidence ${confidence}% is below ${MIN_EXECUTE_CONFIDENCE}% — wait for a clearer ${RECOMMENDED_TIMEFRAME} chart.`,
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
            "You are ApexEA Capital Guard — a conservative trading-chart analyst for MetaTrader / TradingView / cTrader screenshots. " +
            "Your job is to protect client capital: prefer fewer, higher-quality setups over frequent scalps. Return JSON only with schema: " +
            '{"isChart":boolean,"chartConfidence":0-100,"status":"no_chart"|"setup_ready",' +
            '"symbol":string|null,"side":"BUY"|"SELL","confidence":0-100,' +
            '"entry":number,"stopLoss":number,' +
            '"takeProfit1":number,"takeProfit2":number,"takeProfit3":number,' +
            '"riskReward":string,"timeframe":string,"analysis":string,"reasons":string[]}. ' +
            "Set isChart=true for phone or desktop trading charts with candlesticks/bars and a price axis " +
            "(including shared chat screenshots and nested chart previews). " +
            "Photographs of people, cars, buildings, or landscapes are NOT charts. " +
            "If not a chart: status=no_chart, isChart=false, and leave trade fields null. " +
            "STRATEGY (Capital Guard) — apply on every valid chart: " +
            "1) Prefer H1 structure (also accept M30/H4/D1). Never recommend M1 or M5; if the chart is M1/M5, still return a setup but set timeframe to H1 and warn in analysis that clients should switch to H1. " +
            "2) Trade WITH the clear trend only (BUY in higher highs/higher lows, SELL in lower highs/lower lows). " +
            "3) Entry should be a pullback into support (BUY) or resistance (SELL), not a chase into extended candles. " +
            "4) Stop loss MUST sit beyond the last structural swing — never a tiny scalp stop. Use wider protective distance. " +
            "5) If the chart is choppy/ranging/unclear, keep confidence at 55-65. Clear trend + clean level = 70-88. Never invent 95+. " +
            "6) Always return COMPLETE Entry, SL, TP1, TP2, TP3. TP1=1:1, TP2=1:2, TP3=1:3 of stop distance. riskReward=\"1:1 · 1:2 · 1:3\". " +
            "BUY must satisfy: stopLoss < entry < takeProfit1 < takeProfit2 < takeProfit3. " +
            "SELL must satisfy: stopLoss > entry > takeProfit1 > takeProfit2 > takeProfit3. " +
            "OCR the instrument from the chart header/title/tab EXACTLY as shown — keep broker dots " +
            "(e.g. .DE30. , .US30Cash , US30). Also use the description line under the ticker when present. " +
            "Do NOT rename .DE30. to GER40/US30. Catalog is NOT multiple choice — never invent EURUSD/XAUUSD/BTCUSD. " +
            "If a symbol hint is provided and it matches the chart, keep it; otherwise prefer the visible header text. " +
            "In analysis, briefly state trend, level, and why the stop is structural. Mention Best TF: H1 when relevant.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Validate whether this is a trading chart. If yes, generate a Capital Guard trade setup (trend + pullback + structural SL) with Entry, SL, TP1, TP2, and TP3. " +
                "Prefer H1 timeframe quality. OCR the exact symbol from the chart header (any instrument shown) — do not guess from the catalog." +
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
