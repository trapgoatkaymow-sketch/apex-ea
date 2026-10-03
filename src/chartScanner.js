import { apiUrl } from "./apiOrigin.js";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";
import { getPriceHistory, getSymbolQuote } from "./metaApi.js";
import {
  chartBackgroundIsLight,
  classifyCandlePixel,
  explicitTradeSide,
  inferScannerSideFromBars,
  inferSideFromColorTally,
  scannerConfidence,
  voteScannerSides,
} from "./chartScannerBias.js";
import { detectSymbolFromChartImage } from "./chartSymbolOcr.js";
import { buildSafeMultiTpLevels, normalizeTradeSide, normalizeChartTimeframe, tpRiskRewardLabel } from "./tradeLevels.js";

/** After Vision quota/key failure, skip OpenAI for the rest of this session. */
let skipOpenAiVision = false;

function markOpenAiVisionDown() {
  skipOpenAiVision = true;
}

function abortSignalAfter(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Math.max(1, Number(ms) || 1));
  return controller.signal;
}
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
  if (value == null || value === "") return null;
  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === "." || cleaned === "-.") return null;
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

function isOpenAiUnavailable(message = "", status = 0) {
  const code = Number(status) || 0;
  const text = String(message || "");
  return (
    code === 401 ||
    code === 402 ||
    code === 429 ||
    code === 502 ||
    code === 503 ||
    /credit|quota|billing|insufficient_quota|credit_balance|rate.?limit|openai is not configured|incorrect api key|invalid.?api.?key|you exceeded|insufficient funds|OpenAI error|unavailable/i.test(
      text
    )
  );
}

/** @deprecated use isOpenAiUnavailable */
function isOpenAiQuotaError(message = "", status = 0) {
  return isOpenAiUnavailable(message, status);
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
    [/^(XAU|GOLD)/, 4200],
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
 * Light charts: black bodies are SELL candles. Dark charts skip wallpaper.
 * Requires a real color majority — leftover blue grid must not become BUY.
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
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    // Focus on the price plot: skip headers / price axis chrome.
    const x0 = Math.floor(w * 0.48);
    const x1 = Math.floor(w * 0.92);
    const y0 = Math.floor(h * 0.16);
    const y1 = Math.floor(h * 0.84);
    const plotW = Math.max(1, x1 - x0);
    const plotH = Math.max(1, y1 - y0);
    const data = ctx.getImageData(x0, y0, plotW, plotH).data;

    let bgSum = 0;
    let bgN = 0;
    for (let i = 0; i < data.length; i += 32) {
      const px = (i / 4) % plotW;
      const py = Math.floor(i / 4 / plotW);
      if (px > plotW * 0.14 && py > plotH * 0.14) continue;
      const a = data[i + 3];
      if (a < 40) continue;
      bgSum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      bgN += 1;
    }
    const lightBackground = chartBackgroundIsLight(bgN ? bgSum / bgN : 0);

    let bull = 0;
    let bear = 0;
    for (let i = 0; i < data.length; i += 16) {
      const px = (i / 4) % plotW;
      const weight = 1 + (px / plotW) * 2.2;
      const kind = classifyCandlePixel(data[i], data[i + 1], data[i + 2], data[i + 3], {
        lightBackground,
      });
      if (kind === "bull") bull += weight;
      else if (kind === "bear") bear += weight;
    }
    return inferSideFromColorTally(bull, bear);
  } catch {
    return null;
  }
}

async function fetchHistoryBars(accountId, symbol, timeFrame, days) {
  try {
    const hist = await getPriceHistory({
      accountId,
      symbol,
      timeFrame,
      fast: true,
      days,
      signal: abortSignalAfter(10_000),
    });
    return Array.isArray(hist?.bars) ? hist.bars : [];
  } catch {
    return [];
  }
}

/**
 * Live quote + M5/M15/M30 vote. Direction comes from candles, not a fake 72% BUY.
 */
