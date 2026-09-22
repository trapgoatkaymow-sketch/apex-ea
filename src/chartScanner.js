import { apiUrl } from "./apiOrigin.js";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";
import { buildSafeMultiTpLevels, normalizeTradeSide, normalizeChartTimeframe, tpRiskRewardLabel } from "./tradeLevels.js";
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

function isOpenAiQuotaError(message = "", status = 0) {
  const text = String(message || "");
  return (
    status === 429 ||
    /credit|quota|billing|insufficient_quota|credit_balance|rate.?limit|unavailable|OpenAI error 429/i.test(
      text
    )
  );
}

/** Rough mid-market anchors so offline setups stay in a realistic range. */
function estimateEntryForSymbol(symbol) {
  const raw = String(symbol || "")
    .toUpperCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/CASH$/i, "")
    .replace(/\.(MIC|M|PRO|RAW|ECN|STD|CASH|SPOT)$/i, "");
  const base = raw.split(".")[0] || raw;
  const table = [
    [/^(US30|DJ30|WS30|DJI|USA30|USWALLST30|DOW30)/, 45000],
    [/^(NAS100|USTEC|NDX|NASDAQ|US100|USATECH100|TECH100)/, 20000],
    [/^(SPX500|US500|SP500|SPX)/, 5600],
    [/^(GER40|DE40|DAX|DE30|GER30|GDAXI)/, 18500],
    [/^(UK100|FTSE)/, 8200],
    [/^(JP225|JPN225|NI225|NIKKEI)/, 38000],
    [/^(XAU|GOLD)/, 2650],
    [/^(XAG|SILVER)/, 31],
    [/^(BTC)/, 95000],
    [/^(ETH)/, 3500],
    [/^(USOIL|WTI|CL)/, 75],
    [/^(UKOIL|BRENT)/, 80],
    [/^(EURUSD|EUR)/, 1.085],
    [/^(GBPUSD|GBP)/, 1.27],
    [/^(USDJPY|JPY)/, 149.5],
    [/^(AUDUSD|AUD)/, 0.65],
    [/^(NZDUSD|NZD)/, 0.6],
    [/^(USDCAD|CAD)/, 1.36],
    [/^(USDCHF|CHF)/, 0.88],
  ];
  for (const [re, price] of table) {
    if (re.test(base) || re.test(raw)) return price;
  }
  if (/USD$/.test(base) || /^USD/.test(base)) return 1.1;
  if (/JPY$/.test(base)) return 150;
  return 100;
}

/**
 * Infer BUY/SELL from recent candle colors (right edge of the chart).
 * Bullish = green / lime / cyan / blue candles; bearish = red / orange / magenta.
 * Weights the newest (rightmost) candles more heavily so a late reversal wins.
 */
async function inferSideFromChartImage(dataUrl) {
  try {
    const img = await loadImage(dataUrl);
    const w = Math.min(360, img.naturalWidth || img.width || 360);
    const h = Math.max(
      80,
      Math.round((w / Math.max(1, img.naturalWidth || img.width || w)) * (img.naturalHeight || img.height || w))
    );
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "BUY";
    ctx.drawImage(img, 0, 0, w, h);
    // Focus on the price plot: skip headers / price axis chrome.
    const x0 = Math.floor(w * 0.48);
    const x1 = Math.floor(w * 0.92);
    const y0 = Math.floor(h * 0.16);
    const y1 = Math.floor(h * 0.84);
    const data = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
    const plotW = Math.max(1, x1 - x0);
    let bull = 0;
    let bear = 0;
    for (let i = 0; i < data.length; i += 16) {
      const px = (i / 4) % plotW;
      // Newer candles (right side) count more.
      const weight = 1 + (px / plotW) * 2.2;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 40) continue;
      if (r > 230 && g > 230 && b > 230) continue;
      if (r < 28 && g < 28 && b < 28) continue;
      const isBull =
        (g > r + 16 && g > b + 8) || // green / lime
        (b > r + 18 && b > g + 6) || // blue / cyan bull themes
        (g > 140 && b > 140 && r < 110); // teal
      const isBear =
        (r > g + 16 && r > b + 8) || // red / orange
        (r > 150 && b > 140 && g < 110); // magenta / pink bear themes
      if (isBull && !isBear) bull += weight;
      else if (isBear && !isBull) bear += weight;
    }
    if (bull === 0 && bear === 0) return "BUY";
    // Require a clearer majority before flipping — avoids noise from UI chrome.
    if (bull > bear * 1.12) return "BUY";
    if (bear > bull * 1.12) return "SELL";
    return bull >= bear ? "BUY" : "SELL";
  } catch {
    return "BUY";
  }
}

async function buildLocalFallbackSetup(dataUrl, { hintSymbol = "" } = {}) {
  const symbol = normalizeBrokerSymbol(hintSymbol || "");
  if (!symbol) {
    const err = new Error(CHART_DETECTION_MESSAGES.symbol_unclear.message);
    err.code = "SYMBOL_UNCLEAR";
    err.uiMessage = CHART_DETECTION_MESSAGES.symbol_unclear.uiMessage;
    throw err;
  }

  const side = await inferSideFromChartImage(dataUrl);
  const entry = estimateEntryForSymbol(symbol);
  const complete = ensureCompleteSetup({
    side,
    entry,
    confidence: 68,
    timeframe: "M15",
    analysis:
      side === "BUY"
        ? "Local fallback setup from recent bullish candle bias while live AI is unavailable"
        : "Local fallback setup from recent bearish candle bias while live AI is unavailable",
    symbol,
  });

  return {
    ...complete,
    symbol,
    detectedSymbol: symbol,
    detectionStatus: CHART_DETECTION_STATUS.SETUP_READY,
    detectionConfidence: complete.confidence,
    scannedAt: Date.now(),
    source: "local-fallback",
    message: `${side} ${symbol} setup ready (offline AI)`,
    uiMessage: "Trade setup ready — live AI was unavailable, used local chart bias.",
  };
}

