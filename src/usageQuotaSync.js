/**
 * Sync daily START + scan remainders onto the active license so a reinstall
 * or same-key re-activate restores what the client had left for that day.
 */
import { getOrCreateDeviceId } from "./deviceId.js";
import { syncUsageQuotaRemote } from "./licensesApi.js";
import {
  SCAN_QUOTA_V2,
  SCAN_QUOTA_ZETA,
  applyRemoteUsageQuota,
  readLocalUsageSnapshot,
} from "./scanQuota.js";
import { START_QUOTA_DAILY, applyRemoteStartsQuota } from "./startQuota.js";

let activeLicenseKey = "";
let activeEmail = "";
let syncTimer = null;
let syncInFlight = false;

export function setUsageQuotaSyncTarget({ licenseKey = "", email = "" } = {}) {
  activeLicenseKey = String(licenseKey || "")
    .trim()
    .toUpperCase();
  activeEmail = String(email || "")
    .trim()
    .toLowerCase();
}

export function getUsageQuotaSyncTarget() {
  return { licenseKey: activeLicenseKey, email: activeEmail };
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Build the payload from local stores (same calendar day). */
export function buildLocalUsageQuota() {
  const snap = readLocalUsageSnapshot();
  const day = todayKey();
  return {
    day,
    startsLeft: Math.max(
      0,
      Math.min(
        START_QUOTA_DAILY,
        Number.isFinite(Number(snap?.startsLeft))
          ? Math.floor(Number(snap.startsLeft))
          : START_QUOTA_DAILY
      )
    ),
    zeta: Math.max(
      0,
      Math.min(
        SCAN_QUOTA_ZETA,
        Number.isFinite(Number(snap?.zeta))
          ? Math.floor(Number(snap.zeta))
          : SCAN_QUOTA_ZETA
      )
    ),
    v2: Math.max(
      0,
      Math.min(
        SCAN_QUOTA_V2,
        Number.isFinite(Number(snap?.v2))
          ? Math.floor(Number(snap.v2))
          : SCAN_QUOTA_V2
      )
    ),
    updatedAt: Date.now(),
  };
}

/**
 * Restore local START/scan remainders from a license.usageQuota row.
 * force=true overwrites local (activate / reclaim). Otherwise take the
 * lower remainder per bucket so a fresh reinstall (full local) snaps down
 * to the server value without raising a mid-day local count.
 */
export function restoreUsageQuotaFromLicense(usageQuota, { force = false } = {}) {
  if (!usageQuota || typeof usageQuota !== "object") return null;
  const day = String(usageQuota.day || "").trim();
  if (day !== todayKey()) return null;

  const starts = applyRemoteStartsQuota(usageQuota.startsLeft, { force, day });
  const scans = applyRemoteUsageQuota(
    { day, zeta: usageQuota.zeta, v2: usageQuota.v2 },
    { force }
  );
  const result = {
    day,
    startsLeft: starts,
    zeta: scans?.zeta,
    v2: scans?.v2,
  };
  try {
    window.dispatchEvent(
      new CustomEvent("apexea-usage-quota", { detail: result })
    );
  } catch {
    // ignore (SSR / non-DOM)
  }
  return result;
}

async function pushUsageQuotaNow() {
  const key = activeLicenseKey;
  if (!key || syncInFlight) return null;
  syncInFlight = true;
  try {
    const usageQuota = buildLocalUsageQuota();
    const remote = await syncUsageQuotaRemote(key, usageQuota, {
      deviceId: getOrCreateDeviceId(),
      email: activeEmail,
    });
    return remote;
  } catch {
    return null;
  } finally {
    syncInFlight = false;
  }
}

/** Debounced push after START / scan consume. */
export function scheduleUsageQuotaSync(delayMs = 400) {
  if (!activeLicenseKey) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void pushUsageQuotaNow();
  }, Math.max(0, Number(delayMs) || 0));
}

/** Immediate push (activate / before unload). */
export function flushUsageQuotaSync() {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  return pushUsageQuotaNow();
}
