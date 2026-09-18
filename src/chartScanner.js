import { apiUrl } from "./apiOrigin.js";
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read chart image"));
    img.src = src;
  });
}

export const CHART_DETECTION_STATUS = {
  NO_CHART: "no_chart",
  SYMBOL_DETECTED: "symbol_detected",
  SYMBOL_UNCLEAR: "symbol_unclear",
  SETUP_READY: "setup_ready",
};

/** Best client timeframe for Capital Guard (also good: H4). Avoid M1–M5. */
export const RECOMMENDED_SCAN_TIMEFRAME = "H1";
export const MIN_EXECUTE_CONFIDENCE = 70;
export const SCANNER_STRATEGY_NAME = "Capital Guard";
export const SCANNER_STRATEGY_RULES = [
  "Trade with the higher-timeframe trend only",
  "Enter on pullbacks into support/resistance — not mid-range spikes",
  "Use structural stops beyond the last swing (no tight scalp SL)",
  `Best timeframe: ${RECOMMENDED_SCAN_TIMEFRAME} (also good: H4). Avoid M1–M5`,
  `Execute only when confidence ≥ ${MIN_EXECUTE_CONFIDENCE}%`,
];

export const CHART_DETECTION_MESSAGES = {
  no_chart: {
    message: "No trading chart detected",
    uiMessage: "Please upload a clear trading chart.",
  },
  symbol_unclear: {
    message: "Chart detected — symbol unclear",
    uiMessage: "Chart detected — symbol unclear",
  },
};

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.\-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatPrice(value) {
  const n = toFiniteNumber(value);
  if (n == null) return null;
  const abs = Math.abs(n);
  let digits = 5;
  if (abs >= 1000) digits = 2;
  else if (abs >= 100) digits = 3;
  else if (abs >= 10) digits = 4;
  return Number(n.toFixed(digits));
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

function minStructuralRisk(entry) {
  const e = Math.abs(toFiniteNumber(entry) || 1);
  if (e >= 1000) return Math.max(e * 0.004, 8);
  if (e >= 100) return Math.max(e * 0.0045, 1.8);
  if (e >= 10) return Math.max(e * 0.005, 0.12);
  return Math.max(e * 0.006, 0.004);
}

function normalizeTimeframe(raw) {
  const tf = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^1H$/, "H1")
    .replace(/^4H$/, "H4")
    .replace(/^15M$/, "M15")
    .replace(/^30M$/, "M30");
  if (["M1", "M5", "1M", "5M", "M2", "M3"].includes(tf)) {
    return RECOMMENDED_SCAN_TIMEFRAME;
  }
  if (["M15", "M30", "H1", "H4", "D1"].includes(tf)) return tf;
  return RECOMMENDED_SCAN_TIMEFRAME;
}

/**
 * Always produce Entry, SL, TP1, TP2, TP3 with fixed R:R targets.
 * TP1 = 1:1 · TP2 = 1:2 · TP3 = 1:3 (reward vs stop distance).
 * BUY:  SL < Entry < TP1 < TP2 < TP3
 * SELL: SL > Entry > TP1 > TP2 > TP3
 */
