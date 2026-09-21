/** Live production API host — secrets stay on Vercel. */
export const PROD_API_ORIGIN = "https://www.apex-ea.com";

/** Native Capacitor shell (or local Vite) is not same-origin with apex-ea.com. */
export function needsAbsoluteApi() {
  if (typeof window === "undefined") return false;
  try {
    if (
      window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === "function" &&
      window.Capacitor.isNativePlatform()
    ) {
      return true;
    }
  } catch {
    // ignore
  }
  const host = String(window.location?.hostname || "");
  return host === "localhost" || host === "127.0.0.1";
}

/** Prefix `/api/...` paths with production origin when the UI is not on apex-ea.com. */
export function apiUrl(path = "/") {
  const raw = String(path || "/");
  if (/^https?:\/\//i.test(raw)) return raw;
  const p = raw.startsWith("/") ? raw : `/${raw}`;
  return needsAbsoluteApi() ? `${PROD_API_ORIGIN}${p}` : p;
}

/**
 * Resolve media/src values for <img> and fetch.
 * Keeps data URLs and absolute URLs; absolutizes `/api/...` on native.
 * Local static assets (`/logo.png`) stay relative so they load from the APK.
 */
export function mediaUrl(src) {
  const value = String(src || "").trim();
  if (!value) return value;
  if (
    /^https?:\/\//i.test(value) ||
    value.startsWith("data:") ||
    value.startsWith("blob:")
  ) {
    return value;
  }
  if (value.startsWith("/api/")) return apiUrl(value);
  return value;
}

/**
 * Home / hero / orb display source for a bot.
 * Prefer instant local bytes (data URL / packaged asset) so first paint is never
 * blocked on /api/licenses/photo. Only use the API path when the bot record
 * already points there (real uploaded photo).
 */
const GITHUB_EA_PHOTO_BASE =
  "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/data/ea-photos";

/** Absolute URLs that can paint an EA photo in a WebView <img> (no fetch/CORS). */
export function eaPhotoCandidates(bot) {
  const id = String(bot?.id || "").trim();
  const photo = String(bot?.photo || "").trim();
  const list = [];
  const push = (value) => {
    const src = String(value || "").trim();
    if (!src || list.includes(src) || /logo\.png(\?|$)/i.test(src)) return;
    list.push(src);
  };

  if (photo.startsWith("data:image/") || photo.startsWith("blob:")) push(photo);
  if (/^https?:\/\//i.test(photo)) push(photo);
  if (photo.startsWith("/api/")) push(mediaUrl(photo));
  if (id) {
    const enc = encodeURIComponent(id);
    push(`https://www.apex-ea.com/api/licenses/photo?botId=${enc}&v=full`);
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
      push(`${GITHUB_EA_PHOTO_BASE}/${enc}.${ext}`);
    }
  }
  return list;
}

export function resolveBotPhotoSrc(bot, fallback = "/logo.png") {
  const photo = String(bot?.photo || "").trim();
  const fb = fallback || "/logo.png";

  // Instant local / absolute sources — never block first paint on a network hop.
  if (photo.startsWith("data:image/") || photo.startsWith("blob:")) return photo;
  if (/^https?:\/\//i.test(photo)) return photo;
  if (photo.startsWith("/api/licenses/photo")) return mediaUrl(photo);

  // Packaged / static assets (including /logo.png) — paint immediately.
  if (photo && photo !== "/logo.png") return mediaUrl(photo);
  return fb;
}
