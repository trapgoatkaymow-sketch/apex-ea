import { registerPlugin } from "@capacitor/core";

const FloatOverlay = registerPlugin("FloatOverlay");

const PROMPT_KEY = "apexea-float-overlay-prompted";

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

function absolutePhotoUrl(src) {
  const raw = String(src || "").trim();
  if (!raw) return "https://www.apex-ea.com/logo.png";
  if (/^data:image\//i.test(raw) || /^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `https://www.apex-ea.com${raw}`;
  return raw;
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
  x = -1,
  y = -1,
  label = "Trade bubble",
} = {}) {
  if (!isNative()) return false;
  try {
    await FloatOverlay.show({
      photoUrl: absolutePhotoUrl(photoSrc),
      x: Number.isFinite(x) ? x : -1,
      y: Number.isFinite(y) ? y : -1,
      label: String(label || "Trade bubble"),
    });
    return true;
  } catch {
    return false;
  }
}

export async function updateFloatOverlay({
  photoSrc,
  x = -1,
  y = -1,
  label = "Trade bubble",
} = {}) {
  if (!isNative()) return false;
  try {
    await FloatOverlay.update({
      photoUrl: absolutePhotoUrl(photoSrc),
      x: Number.isFinite(x) ? x : -1,
      y: Number.isFinite(y) ? y : -1,
      label: String(label || "Trade bubble"),
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
