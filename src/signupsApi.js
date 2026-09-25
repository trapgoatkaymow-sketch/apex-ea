import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/signups";
const DELETED_SIGNUPS_STORAGE = "apexea-deleted-signup-emails-v1";

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function readDeletedSignupMap() {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(DELETED_SIGNUPS_STORAGE);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const email = normalizeEmail(k);
      if (!email || !email.includes("@")) continue;
      out[email] = Number(v) || Date.now();
    }
    return out;
  } catch {
    return {};
  }
}

function writeDeletedSignupMap(map) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DELETED_SIGNUPS_STORAGE, JSON.stringify(map || {}));
  } catch {
    // quota — ignore
  }
}

/** Remember a permanently deleted access email so refresh cannot resurrect it. */
export function rememberDeletedSignupEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email || !email.includes("@")) return;
  const map = readDeletedSignupMap();
  map[email] = Date.now();
  writeDeletedSignupMap(map);
}

export function forgetDeletedSignupEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return;
  const map = readDeletedSignupMap();
  if (!(email in map)) return;
  delete map[email];
  writeDeletedSignupMap(map);
}

export function isRememberedDeletedSignupEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;
  return Boolean(readDeletedSignupMap()[email]);
}

export function filterOutDeletedSignups(list = []) {
  return (Array.isArray(list) ? list : []).filter(
    (row) => !isRememberedDeletedSignupEmail(row?.email)
  );
}

async function apiFetch(path = "", { method = "GET", body } = {}) {
  const response = await fetch(`${apiUrl(API_PATH)}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      (data && (data.error || data.message)) ||
      (typeof data === "string" ? data : `Signup sync failed (${response.status})`);
    throw new Error(message);
  }
  return data;
}

export async function fetchSignups() {
  const data = await apiFetch();
  const list = Array.isArray(data?.signups) ? data.signups : [];
  return filterOutDeletedSignups(list);
}

export async function submitSignup(email) {
  forgetDeletedSignupEmail(email);
  const data = await apiFetch("", {
    method: "POST",
    body: { email, status: "pending" },
  });
  return data?.signup || null;
}

export async function updateSignupStatus(email, status) {
  const data = await apiFetch("", {
    method: "PATCH",
    body: { email, status },
  });
  return data?.signup || null;
}

export async function updateSignupPremiumScanner(email) {
  const data = await apiFetch("", {
    method: "PATCH",
    body: { email, premiumScanner: true, action: "premiumScanner" },
  });
  return data?.signup || null;
}

export async function updateSignupAccessPaid(email) {
  const data = await apiFetch("", {
    method: "PATCH",
    body: { email, accessPaid: true, action: "accessPaid" },
  });
  return data?.signup || null;
}

export async function updateSignupAccessBypassed(email) {
  const data = await apiFetch("", {
    method: "PATCH",
    body: { email, accessBypassed: true, action: "accessBypass" },
  });
  return data?.signup || null;
}

export async function clearSignupAccessBypassed(email) {
  const data = await apiFetch("", {
    method: "PATCH",
    body: { email, accessBypassed: false, action: "clearAccessBypass" },
  });
  return data?.signup || null;
}

/** Super admin — permanently remove an access/signup email. */
export async function deleteSignupRemote(email, adminEmail) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    throw new Error("Enter a valid email");
  }
  const data = await apiFetch("", {
    method: "PATCH",
    body: {
      email: key,
      action: "delete",
      adminEmail: normalizeEmail(adminEmail),
    },
  });
  rememberDeletedSignupEmail(key);
  return data;
}

export function mergeSignups(localList = [], remoteList = []) {
  const map = new Map();
  [...localList, ...remoteList].forEach((item) => {
    const email = String(item?.email || "")
      .trim()
      .toLowerCase();
    if (!email) return;
    if (isRememberedDeletedSignupEmail(email)) return;
    const prev = map.get(email);
    if (!prev) {
      map.set(email, {
        email,
        status: String(item.status || "pending").toLowerCase(),
        createdAt: Number(item.createdAt) || Date.now(),
        premiumScanner: Boolean(item.premiumScanner),
        premiumScannerAt: item.premiumScannerAt
          ? Number(item.premiumScannerAt)
          : null,
        accessPaid: Boolean(item.accessPaid),
        accessPaidAt: item.accessPaidAt ? Number(item.accessPaidAt) : null,
        accessBypassed: Boolean(item.accessBypassed),
        accessBypassedAt: item.accessBypassedAt
          ? Number(item.accessBypassedAt)
          : null,
        appAccessUnlockedAt: item.appAccessUnlockedAt
          ? Number(item.appAccessUnlockedAt)
          : null,
      });
      return;
    }
    const remoteCleared =
      item.accessPaid === false &&
      item.accessBypassed === false &&
      (String(item.status || "").toLowerCase() === "pending" ||
        String(item.status || "").toLowerCase() === "declined");
    if (remoteCleared) {
      map.set(email, {
        email,
        status: String(item.status || "pending").toLowerCase(),
        createdAt: Math.min(
          Number(prev.createdAt) || Date.now(),
          Number(item.createdAt) || Date.now()
        ),
        premiumScanner: Boolean(prev.premiumScanner || item.premiumScanner),
        premiumScannerAt: Math.max(
          Number(prev.premiumScannerAt) || 0,
          Number(item.premiumScannerAt) || 0
        ) || null,
        accessPaid: false,
        accessPaidAt: null,
        accessBypassed: false,
        accessBypassedAt: null,
        appAccessUnlockedAt: null,
      });
      return;
    }
    const rank = { declined: 0, pending: 1, approved: 2 };
    const nextStatus =
      (rank[item.status] || 0) >= (rank[prev.status] || 0)
        ? String(item.status || prev.status).toLowerCase()
        : prev.status;
    const premiumScanner = Boolean(prev.premiumScanner || item.premiumScanner);
    const premiumScannerAt = Math.max(
      Number(prev.premiumScannerAt) || 0,
      Number(item.premiumScannerAt) || 0
    );
    const accessPaid =
      item.accessPaid === false
        ? false
        : Boolean(prev.accessPaid || item.accessPaid);
    const accessPaidAt = accessPaid
      ? Math.max(Number(prev.accessPaidAt) || 0, Number(item.accessPaidAt) || 0)
      : 0;
    // Explicit false clears bypass (admin remove); otherwise keep OR so sync never loses it.
    const accessBypassed =
      item.accessBypassed === false
        ? false
        : Boolean(prev.accessBypassed || item.accessBypassed);
    const accessBypassedAt = accessBypassed
      ? Math.max(
          Number(prev.accessBypassedAt) || 0,
          Number(item.accessBypassedAt) || 0
        )
      : 0;
    const unlockStamps = [prev.appAccessUnlockedAt, item.appAccessUnlockedAt]
      .map((n) => Number(n) || 0)
      .filter((n) => n > 0);
    const appAccessUnlockedAt =
      item.appAccessUnlockedAt === null || item.appAccessUnlockedAt === 0
        ? null
        : unlockStamps.length
          ? Math.min(...unlockStamps)
          : null;
    map.set(email, {
      email,
      status: nextStatus,
      createdAt: Math.min(Number(prev.createdAt) || Date.now(), Number(item.createdAt) || Date.now()),
      premiumScanner,
      premiumScannerAt: premiumScanner ? premiumScannerAt || null : null,
      accessPaid,
      accessPaidAt: accessPaid ? accessPaidAt || null : null,
      accessBypassed,
      accessBypassedAt: accessBypassed ? accessBypassedAt || null : null,
      appAccessUnlockedAt,
    });
  });
  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
