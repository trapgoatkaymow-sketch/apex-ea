import {
  inferSymbolFromPrices,
  matchSymbolFromText,
  parseChartPrices,
} from "./chartSymbolMatch.js";

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read chart image"));
    img.src = src;
  });
}

function withTimeout(promise, ms, fallback = null) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(1, Number(ms) || 1));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function enhancePatch(img, region, { invert = true, scale = 2.6 } = {}) {
  const iw = img.naturalWidth || img.width || 1;
  const ih = img.naturalHeight || img.height || 1;
  const sx = Math.max(0, Math.floor(iw * region.x));
  const sy = Math.max(0, Math.floor(ih * region.y));
  const sw = Math.max(8, Math.floor(iw * region.w));
  const sh = Math.max(8, Math.floor(ih * region.h));
  const cw = Math.min(iw - sx, sw);
  const ch = Math.min(ih - sy, sh);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(8, Math.round(cw * scale));
  canvas.height = Math.max(8, Math.round(ch * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = invert ? "#fff" : "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
    let v = (lum - 128) * 1.7 + 128;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    const bit = invert ? (v > 140 ? 0 : 255) : v > 140 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = bit;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Self-hosted paths so Android WebView / blocked CDNs still OCR. */
function tesseractPaths() {
  const base =
    typeof window !== "undefined" && window.location?.origin
      ? `${window.location.origin}/tesseract`
      : "/tesseract";
  return {
    workerPath: `${base}/worker.min.js`,
    corePath: `${base}/tesseract-core-simd-lstm.wasm.js`,
    langPath: `${base}/lang`,
    gzip: true,
    workerBlobURL: false,
  };
}

let workerPromise = null;

async function getOcrWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      const paths = tesseractPaths();
      let worker;
      try {
        worker = await createWorker("eng", 1, {
          ...paths,
          logger: () => {},
        });
      } catch {
        // SIMD core unavailable on some WebViews — fall back to non-SIMD LSTM.
        worker = await createWorker("eng", 1, {
          workerPath: paths.workerPath,
          corePath: `${typeof window !== "undefined" ? window.location.origin : ""}/tesseract/tesseract-core-lstm.wasm.js`,
          langPath: paths.langPath,
          gzip: true,
          workerBlobURL: false,
          logger: () => {},
        });
      }
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789./+ ",
        tessedit_pageseg_mode: "11",
        preserve_interword_spaces: "1",
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

async function ocrPatch(worker, dataUrl) {
  if (!dataUrl) return "";
  try {
    const result = await worker.recognize(dataUrl);
    return String(result?.data?.text || "").trim();
  } catch {
    return "";
  }
}

const HEADER_REGIONS = [
  { x: 0.0, y: 0.0, w: 0.62, h: 0.16 },
  { x: 0.0, y: 0.04, w: 0.55, h: 0.14 },
  { x: 0.0, y: 0.0, w: 1.0, h: 0.12 },
];

const PRICE_REGION = { x: 0.76, y: 0.1, w: 0.24, h: 0.78 };

/**
 * Read the instrument from a chart screenshot without OpenAI.
 */
export async function detectSymbolFromChartImage(dataUrl, { catalog = [] } = {}) {
  if (!dataUrl) return { symbol: "", text: "", prices: [] };

  let img = null;
  try {
    img = await loadImage(dataUrl);
  } catch {
    return { symbol: "", text: "", prices: [] };
  }

  const worker = await withTimeout(getOcrWorker(), 20_000, null);
  if (!worker) return { symbol: "", text: "", prices: [] };

  const chunks = [];
  for (const region of HEADER_REGIONS) {
    for (const invert of [true, false]) {
      const blob = enhancePatch(img, region, { invert, scale: invert ? 2.8 : 2.4 });
      const text = await withTimeout(ocrPatch(worker, blob), 9_000, "");
      if (!text) continue;
      chunks.push(text);
      const hit = matchSymbolFromText(chunks.join(" \n "), catalog);
      if (hit) {
        return {
          symbol: hit,
          text: chunks.join(" \n "),
          prices: parseChartPrices(chunks.join(" \n ")),
          source: "header-ocr",
        };
      }
    }
  }

  const priceBlob = enhancePatch(img, PRICE_REGION, { invert: true, scale: 2.3 });
  const priceText = await withTimeout(ocrPatch(worker, priceBlob), 9_000, "");
  if (priceText) chunks.push(priceText);

  const combined = chunks.join(" \n ");
  const fromText = matchSymbolFromText(combined, catalog);
  const prices = parseChartPrices(priceText || combined);
  const fromPrice = inferSymbolFromPrices(prices, catalog);
  const symbol = fromText || fromPrice || "";

  return {
    symbol,
    text: combined,
    prices,
    source: fromText ? "header-ocr" : fromPrice ? "price-ocr" : "",
  };
}