async function readLiveScannerMarket(accountId, symbol) {
  const id = String(accountId || "").trim();
  const result = {
    entry: null,
    side: null,
    confidence: 0,
    usedLiveQuote: false,
    usedLiveBars: false,
    vote: null,
  };
  if (!id || !symbol) return result;

  const [quoteBag, m5, m15, m30] = await Promise.all([
    getSymbolQuote({
      accountId: id,
      symbol,
      fast: true,
      signal: abortSignalAfter(8_000),
    })
      .then((quote) => quote)
      .catch(() => null),
    fetchHistoryBars(id, symbol, 5, 3),
    fetchHistoryBars(id, symbol, 15, 5),
    fetchHistoryBars(id, symbol, 30, 5),
  ]);

  const price = toFiniteNumber(quoteBag?.price);
  if (price != null && price > 0) {
    result.entry = price;
    result.usedLiveQuote = true;
  }

  const reads = [
    { ...inferScannerSideFromBars(m5), weight: 1.5, tf: "M5" },
    { ...inferScannerSideFromBars(m15), weight: 1.25, tf: "M15" },
    { ...inferScannerSideFromBars(m30), weight: 1, tf: "M30" },
  ];
  const vote = voteScannerSides(reads);
  result.vote = vote;
  if (vote.side === "BUY" || vote.side === "SELL") {
    result.side = vote.side;
    result.usedLiveBars = true;
    result.confidence = scannerConfidence({
      vote,
      usedLiveBars: true,
      usedImage: false,
    });
  }
  return result;
}

function throwSideUnclear() {
  const err = new Error(
    "No clear BUY/SELL bias on this chart — wait for a clearer move"
  );
  err.code = "SIDE_UNCLEAR";
  err.uiMessage =
    "Could not read a clear direction from the chart. Try again when the move is clearer.";
  throw err;
}

async function buildLocalFallbackSetup(
  dataUrl,
  { hintSymbol = "", accountId = "" } = {}
) {
  const symbol = normalizeBrokerSymbol(hintSymbol || "");
  if (!symbol) {
    const err = new Error(CHART_DETECTION_MESSAGES.symbol_unclear.message);
    err.code = "SYMBOL_UNCLEAR";
    err.uiMessage = CHART_DETECTION_MESSAGES.symbol_unclear.uiMessage;
    throw err;
  }

  const live = await readLiveScannerMarket(accountId, symbol);
  let side = live.side;
  let entry = live.entry != null ? live.entry : estimateEntryForSymbol(symbol);
  let usedImage = false;
  let confidence = live.confidence;

  if (side !== "BUY" && side !== "SELL") {
    side = await inferSideFromChartImage(dataUrl);
    usedImage = side === "BUY" || side === "SELL";
    if (usedImage) {
      confidence = scannerConfidence({
        vote: {
          side,
          buyScore: side === "BUY" ? 1 : 0,
          sellScore: side === "SELL" ? 1 : 0,
          agree: 1,
          total: 1,
        },
        usedLiveBars: false,
        usedImage: true,
      });
    }
  }

  if (side !== "BUY" && side !== "SELL") throwSideUnclear();

  const why =
    live.usedLiveBars
      ? side === "BUY"
        ? `Live ${symbol} candles are lifting — BUY from M5/M15/M30 structure`
        : `Live ${symbol} candles are dropping — SELL from M5/M15/M30 structure`
      : side === "BUY"
        ? "Bullish candle colors on the chart support a BUY toward higher resistance"
        : "Bearish candle colors on the chart support a SELL toward lower support";
  const complete = ensureCompleteSetup({
    side,
    entry,
    confidence,
    timeframe: "M15",
    analysis: why,
    symbol,
  });

  return {
    ...complete,
    symbol,
    detectedSymbol: symbol,
    detectionStatus: CHART_DETECTION_STATUS.SETUP_READY,
    detectionConfidence: complete.confidence,
    scannedAt: Date.now(),
    source: live.usedLiveBars ? "live-bars" : usedImage ? "chart-colors" : "local-fallback",
    message: `${side} ${symbol} setup ready`,
    uiMessage: "Trade setup ready — press Execute Trade to send to MetaTrader.",
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
      trustSide: true,
    }),
    entry: partial.entry,
    stopLoss: partial.stopLoss,
    timeframe,
    trustSide: true,
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
  if (skipOpenAiVision) {
    const err = new Error("Vision unavailable");
    err.status = 503;
    throw err;
  }
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
    if (isOpenAiUnavailable(message, response.status)) markOpenAiVisionDown();
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  if (data?.openaiUnavailable) markOpenAiVisionDown();

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
    openaiUnavailable: Boolean(data?.openaiUnavailable),
    quotaFallback: Boolean(data?.quotaFallback || data?.openaiUnavailable),
  };
}

