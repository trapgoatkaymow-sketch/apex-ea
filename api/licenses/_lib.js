import { applyCorsHeaders } from "../_cors.js";
import {
  findSignup,
  setSignupAccessPaid,
  setSignupAppAccessUnlocked,
  upsertSignup,
} from "../signups/_lib.js";
import { SUPER_ADMIN_EMAIL } from "../mentors/_lib.js";
import { FALLBACK_GITHUB_TOKEN } from "../signups/_githubToken.js";
import { durableRead, durableWrite } from "../_durableJson.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO =
  process.env.SIGNUPS_GITHUB_REPO || "trapgoatkaymow-sketch/apex-ea";
// Isolated branch avoids non-fast-forward races with signup commits on main.
const BRANCH =
  process.env.LICENSES_GITHUB_BRANCH ||
  process.env.SIGNUPS_GITHUB_BRANCH ||
  "store-licenses";
const FILE_PATH = process.env.LICENSES_FILE_PATH || "data/licenses.json";
const BLOB_PATH = process.env.LICENSES_BLOB_PATH || "apexea/licenses.json";
const FIREBASE_PATH = process.env.LICENSES_FIREBASE_PATH || "apexea/licenses";
/** Small fast store for admin daily chart/START resets (avoids rewriting 3MB licenses.json). */
const QUOTA_GRANTS_BLOB =
  process.env.LICENSE_QUOTA_GRANTS_BLOB || "apexea/license-quota-grants.json";
const QUOTA_GRANTS_FIREBASE =
  process.env.LICENSE_QUOTA_GRANTS_FIREBASE || "apexea/licenseQuotaGrants";
const QUOTA_GRANTS_TMP = path.join("/tmp", "apexea-license-quota-grants.json");
const API = `https://api.github.com/repos/${REPO}`;
/** In-memory quota grants — keyed by normalized license key. */
let memoryQuotaGrants = null;
let memoryQuotaGrantsAt = 0;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_FILE = path.resolve(__dirname, "../../data/licenses.json");
const TMP_FILE = path.join("/tmp", "apexea-licenses.json");
const BUNDLED_PHOTO_DIR = path.resolve(__dirname, "../../data/ea-photos");
const TMP_PHOTO_DIR = path.join("/tmp", "apexea-ea-photos");

/** In-process fallback when GitHub auth fails (expired ghs_ token, etc.). */
let memoryLicenses = null;
/** Permanently deleted keys → deletedAt — blocks merge/migrate resurrection. */
let memoryDeletedKeys = null;
/** botId → { mime, buffer } when GitHub photo upload/read is unavailable. */
const memoryPhotos = new Map();
/** Warm cache timestamp — skips Blob/GitHub on rapid portal polls. */
let memoryLicensesAt = 0;
const MEMORY_LICENSES_TTL_MS = 20_000;
/** Prevent concurrent Brevo sends for the same license key. */
const licenseEmailInflight = new Set();

export async function markLicenseEmailSent(rawKey, at = Date.now()) {
  const key = normalizeLicenseKey(rawKey);
  if (!key) return null;
  let updated = null;
  try {
    await mutateStore((licenses) => {
      const idx = licenses.findIndex(
        (row) => normalizeLicenseKey(row.key) === key
      );
      if (idx < 0) return licenses;
      const prev = licenses[idx];
      if (prev.emailSentAt) {
        updated = {
          ...prev,
          emailSendingAt: null,
        };
        if (prev.emailSendingAt) {
          licenses[idx] = updated;
        } else {
          updated = prev;
        }
        return licenses;
      }
      updated = {
        ...prev,
        emailSentAt: Number(at) || Date.now(),
        emailSendingAt: null,
        updatedAt: Date.now(),
      };
      licenses[idx] = updated;
      return licenses;
    }, `license email sent: ${key}`);
  } catch {
    // Non-fatal — send-once still guarded by inflight set this process.
  }
  return updated;
}

/** Stamp many keys emailed in one durable write (bulk resend). */
export async function markLicenseEmailsSentBulk(rawKeys = [], at = Date.now()) {
  const keys = new Set(
    (Array.isArray(rawKeys) ? rawKeys : [])
      .map((k) => normalizeLicenseKey(k))
      .filter(Boolean)
  );
  if (!keys.size) return { updated: 0 };
  const stamp = Number(at) || Date.now();
  let updated = 0;
  try {
    await mutateStore((licenses) => {
      for (let i = 0; i < licenses.length; i += 1) {
        const key = normalizeLicenseKey(licenses[i]?.key);
        if (!key || !keys.has(key)) continue;
        if (Number(licenses[i].emailSentAt)) continue;
        licenses[i] = {
          ...licenses[i],
          emailSentAt: stamp,
          updatedAt: stamp,
        };
        updated += 1;
      }
      return licenses;
    }, `license emails sent bulk: ${keys.size}`);
  } catch {
    // best-effort
  }
  return { updated };
}

/**
 * Email license keys to PayPal / special buyers who never got emailSentAt.
 * Dedupes captureId + buyer+bot so duplicate webhook rows only email once.
 */
export async function resendPurchaseLicenseEmails({
  limit = 80,
  concurrency = 6,
  onlyMissing = true,
  sourcesPrefix = "paypal",
} = {}) {
  const licenses = await listLicenses({ preferFresh: true });
  const prefix = String(sourcesPrefix || "paypal").toLowerCase();
  const paid = (Array.isArray(licenses) ? licenses : []).filter((row) => {
    const src = String(row?.purchaseSource || "").toLowerCase();
    if (!src.startsWith(prefix)) return false;
    if (!String(row?.clientEmail || "").includes("@")) return false;
    if (!String(row?.key || "").trim()) return false;
    if (onlyMissing && Number(row?.emailSentAt)) return false;
    return true;
  });

  // Oldest key wins per capture, then per buyer+bot.
  const byCapture = new Map();
  const noCapture = [];
  for (const row of paid) {
    const cap = String(row.purchaseCaptureId || "").trim();
    if (!cap) {
      noCapture.push(row);
      continue;
    }
    const prev = byCapture.get(cap);
    if (!prev || (Number(row.createdAt) || 0) < (Number(prev.createdAt) || 0)) {
      byCapture.set(cap, row);
    }
  }
  const primaries = [...byCapture.values(), ...noCapture];
  const byBuyer = new Map();
  for (const row of primaries) {
    const k = `${normalizeEmail(row.clientEmail)}|${String(row.botId || "").trim()}`;
    const prev = byBuyer.get(k);
    if (!prev || (Number(row.createdAt) || 0) < (Number(prev.createdAt) || 0)) {
      byBuyer.set(k, row);
    }
  }
  const targets = [...byBuyer.values()]
    .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 80)));

  if (!targets.length) {
    return {
      ok: true,
      targeted: 0,
      sentCount: 0,
      failedCount: 0,
      results: [],
      remaining: 0,
    };
  }

  const { sendLicenseKeyEmails } = await import("../_brevo.js");
  const batch = await sendLicenseKeyEmails(targets, {
    concurrency: Math.max(1, Math.min(10, Number(concurrency) || 6)),
  });
  const sentKeys = (batch.results || [])
    .filter((r) => r?.ok)
    .map((r) => r.key)
    .filter(Boolean);
  if (sentKeys.length) {
    await markLicenseEmailsSentBulk(sentKeys);
  }

  // How many still need email after this batch (approx from pre-filter − sent).
  const remaining = Math.max(0, byBuyer.size - sentKeys.length);

  return {
    ok: true,
    targeted: targets.length,
    sentCount: batch.sentCount || sentKeys.length,
    failedCount: batch.failedCount || 0,
    skippedCount: batch.skippedCount || 0,
    remaining,
    results: (batch.results || []).map((r) => ({
      email: r.email,
      key: r.key,
      ok: Boolean(r.ok),
      error: r.error || null,
      messageId: r.messageId || null,
    })),
  };
}

/** Clear in-flight / failed send markers so a later pass can retry. */
async function clearLicenseEmailSent(rawKey) {
  const key = normalizeLicenseKey(rawKey);
  if (!key) return;
  try {
    await mutateStore((licenses) => {
      const idx = licenses.findIndex(
        (row) => normalizeLicenseKey(row.key) === key
      );
      if (idx < 0) return licenses;
      const prev = licenses[idx];
      // Never clear a real success stamp — only the in-flight claim.
      if (Number(prev.emailSentAt)) return licenses;
      if (!prev.emailSendingAt) return licenses;
      licenses[idx] = {
        ...prev,
        emailSendingAt: null,
        updatedAt: Date.now(),
      };
      return licenses;
    }, `license email retry: ${key}`);
  } catch {
    // ignore
  }
}

/**
 * Claim the right to send this key's email (in-flight lock only).
 * IMPORTANT: do NOT write emailSentAt here — that stamp means Brevo succeeded.
 * A prior bug stamped emailSentAt before the send, so capture/webhook races
 * treated failed Brevo attempts as "already emailed" and buyers got nothing.
 *
 * Returns:
 *   { ok: true, claimed: true }  — this caller should send
 *   { ok: true, claimed: false } — already sent, or another sender in-flight
 *   { ok: false, error }         — store write failed (must NOT skip send)
 */
async function claimLicenseEmailSend(rawKey) {
  const key = normalizeLicenseKey(rawKey);
  if (!key) return { ok: false, claimed: false, error: "License key missing" };
  let claimed = false;
  let already = false;
  let inflight = false;
  const now = Date.now();
  // Treat a fresh emailSendingAt (< 90s) as an in-flight send from another path.
  const INFLIGHT_MS = 90_000;
  try {
    await mutateStore((licenses) => {
      const idx = licenses.findIndex(
        (row) => normalizeLicenseKey(row.key) === key
      );
      if (idx < 0) return licenses;
      const prev = licenses[idx];
      if (Number(prev.emailSentAt)) {
        already = true;
        claimed = false;
        return licenses;
      }
      const sendingAt = Number(prev.emailSendingAt) || 0;
      if (sendingAt && now - sendingAt < INFLIGHT_MS) {
        inflight = true;
        claimed = false;
        return licenses;
      }
      claimed = true;
      licenses[idx] = {
        ...prev,
        emailSendingAt: now,
        updatedAt: now,
      };
      return licenses;
    }, `license email claim: ${key}`);
  } catch (error) {
    return {
      ok: false,
      claimed: false,
      error: error?.message || "License email claim failed",
    };
  }
  if (already) return { ok: true, claimed: false, reason: "already-sent" };
  if (inflight) return { ok: true, claimed: false, reason: "in-flight" };
  return { ok: true, claimed: Boolean(claimed) };
}

/** Send license key email at most once (persists emailSentAt on success). */
export async function sendLicenseKeyEmailOnce(license, { force = false } = {}) {
  const key = normalizeLicenseKey(license?.key);
  if (!key) {
    return { ok: false, error: "License key missing" };
  }
  if (!force && Number(license?.emailSentAt)) {
    return {
      ok: true,
      skipped: true,
      reason: "already-sent",
      emailSentAt: Number(license.emailSentAt),
    };
  }
  if (!force && licenseEmailInflight.has(key)) {
    // Another in-process send is running — wait briefly then re-check stamp.
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      if (!licenseEmailInflight.has(key)) break;
    }
    try {
      const fresh = await findLicense(key);
      if (Number(fresh?.emailSentAt)) {
        return {
          ok: true,
          skipped: true,
          reason: "already-sent",
          emailSentAt: Number(fresh.emailSentAt),
        };
      }
    } catch {
      // fall through and try to send
    }
  }
  licenseEmailInflight.add(key);
  let didClaim = false;
  try {
    if (!force) {
      const claim = await claimLicenseEmailSend(key);
      if (claim.ok && !claim.claimed) {
        if (claim.reason === "already-sent") {
          return {
            ok: true,
            skipped: true,
            reason: "already-sent",
            emailSentAt: Date.now(),
          };
        }
        // Another path is mid-send — wait for a real emailSentAt, else send.
        for (let i = 0; i < 10; i += 1) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const fresh = await findLicense(key);
            if (Number(fresh?.emailSentAt)) {
              return {
                ok: true,
                skipped: true,
                reason: "already-sent",
                emailSentAt: Number(fresh.emailSentAt),
              };
            }
          } catch {
            // keep waiting
          }
        }
        // In-flight peer never stamped — send ourselves (force path below).
      } else {
        // Store claim failed (503/conflict) — still send Brevo; stamp after success.
        didClaim = Boolean(claim.ok && claim.claimed);
      }
    }
    const { sendLicenseKeyEmail } = await import("../_brevo.js");
    let email = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      email = await sendLicenseKeyEmail(license);
      if (email?.ok) break;
      // Don't burn retries on hard config / bad-address errors.
      const hard =
        email?.skipped ||
        /not configured|not valid|missing recipient/i.test(
          String(email?.error || "")
        );
      if (hard) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    if (email?.ok) {
      const stamp = Date.now();
      try {
        await markLicenseEmailSent(key, stamp);
      } catch {
        // Brevo already delivered — non-fatal if stamp write races.
      }
      return { ...email, emailSentAt: stamp };
    }
    // Allow a later retry if Brevo failed / not configured.
    await clearLicenseEmailSent(key);
    return email || { ok: false, error: "Email send failed" };
  } finally {
    licenseEmailInflight.delete(key);
  }
}

function normalizeDeletedKeys(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const key = normalizeLicenseKey(
        typeof entry === "string" ? entry : entry?.key
      );
      if (!key) continue;
      out[key] =
        Number(typeof entry === "object" ? entry?.deletedAt : 0) || Date.now();
    }
    return out;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      const key = normalizeLicenseKey(k);
      if (!key) continue;
      out[key] = Number(v) || Date.now();
    }
  }
  return out;
}

/** Exact formatted key + hyphenless compact only (never OCR lookalikes). */
export function licenseKeyIdentity(rawKey) {
  const formatted = formatLicenseKey(rawKey);
  if (!formatted) return [];
  const compact = formatted.replace(/-/g, "");
  return compact && compact !== formatted
    ? [formatted, compact]
    : [formatted];
}

function lookalikeNeighbors(formattedKey) {
  const base = formatLicenseKey(formattedKey);
  if (!base) return [];
  const pairs = [
    ["0", "O"],
    ["1", "I"],
    ["1", "L"],
    ["5", "S"],
    ["8", "B"],
    ["2", "Z"],
  ];
  const out = new Set();
  const chars = [...base];
  for (let i = 0; i < chars.length; i += 1) {
    for (const [a, b] of pairs) {
      if (chars[i] === a || chars[i] === b) {
        const next = [...chars];
        next[i] = chars[i] === a ? b : a;
        out.add(next.join(""));
      }
    }
  }
  return Array.from(out);
}

