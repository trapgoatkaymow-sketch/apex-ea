import { applyCorsHeaders } from "../_cors.js";
import {
  findSignup,
  setSignupAppAccessUnlocked,
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
const API = `https://api.github.com/repos/${REPO}`;

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
        updated = prev;
        return licenses;
      }
      updated = {
        ...prev,
        emailSentAt: Number(at) || Date.now(),
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

/** Clear emailSentAt so a failed send can retry. */
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
      if (!prev.emailSentAt) return licenses;
      licenses[idx] = {
        ...prev,
        emailSentAt: null,
        updatedAt: Date.now(),
      };
      return licenses;
    }, `license email retry: ${key}`);
  } catch {
    // ignore
  }
}

/**
 * Claim the right to send this key's email (optimistic emailSentAt stamp).
 * Returns true only for the caller that won the claim — stops duplicate Brevo sends.
 */
async function claimLicenseEmailSend(rawKey) {
  const key = normalizeLicenseKey(rawKey);
  if (!key) return false;
  let claimed = false;
  try {
    await mutateStore((licenses) => {
      const idx = licenses.findIndex(
        (row) => normalizeLicenseKey(row.key) === key
      );
      if (idx < 0) return licenses;
      const prev = licenses[idx];
      if (prev.emailSentAt) {
        claimed = false;
        return licenses;
      }
      claimed = true;
      licenses[idx] = {
        ...prev,
        emailSentAt: Date.now(),
        updatedAt: Date.now(),
      };
      return licenses;
    }, `license email claim: ${key}`);
  } catch {
    claimed = false;
  }
  return claimed;
}

async function sendLicenseKeyEmailOnce(license, { force = false } = {}) {
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
    return { ok: true, skipped: true, reason: "already-sent" };
  }
  licenseEmailInflight.add(key);
  try {
    if (!force) {
      const claimed = await claimLicenseEmailSend(key);
      if (!claimed) {
        return { ok: true, skipped: true, reason: "already-sent" };
      }
    }
    const { sendLicenseKeyEmail } = await import("../_brevo.js");
    const email = await sendLicenseKeyEmail(license);
    if (email?.ok) {
      return { ...email, emailSentAt: Date.now() };
    }
    // Allow a later retry if Brevo failed / not configured.
    if (!force) {
      await clearLicenseEmailSent(key);
    }
    return email;
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
  return (Array.isArray(licenses) ? licenses : []).filter(
    (row) => row?.key && !tomb[row.key]
  );
}