function ensureCompleteSetup(partial = {}) {
  const side = String(partial.side || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";
  let entry = toFiniteNumber(partial.entry);
  let stopLoss = toFiniteNumber(partial.stopLoss);

  if (entry == null) entry = 1;
  const magnitude = minStructuralRisk(entry);

  if (side === "BUY") {
    if (stopLoss == null || !(stopLoss < entry)) stopLoss = entry - magnitude;
    if (Math.abs(entry - stopLoss) < magnitude) stopLoss = entry - magnitude;
  } else {
    if (stopLoss == null || !(stopLoss > entry)) stopLoss = entry + magnitude;
    if (Math.abs(entry - stopLoss) < magnitude) stopLoss = entry + magnitude;
  }

  const risk = Math.abs(entry - stopLoss);
  let takeProfit1;
  let takeProfit2;
  let takeProfit3;
  if (side === "BUY") {
    takeProfit1 = entry + risk * 1;
    takeProfit2 = entry + risk * 2;
    takeProfit3 = entry + risk * 3;
  } else {
    takeProfit1 = entry - risk * 1;
    takeProfit2 = entry - risk * 2;
    takeProfit3 = entry - risk * 3;
  }

  entry = formatPrice(entry);
  stopLoss = formatPrice(stopLoss);
  takeProfit1 = formatPrice(takeProfit1);
  takeProfit2 = formatPrice(takeProfit2);
  takeProfit3 = formatPrice(takeProfit3);

  const timeframe = normalizeTimeframe(partial.timeframe);
  const confidence = Math.max(
    55,
    Math.min(92, Math.round(Number(partial.confidence) || 68))
  );
  const executeReady =
    partial.executeReady != null
      ? Boolean(partial.executeReady)
      : confidence >= MIN_EXECUTE_CONFIDENCE;

  const analysis =
    String(partial.analysis || "").trim() ||
    (side === "BUY"
      ? `Capital Guard BUY · ${timeframe} trend pullback into support`
      : `Capital Guard SELL · ${timeframe} trend pullback into resistance`);

  return {
    ...partial,
    status: CHART_DETECTION_STATUS.SETUP_READY,
    isChart: true,
    side,
    confidence,
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    takeProfit3,
    takeProfit: takeProfit3,
    riskReward: "1:1 · 1:2 · 1:3",
    timeframe,
    recommendedTimeframe: RECOMMENDED_SCAN_TIMEFRAME,
    strategy: SCANNER_STRATEGY_NAME,
    strategyRules: Array.isArray(partial.strategyRules) && partial.strategyRules.length
      ? partial.strategyRules
      : SCANNER_STRATEGY_RULES,
    executeReady,
    minExecuteConfidence: MIN_EXECUTE_CONFIDENCE,
    analysis,
    reasons: Array.isArray(partial.reasons) && partial.reasons.length
      ? partial.reasons
      : [analysis],
  };
}

async function shrinkChartImage(
  dataUrl,
  { maxW = 1600, quality = 0.88, maxBytes = 1_800_000 } = {}
) {
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, maxW / Math.max(1, img.width));
    let width = Math.max(1, Math.round(img.width * scale));
    let height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;

    let q = quality;
    let out = dataUrl;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      out = canvas.toDataURL("image/jpeg", q);
      if (out.length <= maxBytes) return out;
      // Still too large for the API — step down quality, then width.
      if (q > 0.72) q = Math.max(0.72, q - 0.08);
      else {
        width = Math.max(720, Math.round(width * 0.85));
        height = Math.max(1, Math.round((img.height * width) / Math.max(1, img.width)));
      }
    }
    return out;
  } catch {
    return dataUrl;
  }
}

function emptyDetection(overrides = {}) {
  return {
    status: CHART_DETECTION_STATUS.NO_CHART,
    isChart: false,
    symbol: null,
    message: CHART_DETECTION_MESSAGES.no_chart.message,
    uiMessage: CHART_DETECTION_MESSAGES.no_chart.uiMessage,
    chartConfidence: 0,
    symbolConfidence: 0,
    confidence: 0,
    source: "none",
    ...overrides,
  };
}