/**
 * Always produce Entry, SL, TP1, TP2, TP3 with fixed R:R targets.
 * H4 → TP1 1:1 · TP2 1:2 · TP3 1:3
 * All other timeframes → TP1 1:2 · TP2 1:3 · TP3 1:4
 * BUY:  SL < Entry < TP1 < TP2 < TP3
 * SELL: SL > Entry > TP1 > TP2 > TP3
 * Enforces instrument-class minimum stop distance so SL/TP are not too close.
 */
function ensureCompleteSetup(partial = {}) {
  const symbol = String(partial.symbol || partial.detectedSymbol || "").trim();
  const timeframe =
    normalizeChartTimeframe(partial.timeframe || partial.tf || "M15") || "M15";
  const levels = buildSafeMultiTpLevels({
    symbol,
    side: normalizeTradeSide(partial.side, {
      entry: partial.entry,
      stopLoss: partial.stopLoss,
    }),
    entry: partial.entry,
    stopLoss: partial.stopLoss,
    timeframe,
  });

  const analysis =
    String(partial.analysis || "").trim() ||
    (levels.side === "BUY"
      ? "Bullish structure supports a BUY setup toward higher resistance"
      : "Bearish structure supports a SELL setup toward lower support");

  return {
    ...partial,
    status: CHART_DETECTION_STATUS.SETUP_READY,
    isChart: true,
    side: levels.side,
    confidence: Math.max(55, Math.min(95, Math.round(Number(partial.confidence) || 70))),
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit1: levels.takeProfit1,
    takeProfit2: levels.takeProfit2,
    takeProfit3: levels.takeProfit3,
    takeProfit: levels.takeProfit3,
    riskReward: levels.riskReward || tpRiskRewardLabel(timeframe),
    timeframe,
    analysis,
    reasons: Array.isArray(partial.reasons) && partial.reasons.length
      ? partial.reasons
      : [analysis],
    // Keep Vision overlay geometry for Interface 2 chart drawing
    priceTop: partial.priceTop ?? null,
    priceBottom: partial.priceBottom ?? null,
    chartArea: partial.chartArea ?? null,
    trendlines: Array.isArray(partial.trendlines) ? partial.trendlines : [],
    structure: Array.isArray(partial.structure) ? partial.structure : [],
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
      ? normalizeBrokerSymbol(data.symbol)
      : null;
  const suggestedSymbol =
    normalizeBrokerSymbol(data?.suggestedSymbol || data?.symbol || "") || null;

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
 * Prefers OpenAI Vision; when the AI quota/credits are exhausted, soft-fail
 * to "symbol unclear" so the trader can type the symbol and keep scanning.
 */
export async function detectSymbolFromChart(dataUrl, { catalog = [] } = {}) {
  if (!dataUrl) return emptyDetection();

  try {
    return await detectSymbolWithOpenAI(dataUrl, { catalog });
  } catch (error) {
    const message = error.message || "Chart analysis unavailable";
    if (isOpenAiQuotaError(message, error.status)) {
      return {
        status: CHART_DETECTION_STATUS.SYMBOL_UNCLEAR,
        isChart: true,
        symbol: null,
        suggestedSymbol: null,
        message: "Chart ready — type the symbol (AI temporarily offline)",
        uiMessage: "Enter the chart symbol to continue.",
        chartConfidence: 70,
        symbolConfidence: 0,
        confidence: 0,
        source: "local-fallback",
        error: message,
        quotaFallback: true,
      };
    }
    return emptyDetection({
      error: message,
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
 * Falls back to local candle-bias analysis when OpenAI credits/quota fail.
 */
export async function analyzeChartImage(
  dataUrl,
  { catalog = [], hintSymbol = "", preferDetectedSymbol = true } = {}
) {
  let setup = null;
  let openAiError = "";
  let openAiStatus = 0;

  try {
    setup = await analyzeSetupWithOpenAI(dataUrl, { catalog, hintSymbol });
  } catch (error) {
    openAiError = error.message || "Setup analysis unavailable";
    openAiStatus = Number(error.status) || 0;
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
      ? normalizeBrokerSymbol(hintSymbol || complete.symbol || "")
      : normalizeBrokerSymbol(complete.symbol || hintSymbol || "");
    if (!symbol) {
      const detection = await detectSymbolFromChart(dataUrl, { catalog });
      if (detection.status === CHART_DETECTION_STATUS.NO_CHART) {
        const err = new Error(CHART_DETECTION_MESSAGES.no_chart.message);
        err.code = "NO_CHART";
        err.uiMessage = CHART_DETECTION_MESSAGES.no_chart.uiMessage;
        throw err;
      }
      symbol = normalizeBrokerSymbol(detection.symbol || hintSymbol || "");
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

  // OpenAI down / out of credits — keep the scanner usable with local bias.
  if (isOpenAiQuotaError(openAiError, openAiStatus)) {
    return buildLocalFallbackSetup(dataUrl, { hintSymbol });
  }

  // Live scanner only — never invent a local/demo setup for unknown failures.
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
