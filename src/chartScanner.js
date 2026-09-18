import { apiUrl } from "./apiOrigin.js";
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read chart image"));
    img.src = src;
  });
}

function sampleBias(imageData) {
  const { data, width, height } = imageData;
  let bull = 0;
  let bear = 0;
  let bright = 0;
  let dark = 0;
  const step = Math.max(4, Math.floor((width * height) / 12000));

  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = (r + g + b) / 3;
    if (lum > 180) bright += 1;
    if (lum < 50) dark += 1;
    if (g > r + 18 && g > b + 8) bull += 1;
    if (r > g + 18 && r > b + 8) bear += 1;
  }

  const total = Math.max(1, bull + bear);
  const bullRatio = bull / total;
  const structure = bright > dark ? "light-theme" : "dark-theme";
  return { bull, bear, bullRatio, structure };
}

export const CHART_DETECTION_STATUS = {
  NO_CHART: "no_chart",
  SYMBOL_DETECTED: "symbol_detected",
  SYMBOL_UNCLEAR: "symbol_unclear",
  SETUP_READY: "setup_ready",
};

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
  const magnitude = Math.max(
    Math.abs(entry) * 0.0025,
    entry >= 1000 ? 3 : entry >= 100 ? 1 : entry >= 10 ? 0.05 : 0.0015
  );

  if (side === "BUY") {
    if (stopLoss == null || !(stopLoss < entry)) stopLoss = entry - magnitude;
  } else if (stopLoss == null || !(stopLoss > entry)) {
    stopLoss = entry + magnitude;
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

  const analysis =
    String(partial.analysis || "").trim() ||
    (side === "BUY"
      ? "Bullish structure supports a BUY setup toward higher resistance"
      : "Bearish structure supports a SELL setup toward lower support");

  return {
    ...partial,
    status: CHART_DETECTION_STATUS.SETUP_READY,
    isChart: true,
    side,
    confidence: Math.max(55, Math.min(95, Math.round(Number(partial.confidence) || 70))),
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    takeProfit3,
    takeProfit: takeProfit3,
    riskReward: "1:1 · 1:2 · 1:3",
    timeframe: String(partial.timeframe || "M15").trim().toUpperCase() || "M15",
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

async function localDirectionalBias(dataUrl) {
  const img = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  const maxW = 640;
  const scale = Math.min(1, maxW / Math.max(1, img.width));
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { side: "BUY", confidence: 62, reasons: ["Local bias unavailable"] };
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const x0 = Math.floor(canvas.width * 0.62);
  const y0 = Math.floor(canvas.height * 0.12);
  const w = Math.max(1, canvas.width - x0 - 8);
  const h = Math.max(1, Math.floor(canvas.height * 0.72));
  const recent = ctx.getImageData(x0, y0, w, h);
  const full = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const recentBias = sampleBias(recent);
  const fullBias = sampleBias(full);
  const score = recentBias.bullRatio * 0.7 + fullBias.bullRatio * 0.3;

  let side = "BUY";
  let confidence = Math.round(50 + Math.abs(score - 0.5) * 90);
  if (score < 0.46) side = "SELL";
  else if (score > 0.54) side = "BUY";
  else {
    side = recentBias.bullRatio >= 0.5 ? "BUY" : "SELL";
    confidence = Math.max(52, confidence - 8);
  }
  confidence = Math.min(92, Math.max(55, confidence));

  return {
    side,
    confidence,
    score,
    reasons: [
      recentBias.bullRatio >= 0.5
        ? "Recent candles skew bullish"
        : "Recent candles skew bearish",
      fullBias.structure === "dark-theme"
        ? "Dark chart theme detected"
        : "Light chart theme detected",
    ],
  };
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

  // Fallback: chart previously validated via symbol detection + local bias.
  const detection = await detectSymbolFromChart(dataUrl, { catalog });
  if (detection.status === CHART_DETECTION_STATUS.NO_CHART) {
    const err = new Error(
      openAiError || detection.message || CHART_DETECTION_MESSAGES.no_chart.message
    );
    err.code = "NO_CHART";
    err.uiMessage =
      detection.uiMessage || CHART_DETECTION_MESSAGES.no_chart.uiMessage;
    throw err;
  }

  const symbol = String(detection.symbol || hintSymbol || "")
    .trim()
    .toUpperCase();
  if (!symbol) {
    const err = new Error(CHART_DETECTION_MESSAGES.symbol_unclear.message);
    err.code = "SYMBOL_UNCLEAR";
    err.uiMessage = CHART_DETECTION_MESSAGES.symbol_unclear.uiMessage;
    throw err;
  }

  const bias = await localDirectionalBias(dataUrl);
  const complete = ensureCompleteSetup({
    symbol,
    side: bias.side,
    confidence: bias.confidence,
    analysis: bias.reasons?.[0] || `${bias.side} setup from chart structure`,
    reasons: [
      ...(bias.reasons || []),
      `Symbol from scanner: ${symbol}`,
    ],
    timeframe: "M15",
    source: "local",
  });

  return {
    ...complete,
    symbol,
    detectedSymbol: symbol,
    detectionStatus: CHART_DETECTION_STATUS.SETUP_READY,
    detectionConfidence: complete.confidence,
    scannedAt: Date.now(),
  };
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
  { id: "load", label: "Loading chart into trading engine" },
  { id: "structure", label: "Reading market structure" },
  { id: "bias", label: "Detecting directional bias" },
  { id: "signal", label: "Building entry signal" },
  { id: "levels", label: "Calculating entry, SL, TP1, TP2 and TP3" },
  { id: "ready", label: "Trade setup ready" },
];

export const EXECUTE_ENGINE_STEPS = [
  { id: "route", label: "Routing order to connected MT5" },
  { id: "fill", label: "Confirming broker fill" },
];
