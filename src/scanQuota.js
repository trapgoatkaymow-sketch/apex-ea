/** Daily scan quotas — Interface 1 (Zeta) vs Interface 2 (V2). */
export const SCAN_QUOTA_ZETA = 10;
export const SCAN_QUOTA_V2 = 20;
const SCANS_STORE_KEY = "apexea-daily-scans-v1";

/** In-memory fallback when localStorage is full (common on Android WebView). */
let memoryScanStore = null;

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function scanBucket(variant) {
  return variant === "v2" ? "v2" : "zeta";
}

export function scanQuota(variant) {
  return scanBucket(variant) === "v2" ? SCAN_QUOTA_V2 : SCAN_QUOTA_ZETA;
}

function readScanStore() {
  if (memoryScanStore && typeof memoryScanStore === "object") {
    return memoryScanStore;
  }
  try {
    const raw = localStorage.getItem(SCANS_STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    memoryScanStore = data;
    return data;
  } catch {
    return memoryScanStore;
  }
}

function writeScanStore(data) {
  memoryScanStore = data;
  try {
    localStorage.setItem(SCANS_STORE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Remaining scans for this interface today (resets each local calendar day). */
export function loadScansLeft(variant) {
  const bucket = scanBucket(variant);
  const quota = scanQuota(variant);
  const day = todayKey();
  const prev = readScanStore();
  if (!prev || prev.day !== day) {
    const fresh = { day, zeta: SCAN_QUOTA_ZETA, v2: SCAN_QUOTA_V2 };
    writeScanStore(fresh);
    return fresh[bucket];
  }
  const value = Number(prev[bucket]);
  if (!Number.isFinite(value)) {
    const next = { ...prev, day, [bucket]: quota };
    writeScanStore(next);
    return quota;
  }
  return Math.max(0, Math.floor(value));
}

export function saveScansLeft(variant, value) {
  const bucket = scanBucket(variant);
  const day = todayKey();
  const prev = readScanStore();
  const next = {
    day,
    zeta:
      prev?.day === day && Number.isFinite(Number(prev.zeta))
        ? Math.max(0, Math.floor(Number(prev.zeta)))
        : SCAN_QUOTA_ZETA,
    v2:
      prev?.day === day && Number.isFinite(Number(prev.v2))
        ? Math.max(0, Math.floor(Number(prev.v2)))
        : SCAN_QUOTA_V2,
  };
  next[bucket] = Math.max(0, Math.floor(Number(value) || 0));
  writeScanStore(next);
  return next[bucket];
}

/** Consume one scan after a successful analysis. Returns the new remaining count. */
export function consumeScan(variant) {
  // Always re-read so a new calendar day refreshes quota before decrementing.
  const live = loadScansLeft(variant);
  return saveScansLeft(variant, Math.max(0, live - 1));
}