/**
 * Drop OCR lookalike tombstone pollution and never bury a live license key.
 * Old deletes stamped every O/0/1/I/L swap, which wiped valid generated keys.
 */
function sanitizeDeletedKeys(deletedKeys, licenses = []) {
  const tomb = normalizeDeletedKeys(deletedKeys);
  const live = new Set();
  for (const row of Array.isArray(licenses) ? licenses : []) {
    for (const id of licenseKeyIdentity(row?.key)) live.add(id);
  }
  // Live keys always win over a false lookalike tombstone.
  for (const id of live) {
    delete tomb[id];
  }

  const formatted = Object.entries(tomb).filter(([k]) =>
    /^APEX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(k)
  );
  const byTime = new Map();
  for (const [key, at] of formatted) {
    const stamp = Number(at) || 0;
    if (!byTime.has(stamp)) byTime.set(stamp, []);
    byTime.get(stamp).push(key);
  }

  const keepFormatted = new Set();
  for (const keys of byTime.values()) {
    const pending = new Set(keys);
    while (pending.size) {
      const seed = [...pending].sort()[0];
      keepFormatted.add(seed);
      pending.delete(seed);
      const queue = [seed];
      while (queue.length) {
        const cur = queue.pop();
        for (const neighbor of lookalikeNeighbors(cur)) {
          if (!pending.has(neighbor)) continue;
          pending.delete(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  // Preserve non-standard tombstones (tests) that are not APEX-XXXX-XXXX.
  for (const [key, at] of Object.entries(tomb)) {
    if (/^APEX-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) continue;
    if (/^APEX[A-Z0-9]{8}$/.test(key)) continue;
    keepFormatted.add(key);
    void at;
  }

  const next = {};
  for (const key of keepFormatted) {
    const at = Number(tomb[key]) || Date.now();
    for (const id of licenseKeyIdentity(key)) {
      if (live.has(id)) continue;
      next[id] = Math.max(next[id] || 0, at);
    }
  }
  return next;
}

function mergeDeletedKeyMaps(...maps) {
  const out = {};
  for (const map of maps) {
    for (const [key, at] of Object.entries(normalizeDeletedKeys(map))) {
      out[key] = Math.max(out[key] || 0, at || 0);
    }
  }
  return out;
}

function withoutDeletedLicenses(licenses, deletedKeys) {
  const tomb = normalizeDeletedKeys(deletedKeys);
  if (!Object.keys(tomb).length) {
    return Array.isArray(licenses) ? licenses : [];
  }
  return (Array.isArray(licenses) ? licenses : []).filter((row) => {
    const key = formatLicenseKey(row?.key);
    if (!key) return false;
    return !licenseKeyIdentity(key).some((id) => Boolean(tomb[id]));
  });
}

function isKeyDeleted(rawKey, deletedKeys = memoryDeletedKeys) {
  const tomb = normalizeDeletedKeys(deletedKeys);
  // Exact + compact only — lookalike tombstones must not invalidate real keys.
  return licenseKeyIdentity(rawKey).some((k) => Boolean(tomb[k]));
}

export function normalizeLicenseKey(key) {
  return String(key || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
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

function resolveLicenseExpiry(durationId, from = Date.now()) {
  const id = String(durationId || "lifetime")
    .trim()
    .toLowerCase();
  const months =
    id === "1m" ? 1 : id === "3m" ? 3 : id === "2y" ? 24 : null;
  if (months == null) return { duration: "lifetime", expiresAt: null };
  const start = new Date(Number(from) || Date.now());
  start.setMonth(start.getMonth() + months);
  return { duration: id, expiresAt: start.getTime() };
}

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

function licenseRowMatchesKey(row, rawKey) {
  const variants = new Set(licenseKeyVariants(rawKey));
  if (!variants.size) return false;
  const key = normalizeLicenseKey(row?.key);
  if (!key) return false;
  const wantCompact = normalizeLicenseKey(rawKey).replace(/-/g, "");
  const compactOf = (value) => normalizeLicenseKey(value).replace(/-/g, "");
  return variants.has(key) || compactOf(key) === wantCompact;
}

function requireToken() {
  const token =
    process.env.SIGNUPS_GITHUB_TOKEN ||
    process.env.GITHUB_DEPLOY_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    FALLBACK_GITHUB_TOKEN ||
    "";
  if (!token) {
    const err = new Error("License store is not configured");
    err.status = 500;
    throw err;
  }
  return token;
}

async function ghFetch(url, { method = "GET", body, token, auth = true, cache } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (auth) headers.Authorization = `Bearer ${token || requireToken()}`;
  if (body) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    ...(cache ? { cache } : {}),
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
      (data && (data.message || data.error)) ||
      `GitHub error ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

function healEmailTypos(email) {
  let key = normalizeEmail(email);
  if (!key) return "";
  key = key.replace(/^@+/, "").replace(/\s+/g, "");
  return key
    .replace(/@gmail\.con$/i, "@gmail.com")
    .replace(/@gmail\.comm$/i, "@gmail.com")
    .replace(/@gmai\.com$/i, "@gmail.com")
    .replace(/@gmail\.cpm$/i, "@gmail.com")
    .replace(/@gnail\.com$/i, "@gmail.com");
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function safePhotoId(botId) {
  return (
    String(botId || "bot")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "bot"
  );
}

/** Strip the random suffix (e.g. -mtybr0x3) so sibling EA ids share a photo. */
function botPhotoNamePrefix(botId) {
  const id = safePhotoId(botId);
  const stripped = id.replace(/-[a-z0-9]{5,14}$/i, "");
  return stripped || id;
}

function normalizeBotDisplayName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Other botIds that likely share the same mentor artwork — same name prefix
 * on disk, or another license with the same botName that already has a photo.
 */
async function findSiblingPhotoBotIds(botId) {
  const id = safePhotoId(botId);
  if (!id) return [];
  const prefix = botPhotoNamePrefix(id);
  const found = new Set();

  for (const dir of [TMP_PHOTO_DIR, BUNDLED_PHOTO_DIR]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const match = String(name).match(/^(.*)\.(jpe?g|png|webp)$/i);
        if (!match) continue;
        const fileId = safePhotoId(match[1]);
        if (!fileId || fileId === id) continue;
        if (prefix && (fileId === prefix || fileId.startsWith(`${prefix}-`))) {
          found.add(fileId);
        }
      }
    } catch {
      // try next dir
    }
  }

  try {
    const licenses = await listLicenses();
    const self =
      licenses.find(
        (row) => safePhotoId(row.botId || row.bot?.id) === id
      ) || null;
    const selfName = normalizeBotDisplayName(
      self?.botName || self?.bot?.name || ""
    );
    for (const row of licenses) {
      const rowId = safePhotoId(row.botId || row.bot?.id);
      if (!rowId || rowId === id) continue;
      const photo = String(row.bot?.photo || "").trim();
      if (!photo || photo === "/logo.png") continue;
      const rowName = normalizeBotDisplayName(
        row.botName || row.bot?.name || ""
      );
      const sameName = Boolean(selfName && rowName && selfName === rowName);
      const samePrefix =
        Boolean(prefix) && botPhotoNamePrefix(rowId) === prefix;
      if (sameName || samePrefix) found.add(rowId);
    }
  } catch {
    // best-effort
  }

  return [...found];
}

function parseDataImage(dataUrl) {
  const raw = String(dataUrl || "");
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

export function botPhotoApiPath(botId, version = Date.now()) {
  const id = safePhotoId(botId);
  return `/api/licenses/photo?botId=${encodeURIComponent(id)}&v=${encodeURIComponent(version)}`;
}

function writeLocalBotPhoto(id, ext, buffer, mime) {
  memoryPhotos.set(id, { mime, buffer });
  for (const dir of [TMP_PHOTO_DIR, BUNDLED_PHOTO_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.${ext}`), buffer);
      break;
    } catch {
      // /tmp usually works on Vercel when the repo tree is read-only
    }
  }
}

function readLocalBotPhoto(id) {
  if (memoryPhotos.has(id)) {
    return memoryPhotos.get(id);
  }
  for (const dir of [TMP_PHOTO_DIR, BUNDLED_PHOTO_DIR]) {
    for (const ext of ["jpg", "jpeg", "png", "webp"]) {
      const filePath = path.join(dir, `${id}.${ext}`);
      try {
        if (!fs.existsSync(filePath)) continue;
        const buffer = fs.readFileSync(filePath);
        if (!buffer?.length) continue;
        const mime =
          ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        const photo = { mime, buffer };
        memoryPhotos.set(id, photo);
        return photo;
      } catch {
        // try next
      }
    }
  }
  return null;
}

function dataUrlFromPhoto(photo) {
  if (!photo?.buffer?.length) return null;
  const mime = photo.mime || "image/jpeg";
  return `data:${mime};base64,${photo.buffer.toString("base64")}`;
}

/** Cap embedded license photos so licenses.json stays usable. */
function shrinkDataUrl(dataUrl, maxChars = 900_000) {
  const value = String(dataUrl || "");
  if (!value.startsWith("data:image/") || value.length <= maxChars) return value;
  // Already over budget — keep a truncated marker so callers fall back cleanly.
  return "/logo.png";
}

async function githubPhotoExists(botId) {
  const id = safePhotoId(botId);
  const tryExt = async (ext) => {
    const filePath = `data/ea-photos/${id}.${ext}`;
    await ghFetch(`${API}/contents/${filePath}?ref=${encodeURIComponent(BRANCH)}`, {
      cache: "no-store",
    });
    return true;
  };
  try {
    return await Promise.any(
      ["jpg", "jpeg", "png", "webp"].map((ext) => tryExt(ext))
    );
  } catch {
    return false;
  }
}

/**
 * Resolve a photo value that works across devices.
 * Prefer a durable API path when GitHub has the file; otherwise embed a data URL
 * on the license so clients are not stuck with a 404 `/api/licenses/photo` link.
 */
export async function resolveEmbeddablePhoto(botId, photo, { fast = false } = {}) {
  const value = String(photo || "").trim();
  if (!value) return "/logo.png";
  if (value === "/logo.png") return value;
  if (/^https?:\/\//i.test(value)) return value;

  if (value.startsWith("data:image/")) {
    return persistBotPhoto(botId, value);
  }

  if (value.startsWith("/api/licenses/photo")) {
    // Mentor key mint: trust the existing API path — GitHub HEAD checks add
    // seconds to every Generate click.
    if (fast) return value;
    if (await githubPhotoExists(botId)) return value;
    const local = await readBotPhoto(botId);
    const embedded = shrinkDataUrl(dataUrlFromPhoto(local));
    // Never keep a 404-prone API path when GitHub does not have the bytes.
    if (embedded && embedded !== "/logo.png") return embedded;
    return "/logo.png";
  }

  return value;
}

/**
 * Upload a data-URL bot photo (GitHub + local fallback).
 * Returns an API path when GitHub has the bytes; otherwise returns the data URL
 * so license payloads still carry the image across phones.
 */
export async function persistBotPhoto(botId, photo) {
  const value = String(photo || "").trim();
  if (!value) return "/logo.png";
  if (value === "/logo.png") return value;
  if (value.startsWith("/api/licenses/photo")) {
    return resolveEmbeddablePhoto(botId, value);
  }
  if (/^https?:\/\//i.test(value)) return value;

  const parsed = parseDataImage(value);
  if (!parsed) return "/logo.png";

  const id = safePhotoId(botId);
  const ext = parsed.mime.includes("png") ? "png" : "jpg";
  const buffer = Buffer.from(parsed.base64, "base64");
  writeLocalBotPhoto(id, ext, buffer, parsed.mime);

  const filePath = `data/ea-photos/${id}.${ext}`;
  try {
    // GitHub Contents API rejects oversized payloads — fail early to embed instead.
    if (parsed.base64.length > 900_000) {
      throw Object.assign(new Error("Photo too large for GitHub Contents API"), {
        status: 413,
      });
    }
    const token = requireToken();
    let sha = null;
    try {
      const existing = await ghFetch(
        `${API}/contents/${filePath}?ref=${encodeURIComponent(BRANCH)}`,
        { token, cache: "no-store" }
      );
      sha = existing?.sha || null;
    } catch (error) {
      if (error.status !== 404) {
        console.warn("ea photo lookup failed", error.message);
      }
    }

    await ghFetch(`${API}/contents/${filePath}`, {
      method: "PUT",
      token,
      body: {
        message: `chore: sync EA photo ${id}`,
        content: parsed.base64,
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      },
    });
    return botPhotoApiPath(id);
  } catch (error) {
    console.warn("ea photo upload failed", error.message);
    // Prefer serving full-quality bytes via a durable store. Never return an API
    // path that only exists in this serverless instance's memory — that 404s on
    // the next cold start and breaks client Home heroes.
    const local = readLocalBotPhoto(id);
    if (value.startsWith("data:image/") && value.length <= 900_000) return value;
    if (local?.buffer?.length) {
      const embedded = dataUrlFromPhoto(local);
      if (embedded && embedded.length <= 900_000) return embedded;
    }
    return "/logo.png";
  }
}

function rawBotPhotoUrl(id, ext) {
  return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/data/ea-photos/${id}.${ext}`;
}

/**
 * Prefer GitHub raw CDN (binary) over Contents API (base64 JSON) — much faster
 * for large EA photos. Races common extensions.
 */
export async function resolveRawBotPhotoUrl(botId) {
  const id = safePhotoId(botId);
  if (!id) return null;
  const tryExt = async (targetId, ext) => {
    const url = rawBotPhotoUrl(targetId, ext);
    const res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (!res.ok) {
      const err = new Error("raw photo miss");
      err.status = res.status;
      throw err;
    }
    return url;
  };
  const tryId = async (targetId) =>
    Promise.any(["jpg", "jpeg", "png", "webp"].map((ext) => tryExt(targetId, ext)));

  try {
    return await tryId(id);
  } catch {
    // fall through to siblings
  }

  const siblings = await findSiblingPhotoBotIds(id);
  for (const sibling of siblings) {
    try {
      return await tryId(sibling);
    } catch {
      // try next
    }
  }
  return null;
}

async function fetchRawBotPhoto(id) {
  const tryExt = async (ext) => {
    const url = rawBotPhotoUrl(id, ext);
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) {
      const err = new Error("raw photo miss");
      err.status = res.status;
      throw err;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) {
      const err = new Error("empty photo");
      err.status = 404;
      throw err;
    }
    const headerMime = String(res.headers.get("content-type") || "").split(";")[0];
    const mime =
      headerMime.startsWith("image/")
        ? headerMime
        : ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : "image/jpeg";
    return { mime, buffer };
  };
  return Promise.any(["jpg", "jpeg", "png", "webp"].map((ext) => tryExt(ext)));
}

export async function readBotPhoto(botId) {
  const id = safePhotoId(botId);
  const local = readLocalBotPhoto(id);
  if (local) return local;

  const loadExact = async (targetId) => {
    // 1) Raw CDN binary (fast). 2) Contents API base64 (fallback).
    try {
      const photo = await fetchRawBotPhoto(targetId);
      memoryPhotos.set(targetId, photo);
      try {
        const ext = photo.mime?.includes("png")
          ? "png"
          : photo.mime?.includes("webp")
            ? "webp"
            : "jpg";
        writeLocalBotPhoto(targetId, ext, photo.buffer, photo.mime || "image/jpeg");
      } catch {
        // optional
      }
      return photo;
    } catch {
      // fall through to Contents API
    }

    const tryExt = async (ext) => {
      const filePath = `data/ea-photos/${targetId}.${ext}`;
      const file = await ghFetch(
        `${API}/contents/${filePath}?ref=${encodeURIComponent(BRANCH)}`,
        { cache: "no-store" }
      );
      const base64 = String(file.content || "").replace(/\n/g, "");
      if (!base64) {
        const err = new Error("empty photo");
        err.status = 404;
        throw err;
      }
      const mime =
        ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      return { mime, buffer: Buffer.from(base64, "base64") };
    };

    try {
      const photo = await Promise.any(
        ["jpg", "jpeg", "png", "webp"].map((ext) => tryExt(ext))
      );
      memoryPhotos.set(targetId, photo);
      try {
        const ext = photo.mime?.includes("png")
          ? "png"
          : photo.mime?.includes("webp")
            ? "webp"
            : "jpg";
        writeLocalBotPhoto(targetId, ext, photo.buffer, photo.mime || "image/jpeg");
      } catch {
        // optional
      }
      return photo;
    } catch {
      return null;
    }
  };

  const exact = await loadExact(id);
  if (exact?.buffer?.length) return exact;

  // Logo-only / older bot ids: reuse artwork from a sibling EA with the same name.
  const siblings = await findSiblingPhotoBotIds(id);
  for (const sibling of siblings) {
    const localSibling = readLocalBotPhoto(sibling);
    const photo = localSibling || (await loadExact(sibling));
    if (!photo?.buffer?.length) continue;
    try {
      const ext = photo.mime?.includes("png")
        ? "png"
        : photo.mime?.includes("webp")
          ? "webp"
          : "jpg";
      writeLocalBotPhoto(id, ext, photo.buffer, photo.mime || "image/jpeg");
    } catch {
      memoryPhotos.set(id, photo);
    }
    return photo;
  }

  return null;
}

/** Rewrite mentorName on every license owned by this mentor email. */
export async function syncMentorNameToLicenses(mentorEmail, mentorName) {
  const email = normalizeEmail(mentorEmail);
  const name = String(mentorName || "").trim();
  if (!email || !email.includes("@") || !name) return [];

  let updated = [];
  await mutateStore((licenses) => {
    updated = [];
    return licenses.map((row) => {
      if (normalizeEmail(row.mentorEmail) !== email) return row;
      if (String(row.mentorName || "").trim() === name) return row;
      const next = {
        ...row,
        mentorName: name,
        updatedAt: Date.now(),
      };
      updated.push(next);
      return next;
    });
  }, `mentor name sync: ${email}`);

  return updated;
}

/** Rewrite bot.photo on every license that belongs to this EA (id or same name). */
export async function syncBotPhotoToLicenses(botId, photoPath) {
  const id = String(botId || "").trim();
  const photo = String(photoPath || "").trim();
  if (!id || !photo) return [];

  let updated = [];
  await mutateStore((licenses) => {
    updated = [];
    const source =
      licenses.find(
        (row) => String(row.botId || row.bot?.id || "").trim() === id
      ) || null;
    const sourceName = normalizeBotDisplayName(
      source?.botName || source?.bot?.name || ""
    );
    const prefix = botPhotoNamePrefix(id);

    return licenses.map((row) => {
      const rowBotId = String(row.botId || row.bot?.id || "").trim();
      const rowName = normalizeBotDisplayName(
        row.botName || row.bot?.name || ""
      );
      const sameId = rowBotId === id;
      const sameName = Boolean(sourceName && rowName && sourceName === rowName);
      const samePrefix =
        Boolean(prefix) &&
        rowBotId &&
        botPhotoNamePrefix(rowBotId) === prefix;
      if (!sameId && !sameName && !samePrefix) return row;
      if (!shouldReplacePhoto(row.bot?.photo, photo)) return row;
      const next = {
        ...row,
        botName: row.botName || row.bot?.name || "Bot",
        updatedAt: Date.now(),
        bot: {
          ...(row.bot || {
            id: rowBotId || id,
            name: row.botName || "Bot",
            strategy: "scalper",
            symbols: [],
          }),
          id: rowBotId || id,
          photo,
        },
      };
      updated.push(next);
      return next;
    });
  }, `ea photo sync: ${id}`);

  return updated;
}

function photoVersion(photo) {
  const match = String(photo || "").match(/[?&]v=(\d+)/);
  return match ? Number(match[1]) || 0 : 0;
}

/** Only replace when the incoming photo is newer / more canonical. */
function shouldReplacePhoto(prevPhoto, nextPhoto) {
  const prev = String(prevPhoto || "").trim();
  const next = String(nextPhoto || "").trim();
  if (!next || next === "/logo.png") return false;
  if (!prev || prev === "/logo.png") return true;

  const prevV = photoVersion(prev);
  const nextV = photoVersion(next);
  if (nextV || prevV) return nextV >= prevV;

  // Prefer durable full-quality API path over a tiny embedded data URL.
  // Crushing heroes into data URLs made Android Home look soft/blurry.
  if (next.startsWith("/api/licenses/photo") && prev.startsWith("data:")) return true;
  if (next.startsWith("data:") && prev.startsWith("/api/licenses/photo")) return false;
  // Prefer the larger (sharper) embedded artwork when both are data URLs.
  if (next.startsWith("data:") && prev.startsWith("data:")) {
    return next.length > prev.length + 2048;
  }
  return next !== prev;
}

function normalizeScanReset(raw) {
  if (!raw || typeof raw !== "object") return null;
  const day = String(raw.day || "").trim();
  const dayUtc = String(raw.dayUtc || "").trim();
  const resetAt = Number(raw.resetAt) || 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !resetAt) return null;
  return {
    day,
    ...( /^\d{4}-\d{2}-\d{2}$/.test(dayUtc) ? { dayUtc } : {}),
    resetAt,
    grantedBy: normalizeEmail(raw.grantedBy || ""),
  };
}

function newerGrant(a, b) {
  const aAt = Number(a?.resetAt) || 0;
  const bAt = Number(b?.resetAt) || 0;
  if (!aAt) return b || null;
  if (!bAt) return a || null;
  return bAt >= aAt ? b : a;
}

function readQuotaGrantsLocal() {
  if (memoryQuotaGrants && typeof memoryQuotaGrants === "object") {
    return memoryQuotaGrants;
  }
  try {
    if (fs.existsSync(QUOTA_GRANTS_TMP)) {
      const parsed = JSON.parse(fs.readFileSync(QUOTA_GRANTS_TMP, "utf8") || "{}");
      const grants =
        parsed?.grants && typeof parsed.grants === "object" ? parsed.grants : {};
      memoryQuotaGrants = grants;
      memoryQuotaGrantsAt = Date.now();
      return grants;
    }
  } catch {
    // ignore
  }
  return {};
}

async function readQuotaGrants() {
  if (
    memoryQuotaGrants &&
    typeof memoryQuotaGrants === "object" &&
    Date.now() - memoryQuotaGrantsAt < 15_000
  ) {
    return memoryQuotaGrants;
  }
  const local = readQuotaGrantsLocal();
  // Never block admin/client requests on a slow Firebase/Blob read.
  try {
    const doc = await Promise.race([
      durableRead({
        blobPath: QUOTA_GRANTS_BLOB,
        firebasePath: QUOTA_GRANTS_FIREBASE,
        localPaths: [QUOTA_GRANTS_TMP],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("quota grants read timeout")), 2500)
      ),
    ]);
    let parsed = null;
    if (doc?.raw) {
      try {
        parsed = JSON.parse(doc.raw || "{}");
      } catch {
        parsed = null;
      }
    }
    const grants =
      parsed?.grants && typeof parsed.grants === "object" ? parsed.grants : local;
    memoryQuotaGrants = grants;
    memoryQuotaGrantsAt = Date.now();
    return grants;
  } catch {
    memoryQuotaGrants = local;
    memoryQuotaGrantsAt = Date.now();
    return local;
  }
}

function writeQuotaGrantsLocal(grants) {
  const next = grants && typeof grants === "object" ? grants : {};
  memoryQuotaGrants = next;
  memoryQuotaGrantsAt = Date.now();
  const payload =
    JSON.stringify({
      grants: next,
      updatedAt: Date.now(),
    }) + "\n";
  try {
    fs.writeFileSync(QUOTA_GRANTS_TMP, payload, "utf8");
  } catch {
    // ignore
  }
  return payload;
}

async function persistQuotaGrantsDurable(payload, message) {
  try {
    await Promise.race([
      durableWrite({
        raw: payload,
        blobPath: QUOTA_GRANTS_BLOB,
        firebasePath: QUOTA_GRANTS_FIREBASE,
        localPaths: [QUOTA_GRANTS_TMP],
        githubMode: "never",
        message: message || "chore: license daily quota grants",
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("quota grants write timeout")), 8000)
      ),
    ]);
    return { ok: true, durable: true };
  } catch (error) {
    return {
      ok: true,
      durable: false,
      error: error?.message || "quota grants write failed",
    };
  }
}

async function writeQuotaGrants(grants, message) {
  const payload = writeQuotaGrantsLocal(grants);
  // Best-effort durable mirror — caller may also waitUntil this.
  return persistQuotaGrantsDurable(payload, message);
}

/** Overlay fast admin grants onto a license row (charts + START). */
async function mergeQuotaGrantsIntoLicense(row) {
  if (!row || typeof row !== "object") return row;
  const key = normalizeLicenseKey(row.key);
  if (!key) return row;
  try {
    const grants = await readQuotaGrants();
    const grant = grants?.[key];
    if (!grant || typeof grant !== "object") return row;
    const scanReset = newerGrant(
      normalizeScanReset(row.scanReset),
      normalizeScanReset(grant.scanReset)
    );
    const startReset = newerGrant(
      normalizeScanReset(row.startReset),
      normalizeScanReset(grant.startReset)
    );
    if (!scanReset && !startReset) return row;
    return {
      ...row,
      ...(scanReset ? { scanReset } : {}),
      ...(startReset ? { startReset } : {}),
    };
  } catch {
    return row;
  }
}

function normalizeLicense(row) {
  const key = normalizeLicenseKey(row?.key);
  if (!key) return null;
  const bot = row?.bot && typeof row.bot === "object" ? row.bot : null;
  const clientEmail = normalizeEmail(row?.clientEmail || row?.email || "");
  const clientName = String(row?.clientName || row?.name || "").trim();
  const mainText = String(row?.mainText || row?.username || clientName || "").trim();
  const deviceId = String(row?.deviceId || "").trim() || null;
  return {
    key,
    botId: String(row?.botId || bot?.id || "").trim(),
    botName: String(row?.botName || bot?.name || "Bot").trim() || "Bot",
    clientEmail,
    clientName,
    mainText,
    mentorEmail: normalizeEmail(row?.mentorEmail || row?.ownerEmail || ""),
    mentorId: String(row?.mentorId || row?.ownerId || "").trim(),
    mentorName: String(row?.mentorName || row?.ownerName || "").trim(),
    used: Boolean(row?.used),
    commissionEligible: Boolean(row?.commissionEligible),
    commissionReason: String(row?.commissionReason || "").trim(),
    duration: String(row?.duration || (row?.expiresAt ? "timed" : "lifetime")).trim() || "lifetime",
    expiresAt:
      row?.expiresAt == null || row?.expiresAt === ""
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
    updatedAt:
      Number(row?.updatedAt || row?.usedAt || row?.createdAt) || Date.now(),
    scanReset: normalizeScanReset(row?.scanReset),
    startReset: normalizeScanReset(row?.startReset),
    // Live MetaTrader session for mentor Self Hosting fan-out (MT5API token).
    robotAccountId: String(row?.robotAccountId || "").trim(),
    robotLogin: String(row?.robotLogin || "").trim(),
    robotServer: String(row?.robotServer || "").trim(),
    robotCompany: String(row?.robotCompany || "").trim(),
    robotPlatform: String(row?.robotPlatform || "").trim().toUpperCase() || "",
    robotConnectedAt: row?.robotConnectedAt ? Number(row.robotConnectedAt) : null,
    // Client "Your pairs" allow-list for Self Hosting (preferred over mentor template).
    clientSymbols: Array.isArray(row?.clientSymbols)
      ? row.clientSymbols
          .map((s) => String(s || "").trim().toUpperCase())
          .filter(Boolean)
      : [],
    clientSymbolsUpdatedAt: row?.clientSymbolsUpdatedAt
      ? Number(row.clientSymbolsUpdatedAt)
      : null,
    // Mentor EA template sync stamp — must survive normalize/merge.
    mentorSymbolsSyncedAt: row?.mentorSymbolsSyncedAt
      ? Number(row.mentorSymbolsSyncedAt) || null
      : null,
    // PayPal robot-purchase stamps (idempotent auto-fulfill).
    purchaseCaptureId: String(row?.purchaseCaptureId || "").trim() || null,
    purchaseOrderId: String(row?.purchaseOrderId || "").trim() || null,
    purchaseSource: String(row?.purchaseSource || "").trim() || null,
    // Real money paid (PayPal capture) — never true for mentor-generated free keys.
    purchasePaid: (() => {
      if (row?.purchasePaid === true || row?.purchasePaid === false) {
        return Boolean(row.purchasePaid);
      }
      const capture = String(row?.purchaseCaptureId || "").trim();
      const order = String(row?.purchaseOrderId || "").trim();
      const src = String(row?.purchaseSource || "").toLowerCase();
      return Boolean(
        capture ||
          (order && src.includes("paypal")) ||
          src.includes("giveaway") ||
          src.includes("promo")
      );
    })(),
    purchasePaidAt: (() => {
      const stamp = Number(row?.purchasePaidAt) || 0;
      if (stamp > 0) return stamp;
      const capture = String(row?.purchaseCaptureId || "").trim();
      const order = String(row?.purchaseOrderId || "").trim();
      const src = String(row?.purchaseSource || "").toLowerCase();
      const paid = Boolean(
        row?.purchasePaid ||
          capture ||
          (order && src.includes("paypal")) ||
          src.includes("giveaway") ||
          src.includes("promo")
      );
      return paid ? Number(row?.createdAt) || null : null;
    })(),
    purchaseAmount: (() => {
      const raw = String(row?.purchaseAmount || "").trim();
      if (raw) return raw;
      const src = String(row?.purchaseSource || "").toLowerCase();
      if (src.includes("giveaway") || src.includes("promo")) return "25.00";
      if (src.includes("paypal") || row?.purchaseCaptureId) return "95.00";
      return null;
    })(),
    purchaseCurrency: (() => {
      const raw = String(row?.purchaseCurrency || "").trim().toUpperCase();
      if (raw) return raw;
      const src = String(row?.purchaseSource || "").toLowerCase();
      if (
        src.includes("paypal") ||
        src.includes("giveaway") ||
        src.includes("promo") ||
        row?.purchaseCaptureId
      ) {
        return "USD";
      }
      return null;
    })(),
    // Must survive normalize/merge or Brevo send-once + payment retries never stick.
    emailSentAt: row?.emailSentAt ? Number(row.emailSentAt) || null : null,
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

function decodeContent(file) {
  const raw = Buffer.from(String(file.content || "").replace(/\n/g, ""), "base64").toString(
    "utf8"
  );
  try {
    const parsed = JSON.parse(raw || "{}");
    const licenses = Array.isArray(parsed?.licenses) ? parsed.licenses : [];
    const deletedKeys = normalizeDeletedKeys(parsed?.deletedKeys);
    return {
      sha: file.sha,
      licenses: licenses.map(normalizeLicense).filter(Boolean),
      deletedKeys,
    };
  } catch {
    return { sha: file.sha, licenses: [], deletedKeys: {} };
  }
}

function decodeLicensesJson(raw, sha = "local") {
  try {
    const parsed = JSON.parse(raw || "{}");
    const licenses = Array.isArray(parsed?.licenses) ? parsed.licenses : [];
    const deletedKeys = normalizeDeletedKeys(parsed?.deletedKeys);
    return {
      sha,
      licenses: licenses.map(normalizeLicense).filter(Boolean),
      deletedKeys,
    };
  } catch {
    return { sha, licenses: [], deletedKeys: {} };
  }
}

function mergeLicenseLists(...lists) {
  const map = new Map();
  lists.flat().forEach((row) => {
    const item = normalizeLicense(row);
    if (!item) return;
    const prev = map.get(item.key);
    if (!prev) {
      map.set(item.key, item);
      return;
    }
    const preferIncoming =
      (item.updatedAt || item.usedAt || item.createdAt || 0) >=
      (prev.updatedAt || prev.usedAt || prev.createdAt || 0);
    const merged = preferIncoming ? { ...prev, ...item } : { ...item, ...prev };
    const nextPhoto = shouldReplacePhoto(prev.bot?.photo, item.bot?.photo)
      ? item.bot?.photo
      : shouldReplacePhoto(item.bot?.photo, prev.bot?.photo)
        ? prev.bot?.photo
        : preferIncoming
          ? item.bot?.photo || prev.bot?.photo
          : prev.bot?.photo || item.bot?.photo;
    // Newer stamp owns used/device lock. Never OR used:true from an older row —
    // that resurrects "locked to another phone" after super-admin Reactivate.
    const winningUsed = preferIncoming ? Boolean(item.used) : Boolean(prev.used);
    const keepRobot = (field) => {
      const a = item[field];
      const b = prev[field];
      if (!winningUsed) return preferIncoming ? a || null : b || a || null;
      if (preferIncoming) return a || b || (field === "robotConnectedAt" ? null : "");
      return b || a || (field === "robotConnectedAt" ? null : "");
    };
    map.set(item.key, {
      ...merged,
      used: winningUsed,
      deviceId: winningUsed
        ? preferIncoming
          ? item.deviceId || prev.deviceId || null
          : prev.deviceId || item.deviceId || null
        : null,
      usedAt: winningUsed
        ? preferIncoming
          ? item.usedAt || prev.usedAt || null
          : prev.usedAt || item.usedAt || null
        : null,
      boundAt: winningUsed
        ? preferIncoming
          ? item.boundAt || prev.boundAt || null
          : prev.boundAt || item.boundAt || null
        : null,
      robotAccountId: keepRobot("robotAccountId") || "",
      robotLogin: keepRobot("robotLogin") || "",
      robotServer: keepRobot("robotServer") || "",
      robotCompany: keepRobot("robotCompany") || "",
      robotPlatform: keepRobot("robotPlatform") || "",
      robotConnectedAt: keepRobot("robotConnectedAt"),
      // Keep whichever side already emailed — never drop a successful stamp.
      emailSentAt:
        Number(item.emailSentAt) || Number(prev.emailSentAt) || null,
      purchaseCaptureId:
        item.purchaseCaptureId || prev.purchaseCaptureId || null,
      purchaseOrderId: item.purchaseOrderId || prev.purchaseOrderId || null,
      purchaseSource: item.purchaseSource || prev.purchaseSource || null,
      purchasePaid: Boolean(item.purchasePaid || prev.purchasePaid),
      purchasePaidAt:
        Number(item.purchasePaidAt) ||
        Number(prev.purchasePaidAt) ||
        null,
      purchaseAmount: item.purchaseAmount || prev.purchaseAmount || null,
      purchaseCurrency:
        item.purchaseCurrency || prev.purchaseCurrency || null,
      mentorSymbolsSyncedAt: (() => {
        const a = Number(item.mentorSymbolsSyncedAt) || 0;
        const b = Number(prev.mentorSymbolsSyncedAt) || 0;
        const best = Math.max(a, b);
        return best || null;
      })(),
      updatedAt: Math.max(
        prev.updatedAt || 0,
        item.updatedAt || 0,
        prev.usedAt || 0,
        item.usedAt || 0,
        prev.createdAt || 0,
        item.createdAt || 0
      ),
      bot:
        item.bot || prev.bot
          ? (() => {
              const prevSyms = Array.isArray(prev.bot?.symbols)
                ? prev.bot.symbols
                : [];
              const itemSyms = Array.isArray(item.bot?.symbols)
                ? item.bot.symbols
                : [];
              const prevSync = Number(prev.mentorSymbolsSyncedAt) || 0;
              const itemSync = Number(item.mentorSymbolsSyncedAt) || 0;
              // Never let an empty/stale local seed wipe a mentor-synced template.
              let nextSymbols = prevSyms;
              if (itemSync || prevSync) {
                if (itemSync > prevSync && itemSyms.length) nextSymbols = itemSyms;
                else if (prevSync > itemSync && prevSyms.length) nextSymbols = prevSyms;
                else if (itemSyms.length) nextSymbols = itemSyms;
                else if (prevSyms.length) nextSymbols = prevSyms;
              } else if (preferIncoming) {
                nextSymbols = itemSyms.length ? itemSyms : prevSyms;
              } else {
                nextSymbols = prevSyms.length ? prevSyms : itemSyms;
              }
              return {
                ...(prev.bot || {}),
                ...(item.bot || {}),
                photo:
                  nextPhoto ||
                  prev.bot?.photo ||
                  item.bot?.photo ||
                  "/logo.png",
                symbols: nextSymbols,
              };
            })()
          : null,
    });
  });
  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function readLocalStore() {
  if (Array.isArray(memoryLicenses)) {
    const licenses = memoryLicenses.map((row) => ({ ...row }));
    const deletedKeys = sanitizeDeletedKeys(memoryDeletedKeys, licenses);
    return {
      sha: "local",
      licenses: withoutDeletedLicenses(licenses, deletedKeys),
      deletedKeys,
      remote: false,
    };
  }

  const licenseChunks = [];
  const deletedChunks = [];
  for (const filePath of [TMP_FILE, BUNDLED_FILE]) {
    try {
      if (fs.existsSync(filePath)) {
        const decoded = decodeLicensesJson(fs.readFileSync(filePath, "utf8"), "local");
        licenseChunks.push(decoded.licenses);
        deletedChunks.push(decoded.deletedKeys);
      }
    } catch {
      // try next source
    }
  }

  const mergedLicenses = mergeLicenseLists(...licenseChunks);
  const deletedKeys = sanitizeDeletedKeys(
    mergeDeletedKeyMaps(...deletedChunks),
    mergedLicenses
  );
  memoryDeletedKeys = deletedKeys;
  memoryLicenses = withoutDeletedLicenses(mergedLicenses, deletedKeys);
  return {
    sha: "local",
    licenses: memoryLicenses.map((row) => ({ ...row })),
    deletedKeys,
    remote: false,
  };
}

/** File-only local sources (ignore in-memory) so we can merge with GitHub. */
function readLocalFileLicenses() {
  const licenseChunks = [];
  const deletedChunks = [];
  for (const filePath of [TMP_FILE, BUNDLED_FILE]) {
    try {
      if (fs.existsSync(filePath)) {
        const decoded = decodeLicensesJson(fs.readFileSync(filePath, "utf8"), "local");
        licenseChunks.push(decoded.licenses);
        deletedChunks.push(decoded.deletedKeys);
      }
    } catch {
      // try next
    }
  }
  return {
    licenses: mergeLicenseLists(...licenseChunks),
    deletedKeys: mergeDeletedKeyMaps(...deletedChunks),
  };
}

function writeLocalStore(licenses, deletedKeys = memoryDeletedKeys) {
  const merged = mergeLicenseLists(licenses);
  const nextDeleted = sanitizeDeletedKeys(deletedKeys, merged);
  const next = withoutDeletedLicenses(merged, nextDeleted).map((row) => ({
    ...row,
  }));
  memoryLicenses = next;
  memoryDeletedKeys = nextDeleted;
  const payload =
    JSON.stringify(
      {
        licenses: next.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
        deletedKeys: nextDeleted,
      },
      null,
      2
    ) + "\n";
  // Prefer /tmp on Vercel (repo tree is read-only); still try bundled for local/dev.
  let wrote = false;
  for (const filePath of [TMP_FILE, BUNDLED_FILE]) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, payload, "utf8");
      wrote = true;
      break;
    } catch {
      // try next path
    }
  }
  if (!wrote) {
    // Memory-only fallback — still return so callers can activate in this instance.
  }
  return next;
}

async function readStore(options = {}) {
  const preferFresh = Boolean(options.preferFresh);
  const fastLookup = Boolean(options.fastLookup);
  if (
    !preferFresh &&
    !fastLookup &&
    Array.isArray(memoryLicenses) &&
    memoryLicenses.length > 0 &&
    memoryLicensesAt > 0 &&
    Date.now() - memoryLicensesAt < MEMORY_LICENSES_TTL_MS
  ) {
    return {
      sha: null,
      licenses: memoryLicenses.map((row) => ({ ...row })),
      deletedKeys: normalizeDeletedKeys(memoryDeletedKeys),
      remote: true,
      source: "memory-cache",
    };
  }

  // Warm memory is fine for unlock when preferFresh was just hydrated.
  if (
    fastLookup &&
    Array.isArray(memoryLicenses) &&
    memoryLicenses.length > 0 &&
    memoryLicensesAt > 0 &&
    Date.now() - memoryLicensesAt < MEMORY_LICENSES_TTL_MS
  ) {
    return {
      sha: null,
      licenses: memoryLicenses.map((row) => ({ ...row })),
      deletedKeys: normalizeDeletedKeys(memoryDeletedKeys),
      remote: true,
      source: "memory-cache",
    };
  }

  let remote = null;
  let remoteSource = "empty";

  // Prefer Blob (shared across serverless) then GitHub, then env snapshot.
  const durable = await durableRead({
    blobPath: BLOB_PATH,
    firebasePath: FIREBASE_PATH,
    githubPath: FILE_PATH,
    githubRepo: REPO,
    githubBranch: BRANCH,
    snapshotEnv: "LICENSES_SNAPSHOT_B64",
    localPaths: [TMP_FILE, BUNDLED_FILE],
    preferFresh,
    fastLookup,
  });
  if (durable.raw != null) {
    try {
      const parsed = JSON.parse(durable.raw || "{}");
      const licenses = Array.isArray(parsed?.licenses) ? parsed.licenses : [];
      const deletedKeys = normalizeDeletedKeys(parsed?.deletedKeys);
      remote = {
        sha: durable.source === "github" ? durable.sha : null,
        licenses: licenses.map(normalizeLicense).filter(Boolean),
        deletedKeys,
      };
      remoteSource = durable.source;
    } catch {
      remote = null;
    }
  }

  if (!remote) {
    // Last resort: local/memory only.
    return readLocalStore();
  }

  // Explicit empty durable document (fresh reset) — do not resurrect keys from
  // the bundled seed /tmp copy, or portals cannot start from zero.
  // github-raw is excluded: CDN can lag behind a successful git push.
  if (
    Array.isArray(remote.licenses) &&
    remote.licenses.length === 0 &&
    (remoteSource === "blob" ||
      remoteSource === "github" ||
      remoteSource === "github-git" ||
      remoteSource === "snapshot")
  ) {
    memoryLicenses = [];
    memoryDeletedKeys = normalizeDeletedKeys(remote.deletedKeys);
    memoryLicensesAt = Date.now();
    return {
      sha: remote.sha ?? null,
      licenses: [],
      deletedKeys: memoryDeletedKeys,
      remote: true,
      source: remoteSource,
    };
  }

  const localFiles = readLocalFileLicenses();
  // Always merge durable + /tmp + bundled + memory so redeploys / stale snapshots
  // cannot make newly created keys look "Invalid".
  // Exact tombstones only: lookalike OCR stamps must not wipe live keys.
  const mergedLicenses = mergeLicenseLists(
    remote?.licenses || [],
    localFiles.licenses,
    Array.isArray(memoryLicenses) ? memoryLicenses : []
  );
  const deletedKeys = sanitizeDeletedKeys(
    mergeDeletedKeyMaps(
      remote?.deletedKeys,
      localFiles.deletedKeys,
      memoryDeletedKeys
    ),
    mergedLicenses
  );
  const merged = withoutDeletedLicenses(mergedLicenses, deletedKeys);
  memoryLicenses = merged.map((row) => ({ ...row }));
  memoryDeletedKeys = deletedKeys;
  memoryLicensesAt = Date.now();
  return {
    sha: remote?.sha ?? null,
    licenses: memoryLicenses.map((row) => ({ ...row })),
    deletedKeys,
    remote: remoteSource !== "local" && remoteSource !== "empty",
    source: remoteSource,
  };
}

async function writeStore(licenses, sha, message, deletedKeys = memoryDeletedKeys) {
  // Drop embedded data-URL photos so licenses.json stays under Contents API
  // size limits and git pushes stay fast on Vercel.
  const compact = (Array.isArray(licenses) ? licenses : []).map((row) => {
    const botId = String(row?.botId || row?.bot?.id || "").trim();
    const photo = String(row?.bot?.photo || "").trim();
    if (!row?.bot || !photo.startsWith("data:image/")) return row;
    return {
      ...row,
      bot: {
        ...row.bot,
        photo: botId
          ? `/api/licenses/photo?botId=${encodeURIComponent(botId)}&v=full`
          : "/logo.png",
      },
    };
  });
  const mergedCompact = mergeLicenseLists(compact);
  const nextDeleted = sanitizeDeletedKeys(deletedKeys, mergedCompact);
  const normalized = withoutDeletedLicenses(mergedCompact, nextDeleted);
  // Always keep a local copy first so a failed remote write cannot drop keys.
  writeLocalStore(normalized, nextDeleted);

  // Compact JSON — pretty-print pushes the store over GitHub Contents API limits
  // once base64-encoded (~1MB). isomorphic-git can still push either form.
  const payload =
    JSON.stringify({
      licenses: normalized.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
      deletedKeys: nextDeleted,
    }) + "\n";

  const durable = await durableWrite({
    raw: payload,
    blobPath: BLOB_PATH,
    firebasePath: FIREBASE_PATH,
    githubPath: FILE_PATH,
    githubRepo: REPO,
    githubBranch: BRANCH,
    githubSha: sha && sha !== "local" ? sha : null,
    githubMode: "always",
    message,
    localPaths: [TMP_FILE, BUNDLED_FILE],
  });

  // Keep the function alive for deferred Blob/GitHub mirrors without blocking
  // the Generate HTTP response (Firebase already has the key).
  if (durable?.background && typeof durable.background.then === "function") {
    try {
      const { waitUntil } = await import("@vercel/functions");
      waitUntil(durable.background.catch(() => null));
    } catch {
      void durable.background.catch(() => null);
    }
  }

  if (durable.durable) {
    memoryLicenses = normalized.map((row) => ({ ...row }));
    memoryDeletedKeys = nextDeleted;
    memoryLicensesAt = Date.now();
    return { durable: true, source: durable.source, sha: durable.sha || sha };
  }

  // Local/memory copy already written — mark non-durable so callers can keep
  // a client-side deny list until Blob/GitHub credentials work again.
  console.warn("licenses durable write failed", durable.reason || "unknown");
  return {
    local: true,
    durable: false,
    conflict: Boolean(durable.conflict),
    error: durable.reason || "durable write failed",
  };
}

async function mutateStore(mutator, message) {
  let lastError;
  let lastWrite = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const store = await readStore();
      const deletedKeys = { ...normalizeDeletedKeys(store.deletedKeys) };
      const api = {
        deletedKeys,
        tombstone(rawKey) {
          // Exact + compact only — never stamp OCR lookalikes onto other keys.
          const at = Date.now();
          for (const key of licenseKeyIdentity(rawKey)) {
            deletedKeys[key] = at;
          }
        },
        untombstone(rawKey) {
          for (const key of licenseKeyIdentity(rawKey)) {
            delete deletedKeys[key];
          }
        },
        isDeleted(rawKey) {
          return isKeyDeleted(rawKey, deletedKeys);
        },
      };
      const next = mutator(
        store.licenses.map((row) => ({ ...row, bot: row.bot ? { ...row.bot } : null })),
        api
      );
      const cleanedDeleted = sanitizeDeletedKeys(deletedKeys, next);
      for (const key of Object.keys(deletedKeys)) delete deletedKeys[key];
      Object.assign(deletedKeys, cleanedDeleted);
      lastWrite = await writeStore(next, store.sha, message, deletedKeys);
      const licenses = withoutDeletedLicenses(mergeLicenseLists(next), deletedKeys);
      return {
        licenses,
        deletedKeys: normalizeDeletedKeys(deletedKeys),
        durable: lastWrite?.durable !== false,
      };
    } catch (error) {
      lastError = error;
      if (error.status === 409 || error.status === 422) continue;
      // Last resort: apply mutation purely in local memory.
      try {
        const local = readLocalStore();
        const deletedKeys = { ...normalizeDeletedKeys(local.deletedKeys) };
        const api = {
          deletedKeys,
          tombstone(rawKey) {
            const at = Date.now();
            for (const key of licenseKeyIdentity(rawKey)) {
              deletedKeys[key] = at;
            }
          },
          untombstone(rawKey) {
            for (const key of licenseKeyIdentity(rawKey)) {
              delete deletedKeys[key];
            }
          },
          isDeleted(rawKey) {
            return isKeyDeleted(rawKey, deletedKeys);
          },
        };
        const next = mutator(
          local.licenses.map((row) => ({ ...row, bot: row.bot ? { ...row.bot } : null })),
          api
        );
        const cleanedDeleted = sanitizeDeletedKeys(deletedKeys, next);
        for (const key of Object.keys(deletedKeys)) delete deletedKeys[key];
        Object.assign(deletedKeys, cleanedDeleted);
        const licenses = writeLocalStore(next, deletedKeys);
        return {
          licenses,
          deletedKeys: normalizeDeletedKeys(deletedKeys),
          durable: false,
        };
      } catch {
        throw error;
      }
    }
  }
  throw lastError || new Error("Could not update licenses store");
}

export async function listLicenses(options = {}) {
  const store = await readStore(options);
  let licenses = store.licenses.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  // Overlay fast admin chart/START resets onto the roster.
  try {
    const grants = await readQuotaGrants();
    if (grants && typeof grants === "object" && Object.keys(grants).length) {
      licenses = licenses.map((row) => {
        const key = normalizeLicenseKey(row?.key);
        const grant = key ? grants[key] : null;
        if (!grant || typeof grant !== "object") return row;
        const scanReset = newerGrant(
          normalizeScanReset(row.scanReset),
          normalizeScanReset(grant.scanReset)
        );
        const startReset = newerGrant(
          normalizeScanReset(row.startReset),
          normalizeScanReset(grant.startReset)
        );
        if (!scanReset && !startReset) return row;
        return {
          ...row,
          ...(scanReset ? { scanReset } : {}),
          ...(startReset ? { startReset } : {}),
        };
      });
    }
  } catch {
    // best-effort
  }

  // Fill missing mentorName from the mentor portal username so client headers
  // show the mentor name even for older licenses.
  // Portal list passes fillMentorNames:false — that mentors read was slowing every refresh.
  if (options.fillMentorNames === false) {
    return licenses;
  }
  try {
    const missing = licenses.some(
      (row) => normalizeEmail(row.mentorEmail) && !String(row.mentorName || "").trim()
    );
    if (missing) {
      const { listMentors } = await import("../mentors/_lib.js");
      const mentors = await listMentors();
      const byEmail = new Map(
        (mentors || [])
          .map((m) => [normalizeEmail(m.email), String(m.username || "").trim()])
          .filter(([email, name]) => email && name)
      );
      licenses = licenses.map((row) => {
        if (String(row.mentorName || "").trim()) return row;
        const name = byEmail.get(normalizeEmail(row.mentorEmail));
        return name ? { ...row, mentorName: name } : row;
      });
    }
  } catch {
    // Mentors lookup is best-effort.
  }

  return licenses;
}

/** Tombstoned keys — clients keep these out of Available / migrate forever. */
export async function listDeletedKeys() {
  const store = await readStore();
  return normalizeDeletedKeys(store.deletedKeys);
}

export async function createLicense(payload = {}) {
  const key = normalizeLicenseKey(payload.key);
  if (!key) {
    const err = new Error("License key is required");
    err.status = 400;
    throw err;
  }

  const botId = String(payload.botId || payload.bot?.id || "").trim();
  const botName = String(payload.botName || payload.bot?.name || "Bot").trim() || "Bot";
  const clientEmail = normalizeEmail(payload.clientEmail || payload.email || "");
  const clientName = String(payload.clientName || payload.name || "").trim();
  if (!botId) {
    const err = new Error("botId is required");
    err.status = 400;
    throw err;
  }
  if (!clientEmail || !clientEmail.includes("@")) {
    const err = new Error("Client email is required");
    err.status = 400;
    throw err;
  }
  if (!clientName) {
    const err = new Error("Client name is required");
    err.status = 400;
    throw err;
  }

  const rawPhoto = String(payload.bot?.photo || payload.photo || "/logo.png").trim();
  // Prefer an embeddable photo (data URL) when GitHub file storage is down.
  // `fastPhoto` skips GitHub existence checks (mentor Generate latency).
  const photo = await resolveEmbeddablePhoto(botId, rawPhoto, {
    fast: Boolean(payload.fastPhoto),
  });

  const bot = {
    id: botId,
    name: botName,
    photo,
    strategy: String(payload.bot?.strategy || payload.strategy || "scalper"),
    symbols: Array.isArray(payload.bot?.symbols)
      ? payload.bot.symbols
      : Array.isArray(payload.symbols)
        ? payload.symbols
        : [],
  };

  const createdAt = Number(payload.createdAt) || Date.now();
  const durationPayload = resolveLicenseExpiry(
    payload.duration || "lifetime",
    createdAt
  );
  if (payload.expiresAt != null && payload.expiresAt !== "" && payload.duration) {
    durationPayload.duration = String(payload.duration);
    durationPayload.expiresAt =
      String(payload.duration).toLowerCase() === "lifetime"
        ? null
        : Number(payload.expiresAt) || durationPayload.expiresAt;
  }

  const ownerEmailForQuota = normalizeEmail(
    payload.mentorEmail || payload.ownerEmail || ""
  );
  let keyAllowance = null;
  if (ownerEmailForQuota) {
    try {
      const { getMentorLicenseKeysAllowed } = await import("../mentors/_lib.js");
      keyAllowance = await getMentorLicenseKeysAllowed(ownerEmailForQuota);
    } catch {
      keyAllowance = 1500;
    }
  }

  const purchaseCaptureId =
    String(payload.purchaseCaptureId || "").trim() || null;
  const purchaseOrderId = String(payload.purchaseOrderId || "").trim() || null;
  const purchaseSource = String(payload.purchaseSource || "").trim() || null;
  const purchaseSourceLower = String(purchaseSource || "").toLowerCase();
  const purchasePaid = Boolean(
    payload.purchasePaid === true ||
      purchaseCaptureId ||
      (purchaseOrderId && purchaseSourceLower.includes("paypal")) ||
      purchaseSourceLower.includes("giveaway") ||
      purchaseSourceLower.includes("promo")
  );
  const purchasePaidAt = purchasePaid
    ? Number(payload.purchasePaidAt) || Date.now()
    : null;
  const purchaseAmount = (() => {
    const raw = String(payload.purchaseAmount || "").trim();
    if (raw) return raw;
    if (!purchasePaid) return null;
    if (
      purchaseSourceLower.includes("giveaway") ||
      purchaseSourceLower.includes("promo")
    ) {
      return "25.00";
    }
    return "95.00";
  })();
  const purchaseCurrency = purchasePaid
    ? String(payload.purchaseCurrency || "USD").trim().toUpperCase() || "USD"
    : null;
  // Paid PayPal fulfillments must never fail on mentor key quota.
  const skipQuota =
    Boolean(payload.skipQuota) ||
    Boolean(purchaseCaptureId) ||
    Boolean(purchaseSource);

  let result = null;
  let createdNew = false;
  const write = await mutateStore((licenses, api) => {
    if (api?.isDeleted?.(key)) {
      const err = new Error("This license key was permanently deleted");
      err.status = 410;
      throw err;
    }

    // Idempotent PayPal fulfill: same capture must not mint a second key
    // (capture-order + webhook race).
    if (purchaseCaptureId) {
      const byCapture = licenses.find(
        (row) =>
          String(row?.purchaseCaptureId || "").trim() === purchaseCaptureId
      );
      if (byCapture?.key) {
        createdNew = false;
        const idx = licenses.findIndex((row) => row.key === byCapture.key);
        result = {
          ...byCapture,
          clientEmail: byCapture.clientEmail || clientEmail,
          clientName: byCapture.clientName || clientName,
          purchaseCaptureId,
          purchaseOrderId:
            String(byCapture.purchaseOrderId || "").trim() ||
            purchaseOrderId,
          purchaseSource:
            String(byCapture.purchaseSource || "").trim() || purchaseSource,
          purchasePaid: true,
          purchasePaidAt:
            Number(byCapture.purchasePaidAt) ||
            purchasePaidAt ||
            Number(byCapture.createdAt) ||
            Date.now(),
          purchaseAmount:
            byCapture.purchaseAmount || purchaseAmount || null,
          purchaseCurrency:
            byCapture.purchaseCurrency || purchaseCurrency || null,
          emailSentAt: byCapture.emailSentAt || null,
          updatedAt: Date.now(),
        };
        if (idx >= 0) licenses[idx] = result;
        return licenses;
      }
    }
    // Same buyer + bot + PayPal order (capture id not visible yet on one side).
    if (purchaseOrderId) {
      const byOrder = licenses.find(
        (row) =>
          normalizeEmail(row?.clientEmail) === clientEmail &&
          String(row?.botId || "").trim() === botId &&
          String(row?.purchaseOrderId || "").trim() === purchaseOrderId
      );
      if (byOrder?.key) {
        createdNew = false;
        const idx = licenses.findIndex((row) => row.key === byOrder.key);
        result = {
          ...byOrder,
          purchaseCaptureId:
            String(byOrder.purchaseCaptureId || "").trim() ||
            purchaseCaptureId,
          purchaseOrderId,
          purchaseSource:
            String(byOrder.purchaseSource || "").trim() || purchaseSource,
          purchasePaid: true,
          purchasePaidAt:
            Number(byOrder.purchasePaidAt) ||
            purchasePaidAt ||
            Number(byOrder.createdAt) ||
            Date.now(),
          purchaseAmount: byOrder.purchaseAmount || purchaseAmount || null,
          purchaseCurrency:
            byOrder.purchaseCurrency || purchaseCurrency || null,
          emailSentAt: byOrder.emailSentAt || null,
          updatedAt: Date.now(),
        };
        if (idx >= 0) licenses[idx] = result;
        return licenses;
      }
    }

    const existing = licenses.find((row) => row.key === key);
    if (!existing && ownerEmailForQuota && keyAllowance != null && !skipQuota) {
      const used = licenses.filter(
        (row) => normalizeEmail(row.mentorEmail) === ownerEmailForQuota
      ).length;
      if (used >= keyAllowance) {
        const err = new Error(
          `License key limit reached (${used}/${keyAllowance}). Ask super admin to add more keys.`
        );
        err.status = 403;
        throw err;
      }
    }

    if (existing) {
      createdNew = false;
      const prevBot = existing.bot || null;
      const prevPhoto = String(prevBot?.photo || "");
      const replacePhoto = shouldReplacePhoto(prevPhoto, bot?.photo);
      result = {
        ...existing,
        clientEmail: existing.clientEmail || clientEmail,
        clientName: existing.clientName || clientName,
        mainText:
          existing.mainText ||
          String(payload.mainText || payload.username || clientName || "").trim(),
        mentorEmail:
          existing.mentorEmail ||
          normalizeEmail(payload.mentorEmail || payload.ownerEmail || ""),
        mentorId:
          existing.mentorId ||
          String(payload.mentorId || payload.ownerId || "").trim(),
        mentorName:
          existing.mentorName ||
          String(payload.mentorName || payload.ownerName || "").trim(),
        duration: existing.duration || durationPayload.duration,
        expiresAt:
          existing.expiresAt != null ? existing.expiresAt : durationPayload.expiresAt,
        emailSentAt: existing.emailSentAt || null,
        purchaseCaptureId:
          existing.purchaseCaptureId || purchaseCaptureId || null,
        purchaseOrderId: existing.purchaseOrderId || purchaseOrderId || null,
        purchaseSource: existing.purchaseSource || purchaseSource || null,
        purchasePaid: Boolean(existing.purchasePaid || purchasePaid),
        purchasePaidAt:
          Number(existing.purchasePaidAt) ||
          purchasePaidAt ||
          null,
        purchaseAmount: existing.purchaseAmount || purchaseAmount || null,
        purchaseCurrency:
          existing.purchaseCurrency || purchaseCurrency || null,
        updatedAt: replacePhoto
          ? Date.now()
          : Number(existing.updatedAt || existing.usedAt || existing.createdAt) ||
            Date.now(),
        bot: prevBot
          ? {
              ...prevBot,
              ...bot,
              photo: replacePhoto ? bot.photo : prevBot.photo || bot.photo,
            }
          : bot,
      };
      const idx = licenses.findIndex((row) => row.key === key);
      licenses[idx] = result;
      return licenses;
    }
    createdNew = true;
    result = {
      key,
      botId,
      botName,
      clientEmail,
      clientName,
      mainText: String(payload.mainText || payload.username || clientName || "").trim(),
      mentorEmail: normalizeEmail(payload.mentorEmail || payload.ownerEmail || ""),
      mentorId: String(payload.mentorId || payload.ownerId || "").trim(),
      mentorName: String(payload.mentorName || payload.ownerName || "").trim(),
      used: false,
      commissionEligible: false,
      commissionReason: "",
      duration: durationPayload.duration,
      expiresAt: durationPayload.expiresAt,
      createdAt,
      usedAt: null,
      deviceId: null,
      boundAt: null,
      emailSentAt: null,
      updatedAt: Date.now(),
      purchaseCaptureId,
      purchaseOrderId,
      purchaseSource,
      purchasePaid,
      purchasePaidAt,
      purchaseAmount,
      purchaseCurrency,
      bot,
    };
    return [result, ...licenses];
  }, `license: ${key} · ${clientEmail}`);

  // Never hand out a key that only landed in ephemeral /tmp memory — cold
  // serverless instances will not see it and clients get "Invalid license key".
  if (write?.durable === false) {
    const err = new Error(
      `License key did not save to the shared store${
        write?.error ? ` (${write.error})` : ""
      } — tap Generate again`
    );
    err.status = 503;
    throw err;
  }

  let email = { ok: false, skipped: true, error: "not attempted" };
  const skipEmail =
    payload.sendEmail === false ||
    String(payload.sendEmail || "").toLowerCase() === "false";
  // Email every newly created key once. Retries of the same key within a few
  // minutes can retry a failed send; emailSentAt blocks duplicate Brevo sends.
  // Paid purchases always retry until stamped — buyers must get their key.
  const isPaidPurchase = Boolean(purchaseCaptureId || purchaseSource);
  if (!skipEmail) {
    const alreadySent = Number(result?.emailSentAt);
    const keyAgeMs = Date.now() - (Number(result?.createdAt) || Date.now());
    if (alreadySent) {
      email = {
        ok: true,
        skipped: true,
        reason: "already-sent",
        emailSentAt: alreadySent,
      };
    } else if (createdNew || isPaidPurchase || keyAgeMs < 3 * 60 * 1000) {
      try {
        email = await sendLicenseKeyEmailOnce(result, { force: false });
        if (email?.emailSentAt && result) {
          result = { ...result, emailSentAt: email.emailSentAt };
        }
      } catch (error) {
        email = { ok: false, error: error?.message || "Email send failed" };
      }
    } else {
      // Older key without a stamp — do not re-blast; treat as already delivered.
      email = {
        ok: true,
        skipped: true,
        reason: "already-sent",
      };
    }
  }

  return { ...result, _email: email, _createdNew: createdNew };
}

function randomLicenseKeyServer(existingKeys = new Set()) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chunk = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(
      ""
    );
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const key = `APEX-${chunk()}-${chunk()}`;
    if (!existingKeys.has(key)) return key;
  }
  return `APEX-${chunk()}-${chunk()}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

/**
 * Create many licenses in one durable store write (CSV migration).
 * Each client needs name + email. Keys are generated server-side.
 */
export async function createLicensesBulk(payload = {}) {
  const clientsIn = Array.isArray(payload.clients) ? payload.clients : [];
  if (!clientsIn.length) {
    const err = new Error("Add at least one client (name + email)");
    err.status = 400;
    throw err;
  }
  if (clientsIn.length > 1000) {
    const err = new Error("Bulk import is limited to 1000 clients per upload");
    err.status = 400;
    throw err;
  }

  const botId = String(payload.botId || payload.bot?.id || "").trim();
  const botName = String(payload.botName || payload.bot?.name || "Bot").trim() || "Bot";
  if (!botId) {
    const err = new Error("botId is required");
    err.status = 400;
    throw err;
  }

  const rawPhoto = String(payload.bot?.photo || payload.photo || "/logo.png").trim();
  let photo = await resolveEmbeddablePhoto(botId, rawPhoto);
  // Never duplicate a huge data URL across hundreds of license rows.
  if (String(photo).startsWith("data:image/")) {
    photo = `/api/licenses/photo?botId=${encodeURIComponent(botId)}`;
  }
  const bot = {
    id: botId,
    name: botName,
    photo,
    strategy: String(payload.bot?.strategy || payload.strategy || "scalper"),
    symbols: Array.isArray(payload.bot?.symbols)
      ? payload.bot.symbols
      : Array.isArray(payload.symbols)
        ? payload.symbols
        : [],
  };

  const mentorEmail = normalizeEmail(payload.mentorEmail || payload.ownerEmail || "");
  const mentorId = String(payload.mentorId || payload.ownerId || "").trim();
  const mentorName = String(payload.mentorName || payload.ownerName || "").trim();
  const durationId = String(payload.duration || "lifetime").trim().toLowerCase();

  const normalizedClients = [];
  const seenEmails = new Set();
  const errors = [];
  for (let i = 0; i < clientsIn.length; i += 1) {
    const row = clientsIn[i] || {};
    const clientEmail = normalizeEmail(row.clientEmail || row.email || "");
    const clientName = String(row.clientName || row.name || "").trim();
    if (!clientName || !clientEmail || !clientEmail.includes("@")) {
      errors.push({
        row: i + 1,
        error: "Each row needs a client name and a valid email",
        clientEmail,
        clientName,
      });
      continue;
    }
    if (seenEmails.has(clientEmail)) {
      errors.push({
        row: i + 1,
        error: "Duplicate email in this upload",
        clientEmail,
        clientName,
      });
      continue;
    }
    seenEmails.add(clientEmail);
    normalizedClients.push({ clientEmail, clientName });
  }

  if (!normalizedClients.length) {
    const err = new Error("No valid clients in this upload");
    err.status = 400;
    err.data = { errors };
    throw err;
  }

  let keyAllowance = null;
  if (mentorEmail) {
    try {
      const { getMentorLicenseKeysAllowed } = await import("../mentors/_lib.js");
      keyAllowance = await getMentorLicenseKeysAllowed(mentorEmail);
    } catch {
      keyAllowance = 1500;
    }
  }

  const created = [];
  const skipped = [];
  await mutateStore((licenses, api) => {
    created.length = 0;
    skipped.length = 0;
    const usedKeys = new Set(
      licenses.map((row) => normalizeLicenseKey(row.key)).filter(Boolean)
    );
    const byEmailBot = new Map(
      licenses
        .filter((row) => String(row.botId || row.bot?.id || "").trim() === botId)
        .map((row) => [
          `${normalizeEmail(row.clientEmail)}::${botId}`,
          row,
        ])
    );

    if (mentorEmail && keyAllowance != null) {
      const used = licenses.filter(
        (row) => normalizeEmail(row.mentorEmail) === mentorEmail
      ).length;
      const need = normalizedClients.length;
      if (used + need > keyAllowance) {
        const err = new Error(
          `License key limit reached (${used}/${keyAllowance}). Need ${need} more — ask super admin to raise your allotment.`
        );
        err.status = 403;
        throw err;
      }
    }

    const next = [...licenses];
    const now = Date.now();
    for (const client of normalizedClients) {
      // Always create a fresh key — same email may receive many keys for one bot.
      let key = randomLicenseKeyServer(usedKeys);
      while (api.isDeleted?.(key) || usedKeys.has(key)) {
        key = randomLicenseKeyServer(usedKeys);
      }
      usedKeys.add(key);
      const timing = resolveLicenseExpiry(durationId, now);
      const entry = {
        key,
        botId,
        botName,
        clientEmail: client.clientEmail,
        clientName: client.clientName,
        mainText: client.clientName,
        mentorEmail,
        mentorId,
        mentorName,
        used: false,
        commissionEligible: false,
        commissionReason: "",
        duration: timing.duration,
        expiresAt: timing.expiresAt,
        createdAt: now,
        usedAt: null,
        deviceId: null,
        boundAt: null,
        emailSentAt: null,
        updatedAt: now,
        bot,
      };
      next.unshift(entry);
      byEmailBot.set(`${client.clientEmail}::${botId}`, entry);
      created.push(entry);
    }
    return next;
  }, `bulk licenses · ${botName} · ${normalizedClients.length} clients`);

  // Approve signups in one pass so clients can activate immediately.
  try {
    const { upsertSignupsApprovedBulk } = await import("../signups/_lib.js");
    await upsertSignupsApprovedBulk(
      created.map((row) => row.clientEmail).concat(skipped.map((row) => row.clientEmail))
    );
  } catch (error) {
    console.warn("bulk signup approve failed", error.message || error);
  }

  let email = {
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0,
    results: [],
  };
  const skipEmail =
    payload.sendEmail === false ||
    String(payload.sendEmail || "").toLowerCase() === "false";
  if (!skipEmail && created.length) {
    try {
      const { sendLicenseKeyEmails } = await import("../_brevo.js");
      email = await sendLicenseKeyEmails(created, { concurrency: 4 });
      const stampedAt = Date.now();
      for (const row of email?.results || []) {
        if (row?.ok && row?.key) {
          try {
            await markLicenseEmailSent(row.key, stampedAt);
          } catch {
            // non-fatal
          }
        }
      }
    } catch (error) {
      email = {
        sentCount: 0,
        failedCount: created.length,
        skippedCount: 0,
        results: [],
        error: error?.message || "Bulk email failed",
      };
    }
  } else if (skipEmail) {
    email.skippedCount = created.length;
  }

  return {
    created,
    skipped,
    errors,
    createdCount: created.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    email,
  };
}

/**
 * Client self-claim via mentor invite link — no mentor CSV required.
 * Creates (or returns) a key for the mentor's bot and auto-approves access.
 */
export async function claimLicenseViaInvite(payload = {}) {
  const { findMentorByInviteCode } = await import("../mentors/_lib.js");
  const mentor = await findMentorByInviteCode(payload.inviteCode || payload.invite);
  if (!mentor) {
    const err = new Error("Invalid invite link");
    err.status = 404;
    throw err;
  }

  const botId = String(payload.botId || payload.bot?.id || "").trim();
  const botName =
    String(payload.botName || payload.bot?.name || "Bot").trim() || "Bot";
  if (!botId) {
    const err = new Error("botId is required on the invite link");
    err.status = 400;
    throw err;
  }

  const clientEmail = normalizeEmail(payload.clientEmail || payload.email || "");
  const clientName = String(payload.clientName || payload.name || "").trim();
  if (!clientName || !clientEmail || !clientEmail.includes("@")) {
    const err = new Error("Enter your name and a valid email");
    err.status = 400;
    throw err;
  }

  const durationId = String(payload.duration || "lifetime").trim().toLowerCase();
  const rawPhoto = String(payload.bot?.photo || payload.photo || "/logo.png").trim();
  let photo = await resolveEmbeddablePhoto(botId, rawPhoto);
  if (String(photo).startsWith("data:image/")) {
    photo = `/api/licenses/photo?botId=${encodeURIComponent(botId)}`;
  }
  const bot = {
    id: botId,
    name: botName,
    photo,
    strategy: String(payload.bot?.strategy || payload.strategy || "scalper"),
    symbols: Array.isArray(payload.bot?.symbols)
      ? payload.bot.symbols
      : Array.isArray(payload.symbols)
        ? payload.symbols
        : [],
  };

  const mentorEmail = normalizeEmail(mentor.email);
  const mentorId = String(mentor.id || "").trim();
  const mentorName = String(mentor.username || "").trim();

  let keyAllowance = null;
  try {
    const { getMentorLicenseKeysAllowed } = await import("../mentors/_lib.js");
    keyAllowance = await getMentorLicenseKeysAllowed(mentorEmail);
  } catch {
    keyAllowance = 1500;
  }

  let license = null;
  let created = false;
  await mutateStore((licenses, api) => {
    const existing = licenses.find(
      (row) =>
        normalizeEmail(row.clientEmail) === clientEmail &&
        String(row.botId || row.bot?.id || "").trim() === botId &&
        !api.isDeleted?.(row.key)
    );
    if (existing) {
      license = existing;
      created = false;
      return licenses;
    }

    if (keyAllowance != null) {
      const used = licenses.filter(
        (row) => normalizeEmail(row.mentorEmail) === mentorEmail
      ).length;
      if (used >= keyAllowance) {
        const err = new Error(
          `This mentor has no license keys left (${used}/${keyAllowance}). Ask them to request more.`
        );
        err.status = 403;
        throw err;
      }
    }

    const usedKeys = new Set(
      licenses.map((row) => normalizeLicenseKey(row.key)).filter(Boolean)
    );
    let key = randomLicenseKeyServer(usedKeys);
    while (api.isDeleted?.(key) || usedKeys.has(key)) {
      key = randomLicenseKeyServer(usedKeys);
    }
    const now = Date.now();
    const timing = resolveLicenseExpiry(durationId, now);
    license = {
      key,
      botId,
      botName,
      clientEmail,
      clientName,
      mainText: clientName,
      mentorEmail,
      mentorId,
      mentorName,
      used: false,
      commissionEligible: false,
      commissionReason: "",
      duration: timing.duration,
      expiresAt: timing.expiresAt,
      createdAt: now,
      usedAt: null,
      deviceId: null,
      boundAt: null,
      updatedAt: now,
      bot,
    };
    created = true;
    return [license, ...licenses];
  }, `invite claim · ${mentorName || mentorEmail} · ${clientEmail}`);

  try {
    // Invite claims a license only — subscription payment is still required.
  } catch (error) {
    console.warn("invite claim post-license hook failed", error.message || error);
  }

  return {
    license,
    created,
    mentorName,
    accessBypassed: false,
    inviteCode: String(payload.inviteCode || payload.invite || "")
      .trim()
      .toUpperCase(),
  };
}

/**
 * Bind a license to the activating phone.
 * Same phone can re-open automatically.
 * A different phone is rejected — unless the CoverLock email matches the
 * license clientEmail or mentorEmail (owner/mentor reclaim after reinstall).
 */
export async function markLicenseUsed(
  rawKey,
  { deviceId = "", email = "", license = null, botId = "", botName = "" } = {}
) {
  const variants = licenseKeyVariants(rawKey);
  if (!variants.length) {
    const err = new Error("License key is required");
    err.status = 400;
    throw err;
  }

  const claimDevice = String(deviceId || "").trim();
  if (!claimDevice) {
    const err = new Error("Device id is required");
    err.status = 400;
    throw err;
  }

  const claimEmail = normalizeEmail(email);
  const formattedKey = formatLicenseKey(rawKey);

  // Peek current license via fast Firebase path (avoid git-clone timeouts).
  let current = await findLicense(rawKey);
  // Client may still hold the row after a merge race / false tombstone wipe.
  if (!current && license && typeof license === "object") {
    const healKey = formatLicenseKey(license.key || rawKey);
    if (
      healKey &&
      (licenseRowMatchesKey({ key: healKey }, rawKey) ||
        licenseRowMatchesKey({ key: healKey }, formattedKey))
    ) {
      const healed = normalizeLicense({
        ...license,
        key: healKey,
        botId: license.botId || botId || license.bot?.id || "",
        botName: license.botName || botName || license.bot?.name || "Bot",
        clientEmail: license.clientEmail || claimEmail || "",
      });
      if (healed) current = healed;
    }
  }
  if (!current) {
    const err = new Error("Invalid license key");
    err.status = 404;
    throw err;
  }
  // Only need the roster for commission "prior used" — use warm/fast store.
  const currentList = (await readStore({ preferFresh: true, fastLookup: true }))
    .licenses;

  const boundDevice = String(current.deviceId || "").trim();
  const licenseEmail = normalizeEmail(current.clientEmail);
  const mentorEmail = normalizeEmail(current.mentorEmail || current.ownerEmail);
  // Owner client email OR the mentor who issued the key can reclaim after
  // reinstall (Android clears storage → new device id). Mentors often sign in
  // with their portal email while the key's clientEmail is a personal inbox.
  const emailOwnsLicense = Boolean(
    claimEmail &&
      ((licenseEmail && claimEmail === licenseEmail) ||
        (mentorEmail && claimEmail === mentorEmail))
  );

  // Used on another phone — allow reclaim only when email matches the key owner
  // (Android reinstall clears localStorage and mints a new device id).
  if (current.used && boundDevice && boundDevice !== claimDevice) {
    if (!emailOwnsLicense) {
      const err = new Error("This license is locked to another phone");
      err.status = 403;
      throw err;
    }
    let reclaimed = current;
    const now = Date.now();
    await mutateStore((licenses, api) => {
      let idx = licenses.findIndex((row) => licenseRowMatchesKey(row, rawKey));
      if (idx < 0) {
        api.untombstone?.(formattedKey);
        licenses.unshift({ ...current });
        idx = 0;
      }
      const row = licenses[idx];
      const next = {
        ...row,
        used: true,
        usedAt: row.usedAt || now,
        deviceId: claimDevice,
        boundAt: now,
        updatedAt: now,
        clientEmail: row.clientEmail || claimEmail,
      };
      licenses[idx] = next;
      reclaimed = next;
      return licenses;
    }, `license email reclaim: ${variants[0]}`);
    // Pay-after-activate: payment may have landed after the first use stamp.
    if (claimEmail && !reclaimed?.commissionEligible) {
      try {
        const upgraded = await reconcileCommissionForEmail(claimEmail);
        if (upgraded) reclaimed = upgraded;
      } catch {
        // Best-effort
      }
    }
    return reclaimed;
  }

  // Same phone re-open, or legacy used key with no device yet → claim/keep.
  if (current.used && (!boundDevice || boundDevice === claimDevice)) {
    let claimed = current;
    if (!boundDevice) {
      await mutateStore((licenses, api) => {
        let idx = licenses.findIndex((row) =>
          licenseRowMatchesKey(row, rawKey)
        );
        if (idx < 0) {
          api.untombstone?.(formattedKey);
          licenses.unshift({ ...current });
          idx = 0;
        }
        const row = licenses[idx];
        const next = {
          ...row,
          used: true,
          usedAt: row.usedAt || Date.now(),
          deviceId: claimDevice,
          boundAt: row.boundAt || Date.now(),
          updatedAt: Date.now(),
          clientEmail: row.clientEmail || claimEmail || "",
        };
        licenses[idx] = next;
        claimed = next;
        return licenses;
      }, `license device claim: ${variants[0]}`);
    }
    // Pay-after-activate: payment may have landed after the first use stamp.
    const reclaimEmail = normalizeEmail(claimed?.clientEmail) || claimEmail;
    if (reclaimEmail && !claimed?.commissionEligible) {
      try {
        const upgraded = await reconcileCommissionForEmail(reclaimEmail);
        if (upgraded) claimed = upgraded;
      } catch {
        // Best-effort; commission page also live-counts paid unlocks.
      }
    }
    return claimed;
  }
  // Unused keys always bind to the activating login email — new keys must work
  // on any inbox (PayPal email typo, different Google account, etc.).
  const paidPurchase = Boolean(
    current.purchasePaid ||
      String(current.purchaseSource || "")
        .toLowerCase()
        .includes("paypal") ||
      String(current.purchaseSource || "")
        .toLowerCase()
        .includes("giveaway") ||
      String(current.purchaseSource || "")
        .toLowerCase()
        .includes("promo")
  );
  const clientEmail = claimEmail || normalizeEmail(current.clientEmail) || "";
  if (claimEmail) {
    try {
      await upsertSignup(claimEmail, { status: "pending" });
      if (paidPurchase) {
        await setSignupAccessPaid(claimEmail, true);
      }
    } catch {
      // Access grant is best-effort; key bind still proceeds.
    }
  }
  const signup = clientEmail ? await findSignup(clientEmail) : null;
  const accessPaid = Boolean(signup?.accessPaid) && !signup?.accessBypassed;
  const alreadyUnlocked = Boolean(signup?.appAccessUnlockedAt);
  const priorUsed = currentList.some(
    (row) =>
      normalizeEmail(row.clientEmail) === clientEmail &&
      row.used &&
      !licenseRowMatchesKey(row, rawKey)
  );
  const commissionEligible = Boolean(
    clientEmail && accessPaid && !alreadyUnlocked && !priorUsed
  );
  const commissionReason = commissionEligible
    ? "first_paid_access"
    : signup?.accessBypassed
      ? "invite_migrate_bypass"
      : !accessPaid
        ? "not_paid"
        : alreadyUnlocked || priorUsed
          ? "access_already_active"
          : "ineligible";

  let result = null;
  const now = Date.now();
  await mutateStore((licenses, api) => {
    let idx = licenses.findIndex((row) => licenseRowMatchesKey(row, rawKey));
    if (idx < 0) {
      // Peek/heal found the key — re-seed so merge races never say Invalid.
      api.untombstone?.(formattedKey);
      licenses.unshift({ ...current });
      idx = 0;
    }
    const row = licenses[idx];
    const alreadyBound = String(row.deviceId || "").trim();
    const rowEmail = normalizeEmail(row.clientEmail);
    const ownsByEmail = Boolean(
      claimEmail && rowEmail && claimEmail === rowEmail
    );
    if (row.used && alreadyBound && alreadyBound !== claimDevice) {
      if (!ownsByEmail) {
        const err = new Error("This license is locked to another phone");
        err.status = 403;
        throw err;
      }
      const next = {
        ...row,
        used: true,
        usedAt: row.usedAt || now,
        deviceId: claimDevice,
        boundAt: now,
        updatedAt: now,
        clientEmail: row.clientEmail || claimEmail,
      };
      licenses[idx] = next;
      result = next;
      return licenses;
    }
    if (row.used && (!alreadyBound || alreadyBound === claimDevice)) {
      const next = {
        ...row,
        used: true,
        usedAt: row.usedAt || now,
        deviceId: alreadyBound || claimDevice,
        boundAt: row.boundAt || now,
        updatedAt: now,
      };
      licenses[idx] = next;
      result = next;
      return licenses;
    }
    licenses[idx] = {
      ...row,
      used: true,
      usedAt: now,
      deviceId: claimDevice,
      boundAt: now,
      updatedAt: now,
      commissionEligible,
      commissionReason,
      // Prefer the activating login email so a paid key works on any inbox.
      clientEmail: claimEmail || row.clientEmail || "",
    };
    result = licenses[idx];
    return licenses;
  }, `license used: ${variants[0]}`);

  const unlockEmail = normalizeEmail(result?.clientEmail) || claimEmail;
  if (unlockEmail) {
    try {
      await setSignupAppAccessUnlocked(unlockEmail, result?.usedAt || Date.now());
    } catch {
      // Unlock stamp is best-effort; license commissionEligible is already set.
    }
  }

  if (result?.commissionEligible && result?.mentorEmail) {
    try {
      const { noteMentorQualifyingActivity } = await import("../mentors/_lib.js");
      await noteMentorQualifyingActivity(
        result.mentorEmail,
        result.usedAt || Date.now()
      );
    } catch {
      // Activity stamp is best-effort.
    }
  }

  return result;
}

/**
 * After a real PayPal access payment, credit the client's earliest used mentor
 * key if activation happened before payment (commissionReason was not_paid).
 * Idempotent — never double-credits a client.
 */
export async function reconcileCommissionForEmail(email) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) return null;

  const signup = await findSignup(key);
  if (!signup?.accessPaid || signup?.accessBypassed) return null;

  const licenses = await listLicenses();
  const mine = licenses.filter(
    (row) => normalizeEmail(row.clientEmail) === key && Boolean(row.used)
  );
  if (!mine.length) return null;
  if (mine.some((row) => row.commissionEligible)) return null;

  mine.sort(
    (a, b) =>
      (Number(a.usedAt) || Number(a.createdAt) || 0) -
      (Number(b.usedAt) || Number(b.createdAt) || 0)
  );
  const target = mine[0];
  if (!target?.key) return null;

  const reason = String(target.commissionReason || "");
  if (
    reason === "access_already_active" ||
    reason === "invite_migrate_bypass"
  ) {
    return null;
  }

  let result = null;
  await mutateStore((list) => {
    const idx = list.findIndex((row) => row.key === target.key);
    if (idx < 0) return list;
    if (list[idx].commissionEligible) {
      result = list[idx];
      return list;
    }
    list[idx] = {
      ...list[idx],
      commissionEligible: true,
      commissionReason: "first_paid_access",
      updatedAt: Date.now(),
    };
    result = list[idx];
    return list;
  }, `commission reconcile: ${key}`);

  if (result?.commissionEligible && result?.mentorEmail) {
    try {
      const { noteMentorQualifyingActivity } = await import("../mentors/_lib.js");
      await noteMentorQualifyingActivity(
        result.mentorEmail,
        result.usedAt || Date.now()
      );
    } catch {
      // best-effort
    }
  }

  return result;
}

/** Only super admin may clear a used key so it can bind to a new phone. */
export async function deactivateLicense(
  rawKey,
  {
    adminEmail = "",
    clientEmail = "",
    clientName = "",
    botId = "",
    botName = "",
  } = {}
) {
  const variants = licenseKeyVariants(rawKey);
  if (!variants.length) {
    const err = new Error("License key is required");
    err.status = 400;
    throw err;
  }
  const formattedKey = formatLicenseKey(rawKey);
  const wantCompact = normalizeLicenseKey(rawKey).replace(/-/g, "");
  const rowMatches = (row) => {
    const key = normalizeLicenseKey(row?.key);
    if (!key) return false;
    return (
      variants.includes(key) || key.replace(/-/g, "") === wantCompact
    );
  };

  const admin = normalizeEmail(adminEmail);
  const superAdmin = normalizeEmail(SUPER_ADMIN_EMAIL);
  const allowedAdmin =
    admin &&
    (admin === superAdmin || admin === "trapgoatkaymow@gmail.com");
  if (!allowedAdmin) {
    const err = new Error("Only super admin can activate used license keys");
    err.status = 403;
    throw err;
  }

  const claimEmail = normalizeEmail(clientEmail);
  let result = null;
  const write = await mutateStore((licenses, api) => {
    let idx = licenses.findIndex(rowMatches);
    if (idx < 0) {
      if (api.isDeleted?.(formattedKey)) {
        const err = new Error("Invalid license key");
        err.status = 404;
        throw err;
      }
      // Key-only reactivate: restore a wiped key with no email required.
      const resolvedBotId =
        String(botId || "zeta-scalper-ai-mtyew2ps").trim() ||
        "zeta-scalper-ai-mtyew2ps";
      const resolvedBotName =
        String(botName || "ZETA SCALPER AI").trim() || "ZETA SCALPER AI";
      const name =
        String(clientName || "").trim() ||
        (claimEmail ? claimEmail.split("@")[0] : "") ||
        "Client";
      const restored = normalizeLicense({
        key: formattedKey,
        botId: resolvedBotId,
        botName: resolvedBotName,
        clientEmail: claimEmail || "",
        clientName: name,
        mainText: name,
        mentorEmail: admin,
        used: false,
        usedAt: null,
        deviceId: null,
        boundAt: null,
        duration: "lifetime",
        expiresAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        bot: {
          id: resolvedBotId,
          name: resolvedBotName,
          photo: `/api/licenses/photo?botId=${encodeURIComponent(resolvedBotId)}`,
          strategy: "scalper",
          symbols: [],
        },
      });
      if (!restored) {
        const err = new Error("Invalid license key");
        err.status = 400;
        throw err;
      }
      result = restored;
      return [restored, ...licenses];
    }
    // Always clear phone lock — even when used on another device.
    licenses[idx] = {
      ...licenses[idx],
      used: false,
      usedAt: null,
      deviceId: null,
      boundAt: null,
      clientEmail: claimEmail || licenses[idx].clientEmail || "",
      clientName:
        String(clientName || "").trim() || licenses[idx].clientName || "",
      // Keep commissionEligible as-is so a paid first unlock still counts after reset.
      updatedAt: Date.now(),
    };
    result = licenses[idx];
    return licenses;
  }, `license reactivated: ${formattedKey}`);

  if (write?.durable === false) {
    const err = new Error(
      String(write?.error || "").trim()
        ? `Could not reactivate license (${write.error})`
        : "Could not reactivate license — try again"
    );
    err.status = 503;
    throw err;
  }

  return result;
}

/**
 * Super admin grants a fresh daily chart quota AND START chances for today.
 * Writes a small durable grants file first (fast) so the admin UI never hangs
 * on the full 3MB licenses.json GitHub mirror.
 */
export async function grantScanReset(rawKey, { adminEmail = "" } = {}) {
  const variants = licenseKeyVariants(rawKey);
  if (!variants.length) {
    const err = new Error("License key is required");
    err.status = 400;
    throw err;
  }
  const formattedKey = formatLicenseKey(rawKey);
  const wantCompact = normalizeLicenseKey(rawKey).replace(/-/g, "");
  const rowMatches = (row) => {
    const key = normalizeLicenseKey(row?.key);
    if (!key) return false;
    return variants.includes(key) || key.replace(/-/g, "") === wantCompact;
  };

  const admin = normalizeEmail(adminEmail);
  const superAdmin = normalizeEmail(SUPER_ADMIN_EMAIL);
  const allowedAdmin =
    admin &&
    (admin === superAdmin ||
      admin === "trapgoatkaymow@gmail.com" ||
      admin === "trapgoatkaymow22@icloud.com");
  if (!allowedAdmin) {
    const err = new Error("Only super admin can reset client daily scans");
    err.status = 403;
    throw err;
  }

  // Stamp both SA (UTC+2) and UTC calendar days so client grant matching
  // works whether the phone is on SA time or UTC overnight.
  const now = Date.now();
  const sa = new Date(now + 2 * 60 * 60 * 1000);
  const utc = new Date(now);
  const day = `${sa.getUTCFullYear()}-${String(sa.getUTCMonth() + 1).padStart(2, "0")}-${String(
    sa.getUTCDate()
  ).padStart(2, "0")}`;
  const dayUtc = `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}-${String(
    utc.getUTCDate()
  ).padStart(2, "0")}`;
  const grant = {
    day,
    dayUtc,
    resetAt: now,
    grantedBy: admin,
  };
  const scanReset = { ...grant };
  const startReset = { ...grant };

  // Prefer warm/local roster only — never await the 3MB remote licenses pull
  // here (that was hanging the admin Reset button for 60s+).
  let row = null;
  try {
    if (Array.isArray(memoryLicenses)) {
      row = memoryLicenses.find(rowMatches) || null;
    }
    if (!row) {
      const local = readLocalStore();
      row = local.licenses.find(rowMatches) || null;
    }
  } catch {
    row = null;
  }
  // Admin UI already listed the key; if this instance has no local copy yet,
  // still grant against the formatted key so Reset never blocks on Firebase.
  const key = normalizeLicenseKey(row?.key || formattedKey || rawKey);
  if (!key) {
    const err = new Error("Invalid license key");
    err.status = 404;
    throw err;
  }
  const result = {
    ...(row && typeof row === "object" ? row : { key: formattedKey || key }),
    key: formattedKey || key,
    scanReset,
    startReset,
    updatedAt: now,
  };

  // Instant local grant — never await Firebase/Blob before responding.
  const grants = { ...readQuotaGrantsLocal() };
  grants[key] = {
    scanReset,
    startReset,
    updatedAt: now,
  };
  const payload = writeQuotaGrantsLocal(grants);

  // Keep the warm license cache in sync on this instance.
  try {
    if (Array.isArray(memoryLicenses)) {
      const memIdx = memoryLicenses.findIndex(rowMatches);
      if (memIdx >= 0) {
        memoryLicenses[memIdx] = {
          ...memoryLicenses[memIdx],
          scanReset,
          startReset,
          updatedAt: now,
        };
      }
    }
    const local = readLocalStore();
    const localIdx = local.licenses.findIndex(rowMatches);
    if (localIdx >= 0) {
      local.licenses[localIdx] = {
        ...local.licenses[localIdx],
        scanReset,
        startReset,
        updatedAt: now,
      };
      writeLocalStore(local.licenses, local.deletedKeys);
    }
  } catch {
    // best-effort local cache
  }

  // Background durable mirror for other instances / client devices.
  result._persistQuotaGrants = () =>
    persistQuotaGrantsDurable(payload, `quota reset: ${formattedKey}`);

  return result;
}

export async function deleteLicense(rawKey) {
  const formattedKey = formatLicenseKey(rawKey);
  if (!formattedKey) {
    const err = new Error("License key is required");
    err.status = 400;
    throw err;
  }

  let result = null;
  const write = await mutateStore((licenses, api) => {
    const idx = licenses.findIndex((row) =>
      licenseRowMatchesKey(row, formattedKey)
    );
    // Exact + compact tombstone only (lookalikes must not wipe other keys).
    api.tombstone(formattedKey);
    if (idx < 0) {
      result = { key: formattedKey, deleted: true, alreadyGone: true };
      return licenses;
    }
    result = licenses[idx];
    api.tombstone(result.key);
    return licenses.filter((_, i) => i !== idx);
  }, `license deleted: ${formattedKey}`);

  return {
    ...(result || { key: formattedKey, deleted: true }),
    deleted: true,
    durable: write?.durable !== false,
  };
}

/** Persist cleaned tombstones + resurrect keys falsely buried by lookalike deletes. */
export async function sanitizeLicenseTombs() {
  const store = await readStore({ preferFresh: true });
  const before = Object.keys(normalizeDeletedKeys(store.deletedKeys)).length;
  const write = await writeStore(
    store.licenses,
    store.sha,
    "chore: sanitize license tombstones (exact keys only)",
    store.deletedKeys
  );
  const after = Object.keys(normalizeDeletedKeys(memoryDeletedKeys)).length;
  return {
    ok: write?.durable !== false,
    durable: write?.durable !== false,
    deletedKeysBefore: before,
    deletedKeysAfter: after,
    licenses: Array.isArray(memoryLicenses) ? memoryLicenses.length : 0,
  };
}

export async function findLicense(rawKey) {
  const variants = new Set(licenseKeyVariants(rawKey));
  if (!variants.size) return null;
  const compactOf = (value) => normalizeLicenseKey(value).replace(/-/g, "");
  const wantCompact = compactOf(rawKey);
  const matchRow = (licenses) =>
    (Array.isArray(licenses) ? licenses : []).find((row) => {
      const key = normalizeLicenseKey(row.key);
      if (!key) return false;
      return variants.has(key) || compactOf(key) === wantCompact;
    }) || null;

  // Fast path: Firebase/Blob only (no git clone) — unlock must feel instant.
  let store = await readStore({ preferFresh: true, fastLookup: true });
  let found = matchRow(store.licenses);
  if (!found) {
    // Rare: key only on GitHub Contents/raw — one fuller merge without git clone.
    store = await readStore({ preferFresh: true, fastLookup: false });
    found = matchRow(store.licenses);
  }
  return found ? mergeQuotaGrantsIntoLicense(found) : null;
}

export async function findLicensesByEmail(email) {
  const key = healEmailTypos(email) || normalizeEmail(email);
  if (!key) return [];
  // Email unlock fallback — same fast Firebase path as findLicense.
  const store = await readStore({ preferFresh: true, fastLookup: true });
  return store.licenses.filter(
    (row) => (healEmailTypos(row.clientEmail) || normalizeEmail(row.clientEmail)) === key
  );
}

/** Push the merged license store to every durable backend (Firebase/Blob/GitHub). */
export async function mirrorLicensesToDurableStores() {
  const store = await readStore({ preferFresh: true });
  const write = await writeStore(
    store.licenses,
    store.sha,
    "chore: mirror full license store to durable backends",
    store.deletedKeys
  );
  return {
    ok: write?.durable !== false,
    durable: write?.durable !== false,
    source: write?.source || null,
    count: Array.isArray(store.licenses) ? store.licenses.length : 0,
    error: write?.error || null,
  };
}

/** Wipe every license key so all portals start from zero. */
export async function clearAllLicenses() {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const store = await readStore();
      memoryLicenses = [];
      memoryDeletedKeys = {};
      const write = await writeStore(
        [],
        store.sha,
        "chore: reset all license keys",
        {}
      );
      memoryLicenses = [];
      memoryDeletedKeys = {};
      return {
        ok: true,
        cleared: true,
        durable: write?.durable !== false,
        source: write?.source || null,
        count: 0,
      };
    } catch (error) {
      lastError = error;
      if (error.status === 409 || error.status === 422) continue;
      throw error;
    }
  }
  throw lastError || new Error("Could not clear license keys");
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * Persist the client's allowed EA pairs onto their used license rows so mentor
 * Self Hosting can refuse symbols that are not on that EA ("Your pairs").
 * Never overwrites bot.symbols — that list is the mentor EA template.
 */
export async function setLicenseClientSymbols(
  email,
  symbols = [],
  { botId = "", licenseKey = "" } = {}
) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("email is required");
    err.status = 400;
    throw err;
  }
  const cleanSymbols = [
    ...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((s) => String(s || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
  const wantBot = String(botId || "").trim();
  const wantKey = normalizeLicenseKey(licenseKey);
  const now = Date.now();
  let updated = 0;
  await mutateStore((licenses) => {
    for (let i = 0; i < licenses.length; i += 1) {
      const row = licenses[i];
      if (normalizeEmail(row?.clientEmail) !== key) continue;
      if (!row?.used) continue;
      if (wantKey && normalizeLicenseKey(row.key) !== wantKey) continue;
      const rowBot = String(row.botId || row.bot?.id || "").trim();
      if (wantBot && rowBot && rowBot !== wantBot) continue;
      licenses[i] = {
        ...row,
        // Keep mentor bot.symbols untouched — client pairs live only here.
        clientSymbols: cleanSymbols,
        clientSymbolsUpdatedAt: now,
        updatedAt: now,
      };
      updated += 1;
    }
    return licenses;
  }, `chore: client EA symbols ${key} (${cleanSymbols.length})`);
  return { ok: true, email: key, updated, symbols: cleanSymbols };
}

/**
 * Rewrite mentor EA template symbols onto every license for this botId.
 * Used when a mentor saves Create/Edit EA so Browse & add shows the live list.
 */
export async function syncMentorBotSymbols(
  botId,
  symbols = [],
  { mentorEmail = "", name = "", photo = "", strategy = "" } = {}
) {
  const id = String(botId || "").trim();
  if (!id) {
    const err = new Error("botId is required");
    err.status = 400;
    throw err;
  }
  const cleanSymbols = [
    ...new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((s) => String(s || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
  const owner = normalizeEmail(mentorEmail);
  const botName = String(name || "").trim();
  const botPhoto = String(photo || "").trim();
  const botStrategy = String(strategy || "").trim();
  const now = Date.now();
  let updated = 0;
  await mutateStore((licenses) => {
    for (let i = 0; i < licenses.length; i += 1) {
      const row = licenses[i];
      const rowBot = String(row?.botId || row?.bot?.id || "").trim();
      if (rowBot !== id) continue;
      if (owner) {
        const rowOwner = normalizeEmail(row?.mentorEmail || row?.ownerEmail);
        if (rowOwner && rowOwner !== owner) continue;
      }
      const prevBot =
        row.bot && typeof row.bot === "object"
          ? row.bot
          : {
              id,
              name: row.botName || "Bot",
              photo: "/logo.png",
              strategy: "scalper",
              symbols: [],
            };
      licenses[i] = {
        ...row,
        botName: botName || row.botName || prevBot.name || "Bot",
        bot: {
          ...prevBot,
          id,
          name: botName || prevBot.name || row.botName || "Bot",
          ...(botPhoto ? { photo: botPhoto } : {}),
          ...(botStrategy ? { strategy: botStrategy } : {}),
          symbols: cleanSymbols,
        },
        mentorSymbolsSyncedAt: now,
        updatedAt: now,
      };
      updated += 1;
    }
    return licenses;
  }, `chore: mentor EA symbols ${id} (${cleanSymbols.length})`);
  return { ok: true, botId: id, updated, symbols: cleanSymbols };
}

/**
 * Persist a client's live MT5API session onto their license rows so mentor
 * Self Hosting can find them across serverless instances (mt5-accounts /tmp
 * is not shared between /api/mt5-accounts and /api/metaapi/mentor-trade).
 */
export async function setLicenseRobotSession(email, session = {}) {
  const key = normalizeEmail(email);
  const accountId = String(session.accountId || "").trim();
  if (!key || !key.includes("@") || !accountId) {
    const err = new Error("email and accountId are required");
    err.status = 400;
    throw err;
  }
  const now = Date.now();
  let updated = 0;
  await mutateStore((licenses) => {
    for (let i = 0; i < licenses.length; i += 1) {
      if (normalizeEmail(licenses[i]?.clientEmail) !== key) continue;
      // Only stamp used keys — unused inventory must not flip to "Connected".
      if (!licenses[i]?.used) continue;
      licenses[i] = {
        ...licenses[i],
        robotAccountId: accountId,
        robotLogin: String(session.login || "").trim(),
        robotServer: String(session.server || "").trim(),
        robotCompany: String(session.company || "").trim(),
        robotPlatform:
          String(session.platform || "MT5").trim().toUpperCase() === "MT4"
            ? "MT4"
            : "MT5",
        robotConnectedAt: Number(session.connectedAt) || now,
        updatedAt: now,
      };
      updated += 1;
    }
    return licenses;
  }, `chore: robot session ${key}`);
  return { ok: true, email: key, updated };
}

export async function clearLicenseRobotSession(email) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("email is required");
    err.status = 400;
    throw err;
  }
  const now = Date.now();
  let updated = 0;
  await mutateStore((licenses) => {
    for (let i = 0; i < licenses.length; i += 1) {
      if (normalizeEmail(licenses[i]?.clientEmail) !== key) continue;
      if (!licenses[i]?.robotAccountId) continue;
      licenses[i] = {
        ...licenses[i],
        robotAccountId: "",
        robotLogin: "",
        robotServer: "",
        robotCompany: "",
        robotPlatform: "",
        robotConnectedAt: null,
        updatedAt: now,
      };
      updated += 1;
    }
    return licenses;
  }, `chore: clear robot session ${key}`);
  return { ok: true, email: key, updated };
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}
