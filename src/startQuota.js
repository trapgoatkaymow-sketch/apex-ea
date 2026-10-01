/** Daily START / TRADE button chances — resets each local calendar day. */
export const START_QUOTA_DAILY = 10;
const START_STORE_KEY = "apexea-daily-starts-v1";
const START_GRANT_KEY = "apexea-start-reset-applied-v1";

/** In-memory fallback when localStorage is full (Android WebView). */
let memoryStartStore = null;
let memoryStartGrant = null;

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
 * Consume one START chance. Returns { ok, left }.
 * When left is already 0, ok is false and left stays 0.
 */
export function consumeStartChance() {
  const live = loadStartsLeft();
  if (live <= 0) {
    return { ok: false, left: 0 };
  }
  const left = saveStartsLeft(live - 1);
  return { ok: true, left };
}

/** True when the user can press START today. */
export function canStartToday() {
  return loadStartsLeft() > 0;
}

function readAppliedStartGrant() {
  if (memoryStartGrant && typeof memoryStartGrant === "object") {
    return memoryStartGrant;
  }
  try {
    const raw = localStorage.getItem(START_GRANT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    memoryStartGrant = data;
    return data;
  } catch {
    return memoryStartGrant;
  }
}

function writeAppliedStartGrant(data) {
  memoryStartGrant = data;
  try {
    localStorage.setItem(START_GRANT_KEY, JSON.stringify(data));
  } catch {
    // ignore quota
  }
}

function localDayFromTs(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startGrantIsForToday(grant) {
  if (!grant || typeof grant !== "object") return false;
  const resetAt = Number(grant.resetAt) || 0;
  if (!resetAt) return false;
  const today = todayKey();
  const stamped = String(grant.day || "").trim();
  const stampedUtc = String(grant.dayUtc || "").trim();
  return (
    stamped === today ||
    stampedUtc === today ||
    localDayFromTs(resetAt) === today
  );
}

/**
 * Apply a super-admin START chance reset grant from the license record.
 * Refills today's START / TRADE button chances.
 */
export function applyRemoteStartGrant(grant) {
  if (!startGrantIsForToday(grant)) return null;
  const resetAt = Number(grant.resetAt) || 0;
  const day = todayKey();
  const token = `${day}:${resetAt}`;
  const prev = readAppliedStartGrant();
  if (prev?.token === token) {
    return { applied: false, left: loadStartsLeft() };
  }
  const left = saveStartsLeft(START_QUOTA_DAILY);
  writeAppliedStartGrant({ token, day, resetAt, appliedAt: Date.now() });
  try {
    window.dispatchEvent(
      new CustomEvent("apexea-start-quota-reset", { detail: { left } })
    );
  } catch {
    // ignore
  }
  return { applied: true, left };
}

/** Pick the newest same-day startReset from a list of licenses. */
export function pickLatestStartGrant(licenses = []) {
  let best = null;
  for (const row of Array.isArray(licenses) ? licenses : []) {
    const grant = row?.startReset;
    if (!startGrantIsForToday(grant)) continue;
    const resetAt = Number(grant.resetAt) || 0;
    if (!best || resetAt > Number(best.resetAt || 0)) best = grant;
  }
  return best;
}