function detectedSymbolResult(symbol, source = "local-ocr") {
  const next = normalizeBrokerSymbol(symbol);
  return {
    status: CHART_DETECTION_STATUS.SYMBOL_DETECTED,
    isChart: true,
    symbol: next,
    suggestedSymbol: next,
    message: `Symbol detected: ${next}`,
    uiMessage: next,
    chartConfidence: 82,
    symbolConfidence: 78,
    confidence: 78,
    source,
  };
}

/**
 * Validate chart image and read symbol when clearly visible.
 * OCR the screenshot first (works with no OpenAI credits). Vision is only
 * a backup when OCR cannot read the header.
 */
export async function detectSymbolFromChart(dataUrl, { catalog = [] } = {}) {
  if (!dataUrl) return emptyDetection();

  // Always try on-device OCR first — OpenAI credits are often exhausted.
  try {
    const local = await detectSymbolFromChartImage(dataUrl, { catalog });
    if (local?.symbol) {
      return detectedSymbolResult(local.symbol, local.source || "local-ocr");
    }
  } catch {
    // Fall through to Vision backup.
  }

  if (skipOpenAiVision) {
    return {
      status: CHART_DETECTION_STATUS.SYMBOL_UNCLEAR,
      isChart: true,
      symbol: null,
      suggestedSymbol: null,
      message: CHART_DETECTION_MESSAGES.symbol_unclear.message,
      uiMessage: CHART_DETECTION_MESSAGES.symbol_unclear.uiMessage,
      chartConfidence: 70,
      symbolConfidence: 0,
      confidence: 0,
      source: "local-ocr",
    };
  }

  let remote = null;
  try {
    remote = await detectSymbolWithOpenAI(dataUrl, { catalog });
  } catch (error) {
    if (isOpenAiUnavailable(error.message, error.status)) markOpenAiVisionDown();
    remote = {
      status: CHART_DETECTION_STATUS.SYMBOL_UNCLEAR,
      isChart: true,
      openaiUnavailable: true,
      error: error.message || "Chart analysis unavailable",
    };
  }

  const remoteSymbol = normalizeBrokerSymbol(
    remote?.symbol || remote?.suggestedSymbol || ""
  );
  if (
    remoteSymbol &&
    !remote?.openaiUnavailable &&
    (String(remote?.status) === CHART_DETECTION_STATUS.SYMBOL_DETECTED ||
      Boolean(remoteSymbol))
  ) {
    return detectedSymbolResult(remoteSymbol, remote?.source || "openai");
  }

  if (
    String(remote?.status) === CHART_DETECTION_STATUS.NO_CHART &&
    remote?.isChart === false
  ) {
    return remote;
  }

  return {
    status: CHART_DETECTION_STATUS.SYMBOL_UNCLEAR,
    isChart: true,
    symbol: null,
    suggestedSymbol: null,
    message: CHART_DETECTION_MESSAGES.symbol_unclear.message,
    uiMessage: CHART_DETECTION_MESSAGES.symbol_unclear.uiMessage,
    chartConfidence: 70,
    symbolConfidence: 0,
    confidence: 0,
    source: "local-ocr",
  };
}

