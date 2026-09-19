import { registerPlugin } from "@capacitor/core";

const FloatOverlay = registerPlugin("FloatOverlay");

const PROMPT_KEY = "apexea-float-overlay-prompted";
const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/data/ea-photos";

function isNative() {
  try {
    return Boolean(
      typeof window !== "undefined" &&
        window.Capacitor &&
        typeof window.Capacitor.isNativePlatform === "function" &&
        window.Capacitor.isNativePlatform()
    );
  } catch {
    return false;
  }
}

function absoluteHttpPhoto(src) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  if (/logo\.png(\?|$)/i.test(raw)) return "";
  if (/^https?:\/\//i.test(raw)) {
    if (raw.includes("localhost") || raw.includes("127.0.0.1")) return "";
    return raw;
  }
  if (raw.startsWith("/")) return `https://www.apex-ea.com${raw}`;
  return "";
}

function githubPhotoCandidates(botId) {
  const id = String(botId || "").trim();
  if (!id) return [];
  const enc = encodeURIComponent(id);
  return ["jpg", "jpeg", "png", "webp"].map((ext) => `${GITHUB_RAW_BASE}/${enc}.${ext}`);
}

/** Shrink blob/data images so Intent extras stay under the Binder limit. */
async function compressToDataUrl(src, size = 160) {
  const raw = String(src || "").trim();
  if (!raw) return "";
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image load failed"));
      el.crossOrigin = "anonymous";
      el.src = raw;
    });
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, size / Math.max(img.width || size, img.height || size, 1));
    canvas.width = Math.max(1, Math.round((img.width || size) * scale));
    canvas.height = Math.max(1, Math.round((img.height || size) * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return /^data:image\//i.test(raw) ? raw : "";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return /^data:image\//i.test(raw) ? raw : "";
  }
}

/**
 * Build a photo URL the Android overlay can actually decode.
 * WebView blob: URLs are invalid outside the WebView — convert or use HTTPS.
 */
export async function prepareOverlayPhoto({ photoSrc, remoteSrc, botId } = {}) {
  const httpRemote = absoluteHttpPhoto(remoteSrc);
  if (httpRemote) return httpRemote;

  const raw = String(photoSrc || "").trim();
  const httpPhoto = absoluteHttpPhoto(raw);
  if (httpPhoto) return httpPhoto;

  if (/^data:image\//i.test(raw) || raw.startsWith("blob:")) {
    const compressed = await compressToDataUrl(raw);
    if (compressed) return compressed;
  }

  const github = githubPhotoCandidates(botId);
  if (github.length) return github[0];

  return "";
}

export async function floatOverlayAvailable() {
  if (!isNative()) return false;
  try {
    const result = await FloatOverlay.checkPermission();
    return Boolean(result?.granted);
  } catch {
    return false;
  }
}

/** Ask once for “Display over other apps” so the bubble can sit on MetaTrader. */
export async function ensureFloatOverlayPermission(showToast) {
  if (!isNative()) return false;
  try {
    const status = await FloatOverlay.checkPermission();
    if (status?.granted) return true;
    let prompted = false;
    try {
      prompted = sessionStorage.getItem(PROMPT_KEY) === "1";
    } catch {
      // ignore
    }
    if (!prompted) {
      try {
        sessionStorage.setItem(PROMPT_KEY, "1");
      } catch {
        // ignore
      }
      showToast?.(
        "Allow Display over other apps so the robot bubble stays on MetaTrader"
      );
      await FloatOverlay.requestPermission();
    }
    const again = await FloatOverlay.checkPermission();
    return Boolean(again?.granted);
  } catch {
    return false;
  }
}

export async function showFloatOverlay({
  photoSrc,
  remoteSrc,
  botId,
  x = -1,
  y = -1,
  label = "Trade bubble",
  historyText = "",
  openHistory = false,
} = {}) {
  if (!isNative()) return false;
  try {
    const photoUrl = await prepareOverlayPhoto({ photoSrc, remoteSrc, botId });
    await FloatOverlay.show({
      photoUrl,
      botId: String(botId || ""),
      x: Number.isFinite(x) ? x : -1,
      y: Number.isFinite(y) ? y : -1,
      label: String(label || "Trade bubble"),
      historyText: String(historyText || ""),
      openHistory: Boolean(openHistory),
    });
    return true;
  } catch {
    return false;
  }
}

export async function updateFloatOverlay({
  photoSrc,
  remoteSrc,
  botId,
  x = -1,
  y = -1,
  label = "Trade bubble",
  historyText = "",
  openHistory = false,
} = {}) {
  if (!isNative()) return false;
  try {
    const photoUrl = await prepareOverlayPhoto({ photoSrc, remoteSrc, botId });
    await FloatOverlay.update({
      photoUrl,
      botId: String(botId || ""),
      x: Number.isFinite(x) ? x : -1,
      y: Number.isFinite(y) ? y : -1,
      label: String(label || "Trade bubble"),
      historyText: String(historyText || ""),
      openHistory: Boolean(openHistory),
    });
    return true;
  } catch {
    return false;
  }
}

export async function hideFloatOverlay() {
  if (!isNative()) return;
  try {
    await FloatOverlay.hide();
  } catch {
    // ignore
  }
}
