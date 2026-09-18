const DEVICE_ID_KEY = "apexea-device-id";
const DEVICE_ID_COOKIE = "apexea_device_id";

function readCookie(name) {
  try {
    if (typeof document === "undefined") return "";
    const match = String(document.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`));
    if (!match) return "";
    return decodeURIComponent(match.slice(name.length + 1)).trim();
  } catch {
    return "";
  }
}

function writeCookie(name, value) {
  try {
    if (typeof document === "undefined") return;
    const maxAge = 60 * 60 * 24 * 400; // ~13 months
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
  } catch {
    // ignore
  }
}

function makeDeviceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Stable per-browser id so a used license stays locked to the first phone.
 * Persist in both localStorage and a cookie so Android WebView / storage
 * pressure clears do not mint a new id and false-trigger "another phone".
 */
export function getOrCreateDeviceId() {
  try {
    const fromStorage = String(localStorage.getItem(DEVICE_ID_KEY) || "").trim();
    const fromCookie = readCookie(DEVICE_ID_COOKIE);
    const existing = fromStorage || fromCookie;
    if (existing) {
      if (!fromStorage) {
        try {
          localStorage.setItem(DEVICE_ID_KEY, existing);
        } catch {
          // quota — cookie still holds it
        }
      }
      if (!fromCookie || fromCookie !== existing) writeCookie(DEVICE_ID_COOKIE, existing);
      return existing;
    }
    const id = makeDeviceId();
    try {
      localStorage.setItem(DEVICE_ID_KEY, id);
    } catch {
      // ignore quota
    }
    writeCookie(DEVICE_ID_COOKIE, id);
    return id;
  } catch {
    const fromCookie = readCookie(DEVICE_ID_COOKIE);
    if (fromCookie) return fromCookie;
    return `dev-temp-${Date.now().toString(36)}`;
  }
}