async function analyzeSetupWithOpenAI(
  dataUrl,
  { catalog = [], hintSymbol = "" } = {}
) {
  if (skipOpenAiVision) {
    const err = new Error("Vision unavailable");
    err.status = 503;
    throw err;
  }
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
    if (isOpenAiUnavailable(message, response.status) || data?.openaiUnavailable) {
      markOpenAiVisionDown();
    }
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
  {
    catalog = [],
    hintSymbol = "",
    preferDetectedSymbol = true,
    accountId = "",
  } = {}
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
    // Prefer the symbol already detected from the screenshot over a fresh
    // analyze pass that may hallucinate a popular pair.
    let symbol = preferDetectedSymbol
      ? normalizeBrokerSymbol(hintSymbol || setup.symbol || "")
      : normalizeBrokerSymbol(setup.symbol || hintSymbol || "");
    if (!symbol) {
      const detection = await detectSymbolFromChart(dataUrl, { catalog });
      if (detection.status === CHART_DETECTION_STATUS.NO_CHART) {
        const err = new Error(CHART_DETECTION_MESSAGES.no_chart.message);
        err.code = "NO_CHART";
        err.uiMessage = CHART_DETECTION_MESSAGES.no_chart.uiMessage;
        throw err;
      }
      symbol = normalizeBrokerSymbol(
        detection.symbol || detection.suggestedSymbol || hintSymbol || ""
      );
    }
    if (!symbol) {
      const err = new Error(CHART_DETECTION_MESSAGES.symbol_unclear.message);
      err.code = "SYMBOL_UNCLEAR";
      err.uiMessage = CHART_DETECTION_MESSAGES.symbol_unclear.uiMessage;
      throw err;
    }

    const live = await readLiveScannerMarket(accountId, symbol);
    const liveSide = explicitTradeSide(live.side);
    const aiSide = explicitTradeSide(setup?.side || setup?.direction);
    let side = liveSide || aiSide;
    if (side !== "BUY" && side !== "SELL") {
      side = await inferSideFromChartImage(dataUrl);
    }
    if (side !== "BUY" && side !== "SELL") throwSideUnclear();

    const entry =
      live.entry != null
        ? live.entry
        : toFiniteNumber(setup.entry ?? setup.entryPrice) ??
          estimateEntryForSymbol(symbol);
    let confidence = Number(setup.confidence) || 0;
    let analysis = String(setup.analysis || "").trim();
    let source = setup.source || "openai";
    if (liveSide) {
      confidence = live.confidence;
      source = aiSide && aiSide === liveSide ? "live-bars+openai" : "live-bars";
      analysis =
        aiSide && aiSide !== liveSide
          ? `Live ${symbol} candles show ${liveSide} (ignored AI ${aiSide})`
          : liveSide === "BUY"
            ? `Live ${symbol} candles are lifting — BUY from M5/M15/M30 structure`
            : `Live ${symbol} candles are dropping — SELL from M5/M15/M30 structure`;
    } else if (!confidence) {
      confidence = scannerConfidence({
        vote: {
          side,
          buyScore: side === "BUY" ? 1 : 0,
          sellScore: side === "SELL" ? 1 : 0,
          agree: 1,
          total: 1,
        },
        usedLiveBars: false,
        usedImage: true,
      });
    }

    const complete = ensureCompleteSetup({
      ...setup,
      side,
      entry,
      confidence,
      analysis,
      symbol,
    });

    return {
      ...complete,
      symbol,
      detectedSymbol: symbol,
      detectionStatus: CHART_DETECTION_STATUS.SETUP_READY,
      detectionConfidence: complete.confidence,
      scannedAt: Date.now(),
      source,
    };
  }

  // OpenAI down / out of credits — keep scanning with local candle bias.
  if (openAiError) {
    return buildLocalFallbackSetup(dataUrl, { hintSymbol, accountId });
  }

  const err = new Error(CHART_DETECTION_MESSAGES.symbol_unclear.message);
  err.code = "SYMBOL_UNCLEAR";
  err.uiMessage = CHART_DETECTION_MESSAGES.symbol_unclear.uiMessage;
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

/**
 * Short trader-facing “why” for a scanned setup (1–2 sentences).
 */
export function shortTradeWhy(signal) {
  const analysis = String(signal?.analysis || "").trim();
  const reason = Array.isArray(signal?.reasons)
    ? String(signal.reasons[0] || "").trim()
    : "";
  let text = analysis || reason;
  if (!text) {
    const side = explicitTradeSide(signal?.side);
    text =
      side === "SELL"
        ? "Bearish structure on the chart supports a SELL toward lower targets."
        : side === "BUY"
          ? "Bullish structure on the chart supports a BUY toward higher targets."
          : "Waiting for a clearer BUY or SELL from the candles.";
  }
  // Keep it scannable on mobile — prefer first 1–2 sentences, cap length.
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 2) {
    text = `${sentences[0]} ${sentences[1]}`;
  }
  if (text.length > 160) {
    const cut = text.slice(0, 157);
    const breakAt = Math.max(
      cut.lastIndexOf(". "),
      cut.lastIndexOf("! "),
      cut.lastIndexOf("? "),
      cut.lastIndexOf("; "),
      cut.lastIndexOf(", ")
    );
    text = `${(breakAt > 50 ? cut.slice(0, breakAt + 1) : cut).trim()}…`;
  }
  return text;
}
