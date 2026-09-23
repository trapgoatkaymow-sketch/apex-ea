import { getOrCreateDeviceId } from "./deviceId.js";

const STORAGE_KEY = "apexea-device-access-v1";

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!raw || typeof raw !== "object") return {};
    return raw;
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // ignore quota
  }
}

/** Remember that this phone already unlocked access for an email (paid or bypass). */
export function rememberDeviceAccess(email, { paid = false, bypassed = false } = {}) {
  const key = normalizeEmail(email);
  if (!key.includes("@")) return null;
  const deviceId = getOrCreateDeviceId();
  const store = readStore();
  const device = store[deviceId] && typeof store[deviceId] === "object" ? store[deviceId] : {};
  const prev = device[key] && typeof device[key] === "object" ? device[key] : {};
  const nextPaid = Boolean(paid);
  const nextBypassed = Boolean(bypassed);
  device[key] = {
    email: key,
    // Explicit flags from caller win — do not sticky-OR bypass into paid.
    paid: nextPaid,
    bypassed: nextBypassed,
    unlockedAt: Number(prev.unlockedAt) || Date.now(),
    updatedAt: Date.now(),
  };
  store[deviceId] = device;
  writeStore(store);
  return device[key];
}

/** Clear admin bypass memory for an email on this device (paid flag kept). */
export function clearDeviceBypass(email) {
  const key = normalizeEmail(email);
  if (!key.includes("@")) return null;
  const deviceId = getOrCreateDeviceId();
  const store = readStore();
  const device = store[deviceId] && typeof store[deviceId] === "object" ? store[deviceId] : {};
  const prev = device[key] && typeof device[key] === "object" ? device[key] : null;
  if (!prev) return null;
  if (prev.paid) {
    device[key] = {
      ...prev,
      bypassed: false,
      updatedAt: Date.now(),
    };
  } else {
    delete device[key];
  }
  store[deviceId] = device;
  writeStore(store);
  return device[key] || null;
}

/** Fully forget device unlock for an email (forces subscription paywall again). */
export function clearDeviceAccess(email) {
  const key = normalizeEmail(email);
  if (!key.includes("@")) return null;
  const deviceId = getOrCreateDeviceId();
  const store = readStore();
  const device = store[deviceId] && typeof store[deviceId] === "object" ? store[deviceId] : {};
  if (!device[key]) return null;
  delete device[key];
  store[deviceId] = device;
  writeStore(store);
  return null;
}

function readDeviceRow(email) {
  const key = normalizeEmail(email);
  if (!key.includes("@")) return null;
  const deviceId = getOrCreateDeviceId();
  const row = readStore()?.[deviceId]?.[key];
  if (!row || typeof row !== "object") return null;
  return row;
}

/** True when this phone previously paid (subscription) for the email. */
export function hasDevicePaidAccess(email) {
  const row = readDeviceRow(email);
  return Boolean(row?.paid);
}

/** True when this phone previously had admin bypass for the email. */
export function hasDeviceBypassAccess(email) {
  const row = readDeviceRow(email);
  return Boolean(row?.bypassed) && !row?.paid;
}

/**
 * True when this phone previously paid or was bypassed for the email.
 * Stale bypass-only stamps without paid still count as bypass until cleared.
 */
export function hasDeviceAccess(email) {
  const row = readDeviceRow(email);
  if (!row) return false;
  return Boolean(row.paid || row.bypassed);
}

/** License was already activated on this exact phone. */
export function isLicenseBoundToThisDevice(license) {
  const bound = String(license?.deviceId || "").trim();
  if (!bound) return false;
  return bound === getOrCreateDeviceId();
}

/**
 * True when this account already paid the subscription or still has admin bypass.
 * Approved status / unlock stamps alone do NOT skip payment.
 */
export function isAccountPaidOrBypassed(signup) {
  if (!signup || typeof signup !== "object") return false;
  if (signup.accessPaid) return true;
  if (signup.accessBypassed) return true;
  return false;
}

/**
 * Payment unlock for CoverLock:
 * Subscription (accessPaid) or active admin bypass only.
 */
export function hasPaidOnThisDevice(email) {
  return hasDevicePaidAccess(email);
}

export function isSignupEntitled(signup, email = "") {
  if (isAccountPaidOrBypassed(signup)) return true;
  const key = email || signup?.email;
  // Offline returning paid subscribers only — never treat old bypass cache as paid.
  return hasDevicePaidAccess(key);
}