async function detectSymbolWithOpenAI(dataUrl, { catalog = [] } = {}) {
  // Keep more resolution so the chart header/symbol stays readable for Vision.
  const image = await shrinkChartImage(dataUrl, {
    maxW: 1800,
    quality: 0.9,
    maxBytes: 2_200_000,
  });
  const response = await fetch(apiUrl("/api/chart/symbol"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image, catalog }),
    cache: "no-store",
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `Chart analysis failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  const status = String(data?.status || CHART_DETECTION_STATUS.NO_CHART);
  const symbol =
    status === CHART_DETECTION_STATUS.SYMBOL_DETECTED && data?.symbol
      ? String(data.symbol).trim().toUpperCase()
      : null;
  const suggestedSymbol = String(
    data?.suggestedSymbol || data?.symbol || ""
  )
    .trim()
    .toUpperCase() || null;

  return {
    status,
    isChart: Boolean(data?.isChart),
    symbol,
    suggestedSymbol,
    message: data?.message || CHART_DETECTION_MESSAGES[status]?.message || "",
    uiMessage:
      data?.uiMessage || CHART_DETECTION_MESSAGES[status]?.uiMessage || "",
    chartConfidence: Number(data?.chartConfidence) || 0,
    symbolConfidence: Number(data?.symbolConfidence) || 0,
    confidence: Number(data?.symbolConfidence) || 0,
    source: data?.source || "openai",
  };
}

/**
 * Validate chart image and read symbol when clearly visible.
 * Uses OpenAI Vision only — never guesses from OCR/text alone.
 */
export async function detectSymbolFromChart(dataUrl, { catalog = [] } = {}) {
  if (!dataUrl) return emptyDetection();

  try {
    return await detectSymbolWithOpenAI(dataUrl, { catalog });
  } catch (error) {
    return emptyDetection({
      error: error.message || "Chart analysis unavailable",
    });
  }
}

async function analyzeSetupWithOpenAI(
  dataUrl,
  { catalog = [], hintSymbol = "" } = {}
) {
  const image = await shrinkChartImage(dataUrl, {
    maxW: 1600,
    quality: 0.88,
    maxBytes: 2_200_000,
  });
  const response = await fetch(apiUrl("/api/chart/analyze"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image, catalog, hintSymbol }),
    cache: "no-store",
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `Setup analysis failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

/**
 * Analyze a chart image and ALWAYS return a complete trade setup when the
 * image is a valid trading chart. Never returns an incomplete setup.
 */
export async function analyzeChartImage(
  dataUrl,
  { catalog = [], hintSymbol = "", preferDetectedSymbol = true } = {}
) {
  let setup = null;
  let openAiError = "";

  try {
    setup = await analyzeSetupWithOpenAI(dataUrl, { catalog, hintSymbol });
  } catch (error) {
    openAiError = error.message || "Setup analysis unavailable";
  }

  if (setup?.status === CHART_DETECTION_STATUS.NO_CHART || setup?.isChart === false) {
    const err = new Error(
      setup?.message || CHART_DETECTION_MESSAGES.no_chart.message
    );
    err.code = "NO_CHART";
    err.uiMessage =
      setup?.uiMessage || CHART_DETECTION_MESSAGES.no_chart.uiMessage;
    throw err;
  }

  if (setup?.status === CHART_DETECTION_STATUS.SETUP_READY || setup?.isChart) {
    const complete = ensureCompleteSetup(setup);
    // Prefer the symbol already detected from the screenshot over a fresh
    // analyze pass that may hallucinate a popular pair.
    let symbol = preferDetectedSymbol
      ? String(hintSymbol || complete.symbol || "")
          .trim()
          .toUpperCase()
      : String(complete.symbol || hintSymbol || "")
          .trim()
          .toUpperCase();
    if (!symbol) {
      const detection = await detectSymbolFromChart(dataUrl, { catalog });
      if (detection.status === CHART_DETECTION_STATUS.NO_CHART) {
        const err = new Error(CHART_DETECTION_MESSAGES.no_chart.message);
        err.code = "NO_CHART";
        err.uiMessage = CHART_DETECTION_MESSAGES.no_chart.uiMessage;
        throw err;
      }
      symbol = String(detection.symbol || hintSymbol || "")
        .trim()
        .toUpperCase();
    }
    if (!symbol) {
      const err = new Error(CHART_DETECTION_MESSAGES.symbol_unclear.message);
      err.code = "SYMBOL_UNCLEAR";
      err.uiMessage = CHART_DETECTION_MESSAGES.symbol_unclear.uiMessage;
      throw err;
    }

    return {
      ...complete,
      symbol,
      detectedSymbol: symbol,
      detectionStatus: CHART_DETECTION_STATUS.SETUP_READY,
      detectionConfidence: complete.confidence,
      scannedAt: Date.now(),
      source: complete.source || "openai",
    };
  }

  // Live scanner only — never invent a local/demo setup when OpenAI fails.
  const err = new Error(
    openAiError ||
      setup?.message ||
      "Live chart analysis unavailable — retry in a moment"
  );
  err.code = "ANALYSIS_UNAVAILABLE";
  err.uiMessage = "Live OpenAI analysis failed. Please retry.";
  throw err;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const CONNECT_ENGINE_STEPS = [
  { id: "auth", label: "Authenticating broker credentials" },
  { id: "provision", label: "Provisioning cloud terminal" },
  { id: "handshake", label: "Handshake with broker servers" },
  { id: "arm", label: "Arming ApexEA trading engine" },
];

export const TRADE_ENGINE_STEPS = [
  { id: "load", label: "Loading chart into Capital Guard" },
  { id: "structure", label: "Reading higher-timeframe structure" },
  { id: "bias", label: "Confirming trend bias (no counter-trend scalp)" },
  { id: "signal", label: "Building pullback entry signal" },
  { id: "levels", label: "Structural SL · TP1 1:1 · TP2 1:2 · TP3 1:3" },
  { id: "ready", label: `Setup ready · best TF ${RECOMMENDED_SCAN_TIMEFRAME}` },
];

export const EXECUTE_ENGINE_STEPS = [
  { id: "route", label: "Routing order to connected MT5" },
  { id: "fill", label: "Confirming broker fill" },
];
