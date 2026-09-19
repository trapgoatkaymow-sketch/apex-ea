import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/licenses";

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
      (typeof data === "string" ? data : `License sync failed (${response.status})`);
    throw new Error(message);
  }
  return data;
}

export function normalizeLicenseKey(key) {
  return String(key || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    // Phones often show/slash-zero as Ø; treat as digit 0.
    .replace(/[ØÖ⌀∅]/g, "0")
    .replace(/[^A-Z0-9-]/g, "");
}

/** APEXXXXXXXXX → APEX-XXXX-XXXX when hyphens were dropped. */
export function formatLicenseKey(key) {
  const compact = normalizeLicenseKey(key).replace(/-/g, "");
  if (/^APEX[A-Z0-9]{8}$/.test(compact)) {
    return `APEX-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
  }
  return normalizeLicenseKey(key);
}

const DELETED_KEYS_STORAGE = "apexea-deleted-license-keys-v1";

function readDeletedKeyMap() {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(DELETED_KEYS_STORAGE);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const key = normalizeLicenseKey(k);
      if (!key) continue;
      out[key] = Number(v) || Date.now();
    }
    return out;
  } catch {
    return {};
  }
}

function writeDeletedKeyMap(map) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DELETED_KEYS_STORAGE, JSON.stringify(map || {}));
  } catch {
    // quota — ignore
  }
}

/** Remember a permanently deleted key so refresh/migrate cannot resurrect it. */
export function rememberDeletedLicenseKey(rawKey) {
  const key = normalizeLicenseKey(rawKey);
  if (!key) return;
  const map = readDeletedKeyMap();
  map[key] = Date.now();
  for (const variant of licenseKeyVariants(key)) map[variant] = map[key];
  writeDeletedKeyMap(map);
}

/** Clear a local tombstone when the server still has the key. */
export function forgetDeletedLicenseKey(rawKey) {
  const key = normalizeLicenseKey(rawKey);
  if (!key) return;
  const map = readDeletedKeyMap();
  let changed = false;
  for (const variant of licenseKeyVariants(key)) {
    if (map[variant]) {
      delete map[variant];
      changed = true;
    }
  }
  if (changed) writeDeletedKeyMap(map);
}

export function rememberDeletedLicenseKeys(input) {
  if (!input) return;
  const map = readDeletedKeyMap();
  let changed = false;
  if (Array.isArray(input)) {
    for (const raw of input) {
      const key = normalizeLicenseKey(raw);
      if (!key || map[key]) continue;
      map[key] = Date.now();
      changed = true;
    }
  } else if (typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      const key = normalizeLicenseKey(k);
      if (!key) continue;
      const at = Number(v) || Date.now();
      if (!map[key] || at > map[key]) {
        map[key] = at;
        changed = true;
      }
    }
  }
  if (changed) writeDeletedKeyMap(map);
}

export function isRememberedDeletedLicenseKey(rawKey) {
  const key = normalizeLicenseKey(rawKey);
  if (!key) return false;
  const map = readDeletedKeyMap();
  return Boolean(map[key]) || licenseKeyVariants(key).some((v) => Boolean(map[v]));
}

export function filterOutDeletedLicenses(list = []) {
  return (Array.isArray(list) ? list : []).filter(
    (row) => !isRememberedDeletedLicenseKey(row?.key)
  );
}

export const LICENSE_DURATIONS = [
  { id: "1m", label: "1 month", months: 1 },
  { id: "3m", label: "3 months", months: 3 },
  { id: "2y", label: "2 years", months: 24 },
  { id: "lifetime", label: "Lifetime", months: null },
];

export function resolveLicenseExpiry(durationId, from = Date.now()) {
  const id = String(durationId || "lifetime")
    .trim()
    .toLowerCase();
  const preset = LICENSE_DURATIONS.find((item) => item.id === id);
  if (!preset || preset.months == null) {
    return { duration: "lifetime", expiresAt: null };
  }
  const start = new Date(Number(from) || Date.now());
  start.setMonth(start.getMonth() + preset.months);
  return { duration: preset.id, expiresAt: start.getTime() };
}

export function isLicenseExpired(row, now = Date.now()) {
  const expiresAt = Number(row?.expiresAt || 0);
  if (!expiresAt) return false;
  return expiresAt <= now;
}

export function formatLicenseDuration(row) {
  const id = String(row?.duration || "").toLowerCase();
  const preset = LICENSE_DURATIONS.find((item) => item.id === id);
  if (preset) return preset.label;
  if (!row?.expiresAt) return "Lifetime";
  return "Timed";
}

export function formatLicenseExpiry(row) {
  if (isLicenseExpired(row)) return "Expired";
  const expiresAt = Number(row?.expiresAt || 0);
  if (!expiresAt) return "No expiry";
  try {
    return `Expires ${new Date(expiresAt).toLocaleDateString()}`;
  } catch {
    return "Timed";
  }
}

/** Try common lookalike swaps so typed/OCR keys still match. */
export function licenseKeyVariants(rawKey) {
  const base = formatLicenseKey(rawKey);
  if (!base) return [];
  const out = new Set([base, base.replace(/-/g, "")]);
  const pairs = [
    ["0", "O"],
    ["1", "I"],
    ["1", "L"],
    ["5", "S"],
    ["8", "B"],
    ["2", "Z"],
  ];
  const chars = [...base];
  for (let i = 0; i < chars.length; i += 1) {
    for (const [a, b] of pairs) {
      if (chars[i] === a || chars[i] === b) {
        const next = [...chars];
        next[i] = chars[i] === a ? b : a;
        const v = next.join("");
        out.add(v);
        out.add(v.replace(/-/g, ""));
      }
    }
  }
  return Array.from(out).filter(Boolean);
}

export function normalizeLicense(row) {
  const key = normalizeLicenseKey(row?.key);
  if (!key) return null;
  const bot = row?.bot && typeof row.bot === "object" ? row.bot : null;
  const clientEmail = String(row?.clientEmail || row?.email || "")
    .trim()
    .toLowerCase();
  const clientName = String(row?.clientName || row?.name || "").trim();
  const mentorName = String(row?.mentorName || row?.ownerName || "").trim();
  const mainText = String(row?.mainText || row?.username || clientName || "").trim();
  const deviceId = String(row?.deviceId || "").trim() || null;
  return {
    key,
    botId: String(row?.botId || bot?.id || "").trim(),
    botName: String(row?.botName || bot?.name || "Bot").trim() || "Bot",
    clientEmail,
    clientName,
    mainText,
    mentorEmail: String(row?.mentorEmail || row?.ownerEmail || "")
      .trim()
      .toLowerCase(),
    mentorId: String(row?.mentorId || row?.ownerId || "").trim(),
    mentorName,
    used: Boolean(row?.used),
    commissionEligible: Boolean(row?.commissionEligible),
    commissionReason: String(row?.commissionReason || "").trim(),
    duration: String(row?.duration || (row?.expiresAt ? "timed" : "lifetime")).trim() || "lifetime",
    expiresAt: row?.expiresAt == null || row?.expiresAt === ""
      ? null
      : Number(row.expiresAt) || null,
    createdAt: Number(row?.createdAt) || Date.now(),
    usedAt: row?.usedAt ? Number(row.usedAt) : null,
    deviceId,
    boundAt: row?.boundAt
      ? Number(row.boundAt)
      : deviceId
        ? Number(row?.usedAt) || null
        : null,
    updatedAt: Number(row?.updatedAt || row?.usedAt || row?.createdAt) || Date.now(),
    scanReset: (() => {
      const raw = row?.scanReset;
      if (!raw || typeof raw !== "object") return null;
      const day = String(raw.day || "").trim();
      const resetAt = Number(raw.resetAt) || 0;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !resetAt) return null;
      return {
        day,
        resetAt,
        grantedBy: String(raw.grantedBy || "")
          .trim()
          .toLowerCase(),
      };
    })(),
    robotAccountId: String(row?.robotAccountId || "").trim(),
    robotLogin: String(row?.robotLogin || "").trim(),
    robotServer: String(row?.robotServer || "").trim(),
    robotCompany: String(row?.robotCompany || "").trim(),
    robotPlatform: String(row?.robotPlatform || "").trim().toUpperCase() || "",
    robotConnectedAt: row?.robotConnectedAt ? Number(row.robotConnectedAt) : null,
    bot: bot
      ? {
          id: String(bot.id || row.botId || "").trim(),
          name: String(bot.name || row.botName || "Bot").trim() || "Bot",
          photo: String(bot.photo || "/logo.png"),
          strategy: String(bot.strategy || "scalper"),
          symbols: Array.isArray(bot.symbols)
            ? bot.symbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)
            : [],
        }
      : null,
  };
}

export function mergeLicenses(localList = [], remoteList = []) {
  const map = new Map();
  [...localList, ...remoteList].forEach((item) => {
    const row = normalizeLicense(item);
    if (!row) return;
    const prev = map.get(row.key);
    if (!prev) {
      map.set(row.key, row);
      return;
    }
    const preferIncoming = (row.updatedAt || 0) >= (prev.updatedAt || 0);
    map.set(row.key, {
      ...prev,
      ...row,
      clientEmail: row.clientEmail || prev.clientEmail || "",
      clientName: row.clientName || prev.clientName || "",
      mainText: row.mainText || prev.mainText || row.clientName || prev.clientName || "",
      mentorEmail: row.mentorEmail || prev.mentorEmail || "",
      mentorId: row.mentorId || prev.mentorId || "",
      mentorName: row.mentorName || prev.mentorName || "",
      duration: preferIncoming
        ? row.duration || prev.duration || "lifetime"
        : prev.duration || row.duration || "lifetime",
      expiresAt: preferIncoming
        ? row.expiresAt ?? prev.expiresAt ?? null
        : prev.expiresAt ?? row.expiresAt ?? null,
      // Newer updatedAt owns used/device lock. Do not OR an older used:true
      // onto a reactivated (used:false) row — that keeps "locked to another phone".
      used: preferIncoming ? Boolean(row.used) : Boolean(prev.used),
      usedAt: preferIncoming
        ? row.used
          ? row.usedAt || prev.usedAt || null
          : null
        : prev.used
          ? prev.usedAt || row.usedAt || null
          : null,
      deviceId: preferIncoming
        ? row.used
          ? row.deviceId || prev.deviceId || null
          : null
        : prev.used
          ? prev.deviceId || row.deviceId || null
          : null,
      boundAt: preferIncoming
        ? row.used
          ? row.boundAt || prev.boundAt || null
          : null
        : prev.used
          ? prev.boundAt || row.boundAt || null
          : null,
      commissionEligible: preferIncoming
        ? Boolean(row.commissionEligible)
        : Boolean(prev.commissionEligible || row.commissionEligible),
      commissionReason: preferIncoming
        ? row.commissionReason || prev.commissionReason || ""
        : prev.commissionReason || row.commissionReason || "",
      scanReset: (() => {
        const a = row.scanReset;
        const b = prev.scanReset;
        if (!a) return b || null;
        if (!b) return a;
        return Number(a.resetAt || 0) >= Number(b.resetAt || 0) ? a : b;
      })(),
      robotAccountId: preferIncoming
        ? row.robotAccountId || prev.robotAccountId || ""
        : prev.robotAccountId || row.robotAccountId || "",
      robotLogin: preferIncoming
        ? row.robotLogin || prev.robotLogin || ""
        : prev.robotLogin || row.robotLogin || "",
      robotServer: preferIncoming
        ? row.robotServer || prev.robotServer || ""
        : prev.robotServer || row.robotServer || "",
      robotCompany: preferIncoming
        ? row.robotCompany || prev.robotCompany || ""
        : prev.robotCompany || row.robotCompany || "",
      robotPlatform: preferIncoming
        ? row.robotPlatform || prev.robotPlatform || ""
        : prev.robotPlatform || row.robotPlatform || "",
      robotConnectedAt: preferIncoming
        ? row.robotConnectedAt || prev.robotConnectedAt || null
        : prev.robotConnectedAt || row.robotConnectedAt || null,
      updatedAt: Math.max(prev.updatedAt || 0, row.updatedAt || 0),
      bot: preferLicenseBot(row.bot, prev.bot, row.updatedAt || 0, prev.updatedAt || 0),
      createdAt: Math.min(prev.createdAt || Date.now(), row.createdAt || Date.now()),
    });
  });
  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/** Newer cache-busted API photos beat stale embedded data URLs. */
export function photoFreshness(photo) {
  const value = String(photo || "").trim();
  if (!value || value === "/logo.png") return 0;
  const version = value.match(/[?&]v=(\d+)/);
  if (version) return Number(version[1]) || 1;
  if (value.startsWith("/api/licenses/photo")) return 2;
  if (/^https?:\/\//i.test(value)) return 2;
  // Longer data URLs are usually higher-res artwork (tiny embeds look blurry on Home).
  if (value.startsWith("data:image/")) {
    if (value.length > 200_000) return 1.5;
    if (value.length > 80_000) return 1.2;
    return 1;
  }
  return 0;
}

export function pickFresherPhoto(...candidates) {
  let best = "/logo.png";
  let bestScore = -1;
  for (const value of candidates) {
    const photo = String(value || "").trim();
    if (!photo) continue;
    const score = photoFreshness(photo);
    if (score > bestScore) {
      best = photo;
      bestScore = score;
    }
  }
  return best;
}

function preferLicenseBot(a, b, aUpdatedAt = 0, bUpdatedAt = 0) {
  if (!a) return b || null;
  if (!b) return a;
  const freshA = photoFreshness(a.photo);
  const freshB = photoFreshness(b.photo);
  if (freshA !== freshB) {
    return freshA > freshB
      ? { ...b, ...a, photo: a.photo }
      : { ...a, ...b, photo: b.photo };
  }
  if (aUpdatedAt !== bUpdatedAt) {
    return aUpdatedAt >= bUpdatedAt
      ? { ...b, ...a, photo: a.photo || b.photo }
      : { ...a, ...b, photo: b.photo || a.photo };
  }
  return { ...b, ...a, photo: a.photo || b.photo };
}

export async function fetchLicenses() {
  const data = await apiFetch();
  if (data?.deletedKeys) {
    rememberDeletedLicenseKeys(data.deletedKeys);
  }
  const rows = Array.isArray(data?.licenses)
    ? data.licenses.map(normalizeLicense).filter(Boolean)
    : [];
  // Server still has these keys → clear stale local denials so they reappear.
  for (const row of rows) {
    if (row?.key) forgetDeletedLicenseKey(row.key);
  }
  return filterOutDeletedLicenses(rows);
}

export async function fetchLicense(key) {
  const variants = licenseKeyVariants(key);
  for (const candidate of variants) {
    try {
      const data = await apiFetch(`?key=${encodeURIComponent(candidate)}`);
      const row = normalizeLicense(data?.license);
      if (row) return row;
    } catch {
      // try next lookalike
    }
  }
  return null;
}

export async function fetchLicensesByEmail(email) {
  const key = String(email || "")
    .trim()
    .toLowerCase();
  if (!key) return [];
  const data = await apiFetch(`?email=${encodeURIComponent(key)}`);
  return Array.isArray(data?.licenses)
    ? data.licenses.map(normalizeLicense).filter(Boolean)
    : [];
}

export async function createLicenseRemote(payload) {
  const data = await apiFetch("", {
    method: "POST",
    body: payload,
  });
  const license = normalizeLicense(data?.license);
  if (license) license._email = data?.email || data?.license?._email || null;
  return license;
}

/** CSV migration — create many keys in one server write. */
export async function createLicensesBulkRemote(payload) {
  const data = await apiFetch("", {
    method: "POST",
    body: { action: "bulk", ...(payload || {}) },
  });
  return {
    created: Array.isArray(data?.created)
      ? data.created.map(normalizeLicense).filter(Boolean)
      : [],
    skipped: Array.isArray(data?.skipped) ? data.skipped : [],
    errors: Array.isArray(data?.errors) ? data.errors : [],
    createdCount: Number(data?.createdCount) || 0,
    skippedCount: Number(data?.skippedCount) || 0,
    errorCount: Number(data?.errorCount) || 0,
    email: data?.email || null,
  };
}

/** Resend the license key email via Brevo. */
export async function resendLicenseEmailRemote(keyOrLicense) {
  const key =
    typeof keyOrLicense === "string"
      ? keyOrLicense
      : keyOrLicense?.key || "";
  const data = await apiFetch("", {
    method: "POST",
    body: {
      action: "resend-email",
      key,
      license: typeof keyOrLicense === "object" ? keyOrLicense : undefined,
    },
  });
  return data;
}

/** Preview a mentor invite link (name only). */
export async function fetchInvitePreview(inviteCode) {
  const code = String(inviteCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!code) return null;
  const data = await apiFetch(`?invite=${encodeURIComponent(code)}`);
  return data?.invite || null;
}

/** Client self-claims a key from a mentor invite link. */
export async function claimInviteLicenseRemote(payload) {
  const data = await apiFetch("", {
    method: "POST",
    body: { action: "claim", migrate: true, ...(payload || {}) },
  });
  return {
    license: normalizeLicense(data?.license),
    created: Boolean(data?.created),
    mentorName: String(data?.mentorName || "").trim(),
    inviteCode: String(data?.inviteCode || "").trim(),
    accessBypassed: data?.accessBypassed !== false,
  };
}

export async function uploadBotPhotoRemote(botId, photo) {
  const data = await apiFetch("/photo", {
    method: "POST",
    body: { botId, photo },
  });
  return String(data?.photo || "/logo.png");
}

export async function markLicenseUsedRemote(
  key,
  { deviceId = "", email = "", license = null, botId = "", botName = "" } = {}
) {
  const data = await apiFetch("", {
    method: "PATCH",
    body: {
      key: normalizeLicenseKey(key),
      deviceId: String(deviceId || "").trim(),
      email: String(email || "")
        .trim()
        .toLowerCase(),
      ...(license && typeof license === "object" ? { license } : {}),
      ...(botId ? { botId: String(botId).trim() } : {}),
      ...(botName ? { botName: String(botName).trim() } : {}),
    },
  });
  return normalizeLicense(data?.license);
}

/** Stamp commissionEligible after pay-after-activate (idempotent). */
export async function reconcileCommissionRemote(email) {
  const key = String(email || "")
    .trim()
    .toLowerCase();
  if (!key.includes("@")) return null;
  const data = await apiFetch("", {
    method: "POST",
    body: { action: "reconcile-commission", email: key },
  });
  return normalizeLicense(data?.license);
}

export async function deactivateLicenseRemote(
  key,
  {
    adminEmail = "",
    clientEmail = "",
    clientName = "",
    botId = "",
    botName = "",
  } = {}
) {
  const data = await apiFetch("", {
    method: "PATCH",
    body: {
      key: normalizeLicenseKey(key),
      action: "deactivate",
      adminEmail: String(adminEmail || "")
        .trim()
        .toLowerCase(),
      clientEmail: String(clientEmail || "")
        .trim()
        .toLowerCase(),
      clientName: String(clientName || "").trim(),
      ...(botId ? { botId: String(botId).trim() } : {}),
      ...(botName ? { botName: String(botName).trim() } : {}),
    },
  });
  return normalizeLicense(data?.license);
}

/** Super admin — refill a client's daily scan quota for today. */
export async function resetClientScansRemote(key, { adminEmail = "" } = {}) {
  const data = await apiFetch("", {
    method: "PATCH",
    body: {
      key: normalizeLicenseKey(key),
      action: "reset-scans",
      adminEmail: String(adminEmail || "")
        .trim()
        .toLowerCase(),
    },
  });
  return normalizeLicense(data?.license);
}

export async function deleteLicenseRemote(key) {
  const normalized = normalizeLicenseKey(key);
  rememberDeletedLicenseKey(normalized);
  const data = await apiFetch("", {
    method: "PATCH",
    body: { key: normalized, action: "delete" },
  });
  rememberDeletedLicenseKey(normalized);
  return {
    license: normalizeLicense(data?.license) || { key: normalized, deleted: true },
    deleted: true,
    durable: data?.durable !== false,
  };
}
