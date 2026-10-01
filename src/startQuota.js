/** Daily START / TRADE button chances — resets each local calendar day. */
export const START_QUOTA_DAILY = 10;
const START_STORE_KEY = "apexea-daily-starts-v1";

/** In-memory fallback when localStorage is full (Android WebView). */
let memoryStartStore = null;

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function readStartStore() {
  if (memoryStartStore && typeof memoryStartStore === "object") {
    return memoryStartStore;
  }
  try {
    const raw = localStorage.getItem(START_STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    memoryStartStore = data;
    return data;
  } catch {
    return memoryStartStore;
  }
}

function writeStartStore(data) {
  memoryStartStore = data;
  try {
    localStorage.setItem(START_STORE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Remaining START presses for today (resets at local midnight). */
export function loadStartsLeft() {
  const day = todayKey();
  const prev = readStartStore();
  if (!prev || prev.day !== day) {
    const fresh = { day, left: START_QUOTA_DAILY };
    writeStartStore(fresh);
    return fresh.left;
  }
  const value = Number(prev.left);
  if (!Number.isFinite(value)) {
    const next = { day, left: START_QUOTA_DAILY };
    writeStartStore(next);
    return START_QUOTA_DAILY;
  }
  return Math.max(0, Math.floor(value));
}

export function saveStartsLeft(value) {
  const day = todayKey();
  const next = {
    day,
    left: Math.max(0, Math.floor(Number(value) || 0)),
  };
  writeStartStore(next);
  return next.left;
}

/**
 * Restore START remainders from a license.usageQuota row.
 * force=true overwrites; otherwise keep the lower of local vs remote.
 */
export function applyRemoteStartsQuota(remoteLeft, { force = false, day = "" } = {}) {
  const today = todayKey();
  const stamp = String(day || today).trim() || today;
  if (stamp !== today) return loadStartsLeft();
  const remote = Math.floor(Number(remoteLeft));
  if (!Number.isFinite(remote)) return loadStartsLeft();
  const capped = Math.max(0, Math.min(START_QUOTA_DAILY, remote));
  if (force) {
    return saveStartsLeft(capped);
  }
  const local = loadStartsLeft();
  return saveStartsLeft(Math.min(local, capped));
}

/**
 * Consume one START chance. Returns { ok, left }.
 * When left is already 0, ok is false and left stays 0.
 */
export function consumeStartChance() {
  const live = loadStartsLeft();
  if (live <= 0) {
    return { ok: false, left: 0 };
  }
  const left = saveStartsLeft(live - 1);
  try {
    // Keep license.usageQuota in sync so reinstall restores remaining START.
    import("./usageQuotaSync.js").then((mod) => {
      mod.scheduleUsageQuotaSync?.();
    });
  } catch {
    // ignore
  }
  return { ok: true, left };
}

/** True when the user can press START today. */
export function canStartToday() {
  return loadStartsLeft() > 0;
}