function isKeyDeleted(rawKey, deletedKeys = memoryDeletedKeys) {
  const tomb = normalizeDeletedKeys(deletedKeys);
  return licenseKeyVariants(rawKey).some((k) => Boolean(tomb[k]));
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
export async function resolveEmbeddablePhoto(botId, photo) {
  const value = String(photo || "").trim();
  if (!value) return "/logo.png";
  if (value === "/logo.png") return value;
  if (/^https?:\/\//i.test(value)) return value;

  if (value.startsWith("data:image/")) {
    return persistBotPhoto(botId, value);
  }

  if (value.startsWith("/api/licenses/photo")) {
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
  const resetAt = Number(raw.resetAt) || 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !resetAt) return null;
  return {
    day,
    resetAt,
    grantedBy: normalizeEmail(raw.grantedBy || ""),
  };
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
    // Live MetaTrader session for mentor Self Hosting fan-out (MT5API token).
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
          ? {
              ...(prev.bot || {}),
              ...(item.bot || {}),
              photo: nextPhoto || prev.bot?.photo || item.bot?.photo || "/logo.png",
            }
          : null,
    });
  });
  return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function readLocalStore() {
  if (Array.isArray(memoryLicenses)) {
    const deletedKeys = normalizeDeletedKeys(memoryDeletedKeys);
    return {
      sha: "local",
      licenses: withoutDeletedLicenses(
        memoryLicenses.map((row) => ({ ...row })),
        deletedKeys
      ),
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

  const deletedKeys = mergeDeletedKeyMaps(...deletedChunks);
  memoryDeletedKeys = deletedKeys;
  memoryLicenses = withoutDeletedLicenses(
    mergeLicenseLists(...licenseChunks),
    deletedKeys
  );
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
  const nextDeleted = normalizeDeletedKeys(deletedKeys);
  const next = withoutDeletedLicenses(mergeLicenseLists(licenses), nextDeleted).map(
    (row) => ({ ...row })
  );
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
  if (
    !preferFresh &&
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
    githubPath: FILE_PATH,
    githubRepo: REPO,
    githubBranch: BRANCH,
    snapshotEnv: "LICENSES_SNAPSHOT_B64",
    localPaths: [TMP_FILE, BUNDLED_FILE],
    preferFresh,
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
  // Tombstones win: deleted keys stay deleted across every source.
  const deletedKeys = mergeDeletedKeyMaps(
    remote?.deletedKeys,
    localFiles.deletedKeys,
    memoryDeletedKeys
  );
  const merged = withoutDeletedLicenses(
    mergeLicenseLists(
      remote?.licenses || [],
      localFiles.licenses,
      Array.isArray(memoryLicenses) ? memoryLicenses : []
    ),
    deletedKeys
  );
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
  const nextDeleted = normalizeDeletedKeys(deletedKeys);
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
  const normalized = withoutDeletedLicenses(mergeLicenseLists(compact), nextDeleted);
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
    githubPath: FILE_PATH,
    githubRepo: REPO,
    githubBranch: BRANCH,
    githubSha: sha && sha !== "local" ? sha : null,
    message,
    localPaths: [TMP_FILE, BUNDLED_FILE],
  });

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
          for (const key of licenseKeyVariants(rawKey)) {
            deletedKeys[key] = Date.now();
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
            for (const key of licenseKeyVariants(rawKey)) {
              deletedKeys[key] = Date.now();
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

  // Fill missing mentorName from the mentor portal username so client headers
  // show the mentor name even for older licenses.
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
  const photo = await resolveEmbeddablePhoto(botId, rawPhoto);

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

  let result = null;
  let createdNew = false;
  const write = await mutateStore((licenses, api) => {
    if (api?.isDeleted?.(key)) {
      const err = new Error("This license key was permanently deleted");
      err.status = 410;
      throw err;
    }
    const existing = licenses.find((row) => row.key === key);
    if (!existing && ownerEmailForQuota && keyAllowance != null) {
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
    } else if (createdNew || keyAgeMs < 3 * 60 * 1000) {
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
export async function markLicenseUsed(rawKey, { deviceId = "", email = "" } = {}) {
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

  // Peek current license + signup before mutate so commission rules use paid/first-access.
  const currentList = await listLicenses({ preferFresh: true });
  const current =
    currentList.find((row) => variants.includes(row.key)) || null;
  if (!current) {
    const err = new Error("Invalid license key");
    err.status = 404;
    throw err;
  }

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
    await mutateStore((licenses) => {
      const idx = licenses.findIndex((row) => variants.includes(row.key));
      if (idx < 0) return licenses;
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
      await mutateStore((licenses) => {
        const idx = licenses.findIndex((row) => variants.includes(row.key));
        if (idx < 0) return licenses;
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
  const clientEmail = normalizeEmail(current.clientEmail) || claimEmail;
  const signup = clientEmail ? await findSignup(clientEmail) : null;
  const accessPaid = Boolean(signup?.accessPaid) && !signup?.accessBypassed;
  const alreadyUnlocked = Boolean(signup?.appAccessUnlockedAt);
  const priorUsed = currentList.some(
    (row) =>
      normalizeEmail(row.clientEmail) === clientEmail &&
      row.used &&
      !variants.includes(row.key)
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
  await mutateStore((licenses) => {
    const idx = licenses.findIndex((row) => variants.includes(row.key));
    if (idx < 0) {
      const err = new Error("Invalid license key");
      err.status = 404;
      throw err;
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
      // Stamp activating account so mentors still see who used the key.
      clientEmail: row.clientEmail || claimEmail || "",
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

/** Super admin grants a fresh daily scan quota for this license/client. */
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
    (admin === superAdmin || admin === "trapgoatkaymow@gmail.com");
  if (!allowedAdmin) {
    const err = new Error("Only super admin can reset client daily scans");
    err.status = 403;
    throw err;
  }

  // Stamp the day in Africa/Johannesburg (UTC+2, no DST) so it matches
  // client localStorage quota days for the primary SA audience.
  const now = new Date();
  const saMs = now.getTime() + 2 * 60 * 60 * 1000;
  const sa = new Date(saMs);
  const day = `${sa.getUTCFullYear()}-${String(sa.getUTCMonth() + 1).padStart(2, "0")}-${String(
    sa.getUTCDate()
  ).padStart(2, "0")}`;
  const scanReset = {
    day,
    resetAt: Date.now(),
    grantedBy: admin,
  };

  let result = null;
  const write = await mutateStore((licenses) => {
    const idx = licenses.findIndex(rowMatches);
    if (idx < 0) {
      const err = new Error("Invalid license key");
      err.status = 404;
      throw err;
    }
    licenses[idx] = {
      ...licenses[idx],
      scanReset,
      updatedAt: Date.now(),
    };
    result = licenses[idx];
    return licenses;
  }, `scan reset granted: ${formattedKey}`);

  if (write?.durable === false) {
    const err = new Error(
      String(write?.error || "").trim()
        ? `Could not reset scans (${write.error})`
        : "Could not reset scans — try again"
    );
    err.status = 503;
    throw err;
  }

  return result;
}

export async function deleteLicense(rawKey) {
  const variants = licenseKeyVariants(rawKey);
  if (!variants.length) {
    const err = new Error("License key is required");
    err.status = 400;
    throw err;
  }

  let result = null;
  const write = await mutateStore((licenses, api) => {
    const idx = licenses.findIndex((row) => variants.includes(row.key));
    // Always stamp a tombstone so bundled /tmp / migrate cannot resurrect the key.
    api.tombstone(variants[0]);
    if (idx < 0) {
      result = { key: variants[0], deleted: true, alreadyGone: true };
      return licenses;
    }
    result = licenses[idx];
    api.tombstone(result.key);
    return licenses.filter((_, i) => i !== idx);
  }, `license deleted: ${variants[0]}`);

  return {
    ...(result || { key: variants[0], deleted: true }),
    deleted: true,
    durable: write?.durable !== false,
  };
}

export async function findLicense(rawKey) {
  const variants = new Set(licenseKeyVariants(rawKey));
  if (!variants.size) return null;
  const compactOf = (value) => normalizeLicenseKey(value).replace(/-/g, "");
  const wantCompact = compactOf(rawKey);
  // Unlock/generate must not use a stale memory TTL that predates a key written
  // on another serverless instance.
  const store = await readStore({ preferFresh: true });
  const licenses = store.licenses;
  return (
    licenses.find((row) => {
      const key = normalizeLicenseKey(row.key);
      if (!key) return false;
      return variants.has(key) || compactOf(key) === wantCompact;
    }) || null
  );
}

export async function findLicensesByEmail(email) {
  const key = normalizeEmail(email);
  if (!key) return [];
  const store = await readStore({ preferFresh: true });
  return store.licenses.filter((row) => normalizeEmail(row.clientEmail) === key);
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
