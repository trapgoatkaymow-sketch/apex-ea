import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FALLBACK_GITHUB_TOKEN } from "../signups/_githubToken.js";
import { applyCorsHeaders } from "../_cors.js";
import { durableRead, durableWrite } from "../_durableJson.js";

const REPO =
  process.env.SIGNUPS_GITHUB_REPO || "trapgoatkaymow-sketch/apex-ea";
const BRANCH = process.env.SIGNUPS_GITHUB_BRANCH || "main";
const FILE_PATH = process.env.MENTORS_FILE_PATH || "data/mentors.json";
const BLOB_PATH = process.env.MENTORS_BLOB_PATH || "apexea/mentors.json";
const API = `https://api.github.com/repos/${REPO}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_FILE = path.resolve(__dirname, "../../data/mentors.json");
const TMP_FILE = path.join("/tmp", "apexea-mentors.json");

export const WITHDRAW_MAX_PER_WEEK = 2;
export const WITHDRAW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const SUPER_ADMIN_EMAIL = String(
  process.env.SUPER_ADMIN_EMAIL || "trapgoatkaymow22@icloud.com"
)
  .trim()
  .toLowerCase();
export const SUPER_ADMIN_PASSWORD =
  process.env.SUPER_ADMIN_PASSWORD || "Admin12";
export const SUPER_ADMIN_USERNAME = "APEX EA";
/** Default license-key allotment every mentor starts with. */
export const DEFAULT_MENTOR_LICENSE_KEYS = 1500;

function pruneWithdrawalRequests(list, now = Date.now()) {
  const floor = now - WITHDRAW_WINDOW_MS;
  return (Array.isArray(list) ? list : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= floor)
    .sort((a, b) => a - b);
}

function withdrawalQuotaFromList(email, list, now = Date.now()) {
  const recent = pruneWithdrawalRequests(list, now);
  const used = recent.length;
  const remaining = Math.max(0, WITHDRAW_MAX_PER_WEEK - used);
  const oldest = recent[0] || null;
  return {
    email: normalizeEmail(email),
    used,
    remaining,
    max: WITHDRAW_MAX_PER_WEEK,
    windowDays: 7,
    resetsAt: oldest ? oldest + WITHDRAW_WINDOW_MS : null,
    allowed: remaining > 0,
  };
}

/**
 * Known durable portal passwords. Used only to repair wiped hashes so mentors
 * can always sign in even if a store sync dropped passwordHash/salt.
 * Mentors can still change passwords later via super-admin Set password.
 */
export const DURABLE_MENTOR_PASSWORDS = Object.freeze({
  "trapgoatkaymow@gmail.com": "TempPass12",
});

/** Mentor who may use Mentor Management (approve/decline) like super admin. */
export const MENTOR_OPERATOR_EMAIL = "trapgoatkaymow@gmail.com";

let memoryMentors = null;

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export function isMentorOperator(email) {
  return normalizeEmail(email) === normalizeEmail(MENTOR_OPERATOR_EMAIL);
}

/** Find a mentor by email with normalized comparison (handles legacy unnormalized rows). */
function findMentorIndex(list, email) {
  const key = normalizeEmail(email);
  if (!key) return -1;
  return (Array.isArray(list) ? list : []).findIndex(
    (m) => normalizeEmail(m?.email) === key
  );
}

function findMentor(list, email) {
  const idx = findMentorIndex(list, email);
  return idx < 0 ? null : list[idx];
}

export function normalizeLicenseKeysAllowed(value, { role } = {}) {
  if (String(role || "").toLowerCase() === "superadmin") {
    return null;
  }
  if (value == null || value === "") return DEFAULT_MENTOR_LICENSE_KEYS;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MENTOR_LICENSE_KEYS;
  return n;
}

function normalizePhone(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
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
    const err = new Error("Mentor store is not configured");
    err.status = 500;
    throw err;
  }
  return token;
}

function tokenCandidates() {
  return [
    ...new Set(
      [
        process.env.SIGNUPS_GITHUB_TOKEN,
        process.env.GITHUB_TOKEN,
        process.env.GH_TOKEN,
        FALLBACK_GITHUB_TOKEN,
      ].filter(Boolean)
    ),
  ];
}

async function ghFetch(url, { method = "GET", body, token, auth = true, cache } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (body) headers["Content-Type"] = "application/json";

  const tokens = auth
    ? token
      ? [token]
      : tokenCandidates()
    : [null];
  if (auth && tokens.length === 0) {
    const err = new Error("Mentor store is not configured");
    err.status = 500;
    throw err;
  }

  let lastError = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const active = tokens[i];
    const requestHeaders = { ...headers };
    if (auth && active) requestHeaders.Authorization = `Bearer ${active}`;

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
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
    if (response.ok) return data;

    const message =
      (data && (data.message || data.error)) || `GitHub error ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    lastError = err;

    // Expired Vercel env tokens often return Bad credentials — try the next candidate.
    const retryable =
      auth &&
      i < tokens.length - 1 &&
      (response.status === 401 ||
        response.status === 403 ||
        /bad credentials/i.test(message));
    if (!retryable) throw err;
  }
  throw lastError || new Error("GitHub request failed");
}

export function createSalt() {
  return crypto.randomBytes(16).toString("hex");
}

export function hashPassword(password, salt) {
  return crypto
    .createHash("sha256")
    .update(`${salt}:${String(password || "")}`)
    .digest("hex");
}

/** Stable short code mentors share so clients can self-claim a license key. */
export function mentorInviteCode(mentor) {
  const id = String(mentor?.id || "")
    .replace(/-/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (id.length >= 8) return id.slice(0, 8);
  const email = normalizeEmail(mentor?.email);
  if (!email) return "";
  return crypto.createHash("sha1").update(email).digest("hex").slice(0, 8).toUpperCase();
}

export function publicMentor(mentor) {
  if (!mentor) return null;
  const banking = normalizeBanking(mentor.banking);
  const role = mentor.role || "mentor";
  const appColor = normalizeAppColor(mentor.appColor);
  const appColorUpdatedAt = Number(mentor.appColorUpdatedAt) || null;
  return {
    id: mentor.id,
    username: mentor.username,
    email: mentor.email,
    contact: mentor.contact || "",
    role,
    status: mentor.status || "pending",
    createdAt: mentor.createdAt || Date.now(),
    banking,
    licenseKeysAllowed: normalizeLicenseKeysAllowed(mentor.licenseKeysAllowed, {
      role,
    }),
    licenseKeysUpdatedAt: Number(mentor.licenseKeysUpdatedAt) || null,
    inviteCode: mentorInviteCode(mentor),
    appColor,
    // Clients need the stamp so newer portal colors win over stale local cache.
    appColorUpdatedAt: appColor ? appColorUpdatedAt || Date.now() : appColorUpdatedAt,
  };
}

function normalizeAppColor(raw) {
  let value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  if (!value.startsWith("#")) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/.test(value)) return "";
  return value;
}

export async function findMentorByInviteCode(rawCode) {
  const needle = String(rawCode || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!needle) return null;
  const mentors = await listMentors();
  const match = mentors.find((m) => mentorInviteCode(m) === needle);
  if (!match) return null;
  const status = String(match.status || "").toLowerCase();
  const role = String(match.role || "").toLowerCase();
  if (role !== "superadmin" && status !== "approved") {
    const err = new Error("This mentor is not accepting clients yet");
    err.status = 403;
    throw err;
  }
  return match;
}

function normalizeBanking(raw = {}) {
  if (!raw || typeof raw !== "object") {
    return {
      accountName: "",
      bankName: "",
      accountNumber: "",
      branchCode: "",
      accountType: "",
      updatedAt: null,
    };
  }
  return {
    accountName: String(raw.accountName || "").trim(),
    bankName: String(raw.bankName || "").trim(),
    accountNumber: String(raw.accountNumber || "").trim(),
    branchCode: String(raw.branchCode || "").trim(),
    accountType: String(raw.accountType || "").trim(),
    updatedAt: raw.updatedAt ? Number(raw.updatedAt) : null,
  };
}

function decodeMentorsJson(raw, sha = null) {
  try {
    const parsed = JSON.parse(raw || "{}");
    const mentors = Array.isArray(parsed?.mentors) ? parsed.mentors : [];
    return {
      sha,
      mentors: mentors
        .map((m) => {
          const role =
            String(m.role || "mentor").toLowerCase() === "superadmin"
              ? "superadmin"
              : "mentor";
          const appColor = normalizeAppColor(m.appColor);
          return {
            id: String(m.id || normalizeEmail(m.email) || crypto.randomUUID()),
            username: String(m.username || "").trim() || "Mentor",
            email: normalizeEmail(m.email),
            contact: normalizePhone(m.contact),
            role,
            status: String(m.status || "pending").toLowerCase(),
            statusUpdatedAt: Number(m.statusUpdatedAt) || null,
            passwordHash: String(m.passwordHash || ""),
            salt: String(m.salt || ""),
            passwordUpdatedAt: Number(m.passwordUpdatedAt) || null,
            createdAt: Number(m.createdAt) || Date.now(),
            banking: normalizeBanking(m.banking),
            licenseKeysAllowed: normalizeLicenseKeysAllowed(m.licenseKeysAllowed, {
              role,
            }),
            licenseKeysUpdatedAt: Number(m.licenseKeysUpdatedAt) || null,
            appColor,
            appColorUpdatedAt: appColor
              ? Number(m.appColorUpdatedAt) || Date.now()
              : Number(m.appColorUpdatedAt) || null,
            withdrawalRequests: pruneWithdrawalRequests(m.withdrawalRequests),
            withdrawalRequestedAt: Number(m.withdrawalRequestedAt) || null,
            passwordResetTokenHash: String(m.passwordResetTokenHash || ""),
            passwordResetExpiresAt: Number(m.passwordResetExpiresAt) || null,
            passwordResetRequestedAt: Number(m.passwordResetRequestedAt) || null,
            activityGraceStartedAt: Number(m.activityGraceStartedAt) || null,
            deactivatedAt: Number(m.deactivatedAt) || null,
            deactivatedReason: String(m.deactivatedReason || ""),
          };
        })
        .filter((m) => m.email && m.email.includes("@")),
    };
  } catch {
    return { sha, mentors: [] };
  }
}

function decodeContent(file) {
  const raw = Buffer.from(String(file.content || "").replace(/\n/g, ""), "base64").toString(
    "utf8"
  );
  return decodeMentorsJson(raw, file.sha);
}

function readLocalStore() {
  if (Array.isArray(memoryMentors)) {
    return { sha: "local", mentors: memoryMentors.map((m) => ({ ...m })) };
  }
  try {
    if (fs.existsSync(LOCAL_FILE)) {
      const raw = fs.readFileSync(LOCAL_FILE, "utf8");
      const decoded = decodeMentorsJson(raw, "local");
      memoryMentors = decoded.mentors;
      return { sha: "local", mentors: decoded.mentors.map((m) => ({ ...m })) };
    }
  } catch {
    // ignore and use memory
  }
  memoryMentors = [];
  return { sha: "local", mentors: [] };
}

/** Overlay passwordHash/salt from backup rows so credentials never get wiped. */
function mergeCredentialRows(mentors, backups = []) {
  const byEmail = new Map();
  for (const row of backups) {
    const email = normalizeEmail(row?.email);
    if (!email || !row?.passwordHash || !row?.salt) continue;
    byEmail.set(email, row);
  }
  return (Array.isArray(mentors) ? mentors : []).map((m) => {
    const email = normalizeEmail(m?.email);
    if (!email) return m;
    if (m.passwordHash && m.salt) return m;
    const backup = byEmail.get(email);
    if (!backup) return m;
    return {
      ...m,
      passwordHash: backup.passwordHash,
      salt: backup.salt,
    };
  });
}

function credentialBackupPool(extra = []) {
  const local = readLocalStoreFileOnly();
  return [
    ...(Array.isArray(memoryMentors) ? memoryMentors : []),
    ...local,
    ...(Array.isArray(extra) ? extra : []),
  ];
}

/** Read bundled/local mentors.json without touching in-memory cache. */
function readLocalStoreFileOnly() {
  try {
    if (!fs.existsSync(LOCAL_FILE)) return [];
    const raw = fs.readFileSync(LOCAL_FILE, "utf8");
    return decodeMentorsJson(raw, "local-file").mentors;
  } catch {
    return [];
  }
}

function writeLocalStore(mentors) {
  const merged = mergeCredentialRows(mentors, credentialBackupPool(mentors));
  const next = merged.map((m) => ({ ...m }));
  memoryMentors = next;
  try {
    fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
    fs.writeFileSync(
      LOCAL_FILE,
      JSON.stringify(
        {
          mentors: next
            .map((m) => {
              const role = m.role || "mentor";
              return {
                id: m.id,
                username: m.username,
                email: normalizeEmail(m.email),
                contact: normalizePhone(m.contact),
                role,
                status: m.status || "pending",
                statusUpdatedAt: Number(m.statusUpdatedAt) || null,
                passwordHash: m.passwordHash,
                salt: m.salt,
                passwordUpdatedAt: Number(m.passwordUpdatedAt) || null,
                createdAt: Number(m.createdAt) || Date.now(),
                banking: normalizeBanking(m.banking),
                licenseKeysAllowed: normalizeLicenseKeysAllowed(
                  m.licenseKeysAllowed,
                  { role }
                ),
                licenseKeysUpdatedAt: Number(m.licenseKeysUpdatedAt) || null,
                appColor: normalizeAppColor(m.appColor) || "",
                appColorUpdatedAt: Number(m.appColorUpdatedAt) || null,
                withdrawalRequests: pruneWithdrawalRequests(m.withdrawalRequests),
                withdrawalRequestedAt: Number(m.withdrawalRequestedAt) || null,
                passwordResetTokenHash: String(m.passwordResetTokenHash || ""),
                passwordResetExpiresAt: Number(m.passwordResetExpiresAt) || null,
                passwordResetRequestedAt: Number(m.passwordResetRequestedAt) || null,
                activityGraceStartedAt: Number(m.activityGraceStartedAt) || null,
                deactivatedAt: Number(m.deactivatedAt) || null,
                deactivatedReason: String(m.deactivatedReason || ""),
              };
            })
            .filter((m) => m.email && m.email.includes("@") && m.passwordHash && m.salt),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  } catch {
    // memory still holds the data for this process
  }
  return next;
}

async function readStore() {
  try {
    const durable = await durableRead({
      blobPath: BLOB_PATH,
      githubRepo: REPO,
      githubBranch: BRANCH,
      githubPath: FILE_PATH,
      localPaths: [TMP_FILE, LOCAL_FILE],
    });
    let decoded = { sha: durable.sha || null, mentors: [] };
    if (durable.raw) {
      try {
        decoded = decodeMentorsJson(durable.raw, durable.sha);
      } catch {
        decoded = { sha: durable.sha || null, mentors: [] };
      }
    }
    // Overlay locally-saved banking / key allotments when remote still has
    // older values (write may have failed auth on a prior request).
    if (Array.isArray(memoryMentors) && memoryMentors.length) {
      const localByEmail = new Map(
        memoryMentors.map((m) => [normalizeEmail(m.email), m])
      );
      decoded.mentors = decoded.mentors.map((m) => {
        const local = localByEmail.get(normalizeEmail(m.email));
        if (!local) return m;
        const remoteBank = normalizeBanking(m.banking);
        const localBank = normalizeBanking(local?.banking);
        let next = m;
        if (!remoteBank.accountNumber && localBank.accountNumber) {
          next = { ...next, banking: localBank };
        }
        const localKeys = normalizeLicenseKeysAllowed(local.licenseKeysAllowed, {
          role: local.role || m.role,
        });
        const remoteKeys = normalizeLicenseKeysAllowed(m.licenseKeysAllowed, {
          role: m.role,
        });
        const localUpdated = Number(local.licenseKeysUpdatedAt) || 0;
        const remoteUpdated = Number(m.licenseKeysUpdatedAt) || 0;
        let chosenKeys = remoteKeys;
        let chosenAt = remoteUpdated;
        if (localKeys != null && remoteKeys == null) {
          chosenKeys = localKeys;
          chosenAt = localUpdated || Date.now();
        } else if (localKeys != null && remoteKeys != null) {
          if (localUpdated > remoteUpdated) {
            chosenKeys = localKeys;
            chosenAt = localUpdated;
          } else if (remoteUpdated > localUpdated) {
            chosenKeys = remoteKeys;
            chosenAt = remoteUpdated;
          } else {
            // Equal stamps — keep the higher allotment so a warm instance
            // cannot shrink keys another instance just raised.
            chosenKeys = Math.max(localKeys, remoteKeys);
            chosenAt = Math.max(localUpdated, remoteUpdated) || Date.now();
          }
        }
        if (chosenKeys != null && chosenKeys !== remoteKeys) {
          next = {
            ...next,
            licenseKeysAllowed: chosenKeys,
            licenseKeysUpdatedAt: chosenAt || Date.now(),
          };
        } else if (
          chosenKeys != null &&
          Number(m.licenseKeysAllowed) !== chosenKeys
        ) {
          next = {
            ...next,
            licenseKeysAllowed: chosenKeys,
            licenseKeysUpdatedAt: chosenAt || Date.now(),
          };
        }
        // Credentials: fill blanks from memory, or keep newer in-memory hash
        // when a stale remote bootstrap/hash would otherwise win.
        const localPwAt = Number(local.passwordUpdatedAt) || 0;
        const remotePwAt = Number(m.passwordUpdatedAt) || 0;
        if (!next.passwordHash && local.passwordHash && local.salt) {
          next = {
            ...next,
            passwordHash: local.passwordHash,
            salt: local.salt,
            passwordUpdatedAt: localPwAt || null,
          };
        } else if (
          local.passwordHash &&
          local.salt &&
          next.passwordHash &&
          next.salt &&
          (local.passwordHash !== next.passwordHash || local.salt !== next.salt) &&
          localPwAt > remotePwAt
        ) {
          next = {
            ...next,
            passwordHash: local.passwordHash,
            salt: local.salt,
            passwordUpdatedAt: localPwAt,
          };
        }
        // Keep newer in-memory withdrawal request stamps across instances
        // until durable stores catch up.
        const localWithdrawAt = Number(local.withdrawalRequestedAt) || 0;
        const remoteWithdrawAt = Number(m.withdrawalRequestedAt) || 0;
        if (
          Array.isArray(local.withdrawalRequests) &&
          local.withdrawalRequests.length &&
          localWithdrawAt >= remoteWithdrawAt
        ) {
          const floor = Date.now() - WITHDRAW_WINDOW_MS;
          const merged = [
            ...(Array.isArray(m.withdrawalRequests) ? m.withdrawalRequests : []),
            ...local.withdrawalRequests,
          ]
            .map((t) => Number(t))
            .filter((t) => Number.isFinite(t) && t >= floor);
          next = {
            ...next,
            withdrawalRequests: Array.from(new Set(merged)).sort((a, b) => a - b),
            withdrawalRequestedAt: Math.max(localWithdrawAt, remoteWithdrawAt) || null,
          };
        }
        // Keep a newer local app color when durable remote hasn't caught up yet.
        const localColor = normalizeAppColor(local.appColor);
        const remoteColor = normalizeAppColor(m.appColor);
        const localColorAt = Number(local.appColorUpdatedAt) || 0;
        const remoteColorAt = Number(m.appColorUpdatedAt) || 0;
        if (
          localColor &&
          (!remoteColor || localColorAt > remoteColorAt)
        ) {
          next = {
            ...next,
            appColor: localColor,
            appColorUpdatedAt: localColorAt || Date.now(),
          };
        }
        return next;
      });
      // Keep local-only mentors (with credentials) that remote briefly omitted.
      for (const local of memoryMentors) {
        const email = normalizeEmail(local.email);
        if (!email || !local.passwordHash || !local.salt) continue;
        if (decoded.mentors.some((m) => normalizeEmail(m.email) === email)) {
          continue;
        }
        decoded.mentors.push({ ...local, email });
      }
    }
    memoryMentors = decoded.mentors.map((m) => ({ ...m }));
    // Always overlay bundled credentials so wiped remote hashes get repaired.
    decoded.mentors = mergeCredentialRows(
      decoded.mentors,
      credentialBackupPool(decoded.mentors)
    );
    memoryMentors = decoded.mentors.map((m) => ({ ...m }));
    return {
      ...decoded,
      remote: durable.source !== "empty" && durable.source !== "local",
      source: durable.source,
    };
  } catch (error) {
    if (error.status === 404) {
      return { sha: null, mentors: [], remote: true };
    }
    const local = readLocalStore();
    return { ...local, remote: false };
  }
}

async function writeStore(mentors, sha, message) {
  // Preserve credentials from memory + bundled file before filtering blanks.
  const withCreds = mergeCredentialRows(mentors, credentialBackupPool(mentors));
  // Keep any credentialed mentors that a partial mutator accidentally dropped.
  const nextByEmail = new Map(
    withCreds.map((m) => [normalizeEmail(m.email), m])
  );
  // Never shrink the in-memory roster — cold/partial mutators must not drop
  // pending signups that already registered on this instance.
  if (Array.isArray(memoryMentors)) {
    for (const prev of memoryMentors) {
      const email = normalizeEmail(prev?.email);
      if (!email || !prev.passwordHash || !prev.salt) continue;
      if (!nextByEmail.has(email)) {
        nextByEmail.set(email, { ...prev, email });
      }
    }
  }
  for (const prev of credentialBackupPool()) {
    const email = normalizeEmail(prev?.email);
    if (!email || !prev.passwordHash || !prev.salt) continue;
    const existing = nextByEmail.get(email);
    if (!existing) {
      nextByEmail.set(email, { ...prev, email });
      continue;
    }
    if (!existing.passwordHash || !existing.salt) {
      nextByEmail.set(email, {
        ...existing,
        passwordHash: prev.passwordHash,
        salt: prev.salt,
      });
    }
  }
  const durableRows = Array.from(nextByEmail.values());
  memoryMentors = durableRows.map((m) => ({ ...m }));

  const payload = {
    mentors: durableRows
      .map((m) => {
        const role = m.role || "mentor";
        const appColor = normalizeAppColor(m.appColor);
        return {
          id: m.id,
          username: m.username,
          email: normalizeEmail(m.email),
          contact: normalizePhone(m.contact),
          role,
          status: m.status || "pending",
          statusUpdatedAt: Number(m.statusUpdatedAt) || null,
          passwordHash: m.passwordHash,
          salt: m.salt,
          passwordUpdatedAt: Number(m.passwordUpdatedAt) || null,
          createdAt: Number(m.createdAt) || Date.now(),
          banking: normalizeBanking(m.banking),
          licenseKeysAllowed: normalizeLicenseKeysAllowed(
            m.licenseKeysAllowed,
            { role }
          ),
          licenseKeysUpdatedAt: Number(m.licenseKeysUpdatedAt) || null,
          appColor: appColor || "",
          appColorUpdatedAt: appColor
            ? Number(m.appColorUpdatedAt) || Date.now()
            : Number(m.appColorUpdatedAt) || null,
          withdrawalRequests: pruneWithdrawalRequests(m.withdrawalRequests),
          withdrawalRequestedAt: Number(m.withdrawalRequestedAt) || null,
          passwordResetTokenHash: String(m.passwordResetTokenHash || ""),
          passwordResetExpiresAt: Number(m.passwordResetExpiresAt) || null,
          passwordResetRequestedAt: Number(m.passwordResetRequestedAt) || null,
          activityGraceStartedAt: Number(m.activityGraceStartedAt) || null,
          deactivatedAt: Number(m.deactivatedAt) || null,
          deactivatedReason: String(m.deactivatedReason || ""),
        };
      })
      .filter((m) => m.email && m.email.includes("@") && m.passwordHash && m.salt)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
  };
  const raw = JSON.stringify(payload, null, 2) + "\n";
  writeLocalStore(durableRows);

  try {
    const result = await durableWrite({
      raw,
      blobPath: BLOB_PATH,
      githubRepo: REPO,
      githubBranch: BRANCH,
      githubPath: FILE_PATH,
      githubSha: sha && sha !== "local" ? sha : null,
      message,
      localPaths: [TMP_FILE, LOCAL_FILE],
    });
    if (result?.ok) return result;
    const err = new Error(result?.reason || "Mentor store write failed");
    err.status = 503;
    throw err;
  } catch (error) {
    writeLocalStore(durableRows);
    // Auth / rate-limit / backend failures must surface — otherwise callers
    // think key allotments / passwords are durable when only /tmp was updated.
    const err = error?.status
      ? error
      : Object.assign(new Error(error?.message || "Mentor store write failed"), {
          status: 503,
        });
    throw err;
  }
}

async function mutateStore(mutator, message) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const store = await readStore();
      const next = mutator(store.mentors.map((m) => ({ ...m })));
      await writeStore(next, store.sha, message);
      return next;
    } catch (error) {
      lastError = error;
      if (error.status === 409 || error.status === 422) continue;
      throw error;
    }
  }
  throw lastError || new Error("Could not update mentors store");
}

function ensureSuperAdminRecord(mentors) {
  const list = Array.isArray(mentors) ? [...mentors] : [];
  const idx = list.findIndex((m) => m.email === SUPER_ADMIN_EMAIL);
  const salt = idx >= 0 && list[idx].salt ? list[idx].salt : createSalt();
  const passwordHash = hashPassword(SUPER_ADMIN_PASSWORD, salt);
  const record = {
    id: idx >= 0 ? list[idx].id : "super-admin",
    username: SUPER_ADMIN_USERNAME,
    email: SUPER_ADMIN_EMAIL,
    contact: idx >= 0 ? list[idx].contact || "" : "",
    role: "superadmin",
    status: "approved",
    passwordHash,
    salt,
    createdAt: idx >= 0 ? list[idx].createdAt || Date.now() : Date.now(),
    banking: idx >= 0 ? normalizeBanking(list[idx].banking) : normalizeBanking(),
    appColor: idx >= 0 ? normalizeAppColor(list[idx].appColor) : "",
    appColorUpdatedAt:
      idx >= 0 ? Number(list[idx].appColorUpdatedAt) || null : null,
  };
  if (idx >= 0) list[idx] = { ...list[idx], ...record };
  else list.unshift(record);
  return list;
}

export async function listMentors() {
  // Use mutate path when seeding so a concurrent register cannot be overwritten
  // by a stale full-file write.
  let mentors = [];
  try {
    const store = await readStore();
    mentors = ensureSuperAdminRecord(store.mentors);
    const seeded = store.mentors.some((m) => m.email === SUPER_ADMIN_EMAIL);
    const sameHash =
      seeded &&
      store.mentors.find((m) => m.email === SUPER_ADMIN_EMAIL)?.passwordHash ===
        mentors.find((m) => m.email === SUPER_ADMIN_EMAIL)?.passwordHash;
    // Never seed-write when GitHub auth failed — a local-only superadmin row
    // would overwrite the durable mentors file and wipe password hashes.
    if (store.remote !== false && (!seeded || !sameHash)) {
      await mutateStore(
        (current) => ensureSuperAdminRecord(current),
        "chore: seed super admin mentor account"
      );
      const refreshed = await readStore();
      mentors = ensureSuperAdminRecord(refreshed.mentors);
    }
  } catch {
    mentors = ensureSuperAdminRecord(readLocalStore().mentors);
  }
  return mentors
    .map(publicMentor)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function registerMentor({ username, email, contact, password }) {
  const key = normalizeEmail(email);
  const name = String(username || "").trim();
  const phone = normalizePhone(contact);
  const pass = String(password || "");

  if (!name) {
    const err = new Error("Enter a username");
    err.status = 400;
    throw err;
  }
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }
  if (!phone || phone.length < 7) {
    const err = new Error("Enter a valid contact number");
    err.status = 400;
    throw err;
  }
  if (pass.length < 6) {
    const err = new Error("Password must be at least 6 characters");
    err.status = 400;
    throw err;
  }
  if (key === SUPER_ADMIN_EMAIL) {
    const err = new Error("This email is reserved");
    err.status = 400;
    throw err;
  }

  let created = null;
  await mutateStore((mentors) => {
    const list = ensureSuperAdminRecord(mentors);
    if (findMentorIndex(list, key) >= 0) {
      const err = new Error("An account with this email already exists");
      err.status = 409;
      throw err;
    }
    const salt = createSalt();
    created = {
      id: crypto.randomUUID(),
      username: name,
      email: key,
      contact: phone,
      role: "mentor",
      status: "pending",
      passwordHash: hashPassword(pass, salt),
      salt,
      passwordUpdatedAt: Date.now(),
      createdAt: Date.now(),
      licenseKeysAllowed: DEFAULT_MENTOR_LICENSE_KEYS,
    };
    list.unshift(created);
    return list;
  }, `chore: register mentor ${key}`);

  return publicMentor(created);
}

export const ACTIVITY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIVITY_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Last time this mentor earned a qualifying key: used for a NEW paid app access
 * (commissionEligible). Generated-only or reuse keys do not count.
 */
export async function findMentorLastQualifyingAt(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  try {
    const { listLicenses } = await import("../licenses/_lib.js");
    const licenses = await listLicenses();
    let max = 0;
    for (const row of Array.isArray(licenses) ? licenses : []) {
      if (normalizeEmail(row?.mentorEmail) !== key) continue;
      if (!row?.used || !row?.commissionEligible) continue;
      const t = Number(row.usedAt) || Number(row.createdAt) || 0;
      if (t > max) max = t;
    }
    return max || null;
  } catch {
    return null;
  }
}

function activityAnchorMs(mentor, lastQualifyingAt) {
  if (lastQualifyingAt) return Number(lastQualifyingAt);
  return (
    Number(mentor?.statusUpdatedAt) ||
    Number(mentor?.createdAt) ||
    Date.now()
  );
}

/**
 * Evaluate + enforce weekly used-key activity.
 * Mentors must get ≥1 key used for a new app access every 7 days.
 * After the week lapses they get a 2-hour countdown, then auto-deactivate.
 */
export async function getMentorActivityStatus(email, { enforce = true } = {}) {
  const key = normalizeEmail(email);
  const empty = {
    ok: true,
    email: key,
    exempt: true,
    active: true,
    inGrace: false,
    deactivated: false,
    lastQualifyingAt: null,
    weekDeadlineAt: null,
    graceStartedAt: null,
    graceEndsAt: null,
    msUntilWeekDeadline: null,
    msUntilGraceEnds: null,
    message:
      "Generate at least 1 key each week that a new client uses to unlock the app, or your portal will be deactivated.",
  };
  if (!key || key === SUPER_ADMIN_EMAIL) return empty;

  const store = await readStore().catch(() => readLocalStore());
  const mentors = ensureSuperAdminRecord(store.mentors || []);
  let mentor = findMentor(mentors, key);
  if (!mentor) {
    return { ...empty, exempt: false, ok: false, error: "Mentor not found" };
  }
  if (String(mentor.role || "").toLowerCase() === "superadmin") return empty;

  const status = String(mentor.status || "").toLowerCase();
  if (status === "pending" || status === "declined") {
    return {
      ...empty,
      exempt: false,
      active: false,
      deactivated: status === "declined" && Boolean(mentor.deactivatedAt),
      message:
        status === "pending"
          ? "Account pending approval by super admin"
          : mentor.deactivatedReason ||
            "Portal deactivated — ask super admin to reactivate",
    };
  }

  const lastQualifyingAt = await findMentorLastQualifyingAt(key);
  const anchor = activityAnchorMs(mentor, lastQualifyingAt);
  const weekDeadlineAt = anchor + ACTIVITY_WEEK_MS;
  const now = Date.now();

  // Still inside the weekly window — clear any leftover grace.
  if (now < weekDeadlineAt) {
    if (enforce && Number(mentor.activityGraceStartedAt)) {
      try {
        await mutateStore((list) => {
          const next = ensureSuperAdminRecord(list);
          const idx = findMentorIndex(next, key);
          if (idx < 0) return next;
          next[idx] = {
            ...next[idx],
            activityGraceStartedAt: null,
          };
          return next;
        }, `chore: clear mentor activity grace ${key}`);
      } catch {
        // best-effort
      }
    }
    return {
      ok: true,
      email: key,
      exempt: false,
      active: true,
      inGrace: false,
      deactivated: false,
      lastQualifyingAt: lastQualifyingAt || null,
      weekDeadlineAt,
      graceStartedAt: null,
      graceEndsAt: null,
      msUntilWeekDeadline: Math.max(0, weekDeadlineAt - now),
      msUntilGraceEnds: null,
      message:
        "Generate at least 1 key each week that a new client uses to unlock the app, or your portal will be deactivated.",
    };
  }

  // Week missed — start or continue the 2-hour grace countdown.
  let graceStartedAt = Number(mentor.activityGraceStartedAt) || 0;
  if (enforce && !graceStartedAt) {
    graceStartedAt = weekDeadlineAt;
    try {
      await mutateStore((list) => {
        const next = ensureSuperAdminRecord(list);
        const idx = findMentorIndex(next, key);
        if (idx < 0) return next;
        if (Number(next[idx].activityGraceStartedAt)) return next;
        next[idx] = {
          ...next[idx],
          activityGraceStartedAt: graceStartedAt,
        };
        return next;
      }, `chore: start mentor activity grace ${key}`);
    } catch {
      // keep computed graceStartedAt even if write fails
    }
  }
  if (!graceStartedAt) graceStartedAt = weekDeadlineAt;
  const graceEndsAt = graceStartedAt + ACTIVITY_GRACE_MS;

  if (now >= graceEndsAt) {
    if (enforce && status === "approved") {
      try {
        await mutateStore((list) => {
          const next = ensureSuperAdminRecord(list);
          const idx = findMentorIndex(next, key);
          if (idx < 0) return next;
          if (String(next[idx].status || "").toLowerCase() !== "approved") {
            return next;
          }
          next[idx] = {
            ...next[idx],
            status: "declined",
            statusUpdatedAt: Date.now(),
            deactivatedAt: Date.now(),
            deactivatedReason:
              "Portal deactivated — no key used for a new app access in over a week",
            activityGraceStartedAt: graceStartedAt,
          };
          return next;
        }, `chore: auto-deactivate inactive mentor ${key}`);
      } catch {
        // still report deactivated to the client
      }
    }
    return {
      ok: true,
      email: key,
      exempt: false,
      active: false,
      inGrace: false,
      deactivated: true,
      lastQualifyingAt: lastQualifyingAt || null,
      weekDeadlineAt,
      graceStartedAt,
      graceEndsAt,
      msUntilWeekDeadline: 0,
      msUntilGraceEnds: 0,
      message:
        "Portal deactivated — no key used for a new app access in over a week. Ask super admin to reactivate.",
    };
  }

  return {
    ok: true,
    email: key,
    exempt: false,
    active: true,
    inGrace: true,
    deactivated: false,
    lastQualifyingAt: lastQualifyingAt || null,
    weekDeadlineAt,
    graceStartedAt,
    graceEndsAt,
    msUntilWeekDeadline: 0,
    msUntilGraceEnds: Math.max(0, graceEndsAt - now),
    message:
      "No new-app unlock this week. Portal deactivates when this countdown ends — get a client to use a new key now.",
  };
}

/** Clear grace / deactivation stamps when a qualifying key is used. */
export async function noteMentorQualifyingActivity(email, at = Date.now()) {
  const key = normalizeEmail(email);
  if (!key || key === SUPER_ADMIN_EMAIL) return;
  try {
    await mutateStore((list) => {
      const next = ensureSuperAdminRecord(list);
      const idx = findMentorIndex(next, key);
      if (idx < 0) return next;
      next[idx] = {
        ...next[idx],
        activityGraceStartedAt: null,
        // Do not auto-reactivate declined mentors here — super admin must approve.
      };
      return next;
    }, `chore: mentor qualifying activity ${key} @ ${Number(at) || Date.now()}`);
  } catch {
    // best-effort
  }
}

export async function loginMentor({ email, password }) {
  const key = normalizeEmail(email);
  const pass = String(password || "").trim();
  if (!key || !pass) {
    const err = new Error("Enter email and password");
    err.status = 400;
    throw err;
  }

  // Always allow the configured super admin, even if the remote store is down.
  if (key === SUPER_ADMIN_EMAIL && pass === SUPER_ADMIN_PASSWORD) {
    return {
      id: "super-admin",
      username: SUPER_ADMIN_USERNAME,
      email: SUPER_ADMIN_EMAIL,
      contact: "",
      role: "superadmin",
      status: "approved",
      createdAt: Date.now(),
    };
  }

  async function loadMentorsFresh({ bustMemory = false } = {}) {
    if (bustMemory) memoryMentors = null;
    const store = await readStore().catch(() => readLocalStore());
    return mergeCredentialRows(
      ensureSuperAdminRecord(store.mentors || []),
      credentialBackupPool()
    );
  }

  function verifyHash(mentor) {
    if (!mentor?.passwordHash || !mentor?.salt) return false;
    return hashPassword(pass, mentor.salt) === mentor.passwordHash;
  }

  async function finishApprovedLogin(mentor) {
    const status = String(mentor.status || "").toLowerCase();
    if (status === "deactivated" || (status === "declined" && mentor.deactivatedAt)) {
      const err = new Error(
        mentor.deactivatedReason ||
          "Portal deactivated — no key used for a new app access in over a week. Ask super admin to reactivate."
      );
      err.status = 403;
      throw err;
    }
    if (status !== "approved" && mentor.role !== "superadmin") {
      const err = new Error(
        status === "declined"
          ? mentor.deactivatedReason ||
              "Account declined — ask super admin to reactivate"
          : "Account pending approval by super admin"
      );
      err.status = 403;
      throw err;
    }

    try {
      const activity = await getMentorActivityStatus(key, { enforce: true });
      if (activity?.deactivated) {
        const err = new Error(
          activity.message ||
            "Portal deactivated — no key used for a new app access in over a week."
        );
        err.status = 403;
        throw err;
      }
    } catch (error) {
      if (error?.status === 403) throw error;
    }

    return publicMentor(mentor);
  }

  // 1) Verify the stored hash first — custom passwords always win.
  let mentors = await loadMentorsFresh();
  let mentor = findMentor(mentors, key);
  if (mentor && verifyHash(mentor)) {
    return finishApprovedLogin(mentor);
  }
  if (mentor && mentor.passwordHash && mentor.salt && !verifyHash(mentor)) {
    // Stale in-memory / cold-instance hash — re-read once before failing.
    mentors = await loadMentorsFresh({ bustMemory: true });
    mentor = findMentor(mentors, key);
    if (mentor && verifyHash(mentor)) {
      return finishApprovedLogin(mentor);
    }
    // Stored hash exists and does not match — never wipe it with bootstrap.
    const err = new Error("Invalid email or password");
    err.status = 401;
    throw err;
  }

  // 2) Missing row or wiped credentials — bootstrap may repair ONLY then.
  const bootstrapPass = DURABLE_MENTOR_PASSWORDS[key];
  if (!bootstrapPass || pass !== bootstrapPass) {
    const err = new Error("Invalid email or password");
    err.status = 401;
    throw err;
  }

  const existing = mentor || findMentor(mentors, key);
  try {
    await mutateStore((listIn) => {
      const list = ensureSuperAdminRecord(listIn);
      const idx = findMentorIndex(list, key);
      // Only fill empty credentials — never overwrite a real custom hash.
      if (idx >= 0 && list[idx]?.passwordHash && list[idx]?.salt) {
        list[idx] = { ...list[idx], status: "approved" };
        return list;
      }
      const salt = createSalt();
      const passwordHash = hashPassword(pass, salt);
      const passwordUpdatedAt = Date.now();
      if (idx >= 0) {
        list[idx] = {
          ...list[idx],
          salt,
          passwordHash,
          passwordUpdatedAt,
          status: "approved",
        };
      } else {
        list.unshift({
          id: existing?.id || "eae67eca-96dd-4cb0-b5bd-67922d4a9892",
          username: existing?.username || key.split("@")[0] || "Mentor",
          email: key,
          contact: existing?.contact || "",
          role: "mentor",
          status: "approved",
          passwordHash,
          salt,
          passwordUpdatedAt,
          createdAt: existing?.createdAt || Date.now(),
          licenseKeysAllowed:
            existing?.licenseKeysAllowed ?? DEFAULT_MENTOR_LICENSE_KEYS,
        });
      }
      return list;
    }, `chore: repair missing durable password for ${key}`);
  } catch {
    // Allow bootstrap login even if durable write is rate-limited.
  }

  mentors = await loadMentorsFresh({ bustMemory: true });
  const repaired = findMentor(mentors, key);
  if (repaired) {
    return publicMentor({ ...repaired, status: "approved" });
  }
  return {
    id: existing?.id || "eae67eca-96dd-4cb0-b5bd-67922d4a9892",
    username: existing?.username || key.split("@")[0] || "Mentor",
    email: key,
    contact: existing?.contact || "",
    role: "mentor",
    status: "approved",
    createdAt: existing?.createdAt || Date.now(),
  };
}

export async function setMentorStatus(email, status) {
  const key = normalizeEmail(email);
  const nextStatus = String(status || "").toLowerCase();
  if (!["pending", "approved", "declined", "deactivated"].includes(nextStatus)) {
    const err = new Error("Invalid status");
    err.status = 400;
    throw err;
  }
  if (key === SUPER_ADMIN_EMAIL) {
    const err = new Error("Cannot change super admin status");
    err.status = 400;
    throw err;
  }

  let updated = null;
  let previousStatus = "";
  await mutateStore((mentors) => {
    const list = ensureSuperAdminRecord(mentors);
    const idx = findMentorIndex(list, key);
    if (idx < 0) {
      const err = new Error(
        "Mentor not found on server — use Set password to restore this account, then approve"
      );
      err.status = 404;
      throw err;
    }
    previousStatus = String(list[idx].status || "").toLowerCase();
    const normalizedStatus =
      nextStatus === "deactivated" ? "declined" : nextStatus;
    list[idx] = {
      ...list[idx],
      status: normalizedStatus,
      email: key,
      statusUpdatedAt: Date.now(),
      ...(normalizedStatus === "approved"
        ? {
            activityGraceStartedAt: null,
            deactivatedAt: null,
            deactivatedReason: "",
          }
        : {}),
      ...(nextStatus === "deactivated"
        ? {
            deactivatedAt: Date.now(),
            deactivatedReason:
              "Portal deactivated — no key used for a new app access in over a week",
          }
        : {}),
    };
    updated = list[idx];
    return list;
  }, `chore: set mentor ${key} to ${nextStatus}`);

  const newlyApproved =
    nextStatus === "approved" && previousStatus !== "approved";
  let approvalEmailSent = false;
  if (newlyApproved) {
    try {
      const { sendMentorApprovedEmail } = await import("../_brevo.js");
      const sent = await sendMentorApprovedEmail({
        toEmail: key,
        toName: updated?.username || "",
      });
      approvalEmailSent = Boolean(sent?.ok);
      if (!sent?.ok) {
        console.warn(
          "mentor approval email failed",
          key,
          sent?.error || sent?.skipped || "unknown"
        );
      }
    } catch (error) {
      console.warn(
        "mentor approval email error",
        key,
        error?.message || error
      );
    }
  }

  return {
    mentor: publicMentor(updated),
    approvalEmailSent,
  };
}

export async function updateMentorProfile(email, profileInput = {}) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }
  if (key === SUPER_ADMIN_EMAIL) {
    const err = new Error("Cannot edit the super admin profile here");
    err.status = 400;
    throw err;
  }

  const username = String(profileInput.username || "").trim();
  const contactRaw = profileInput.contact ?? profileInput.contactNumber ?? profileInput.phone;
  const contact =
    contactRaw == null || contactRaw === ""
      ? null
      : normalizePhone(contactRaw);

  if (!username) {
    const err = new Error("Enter a username");
    err.status = 400;
    throw err;
  }
  if (contact != null && contact.length < 7) {
    const err = new Error("Enter a valid contact number");
    err.status = 400;
    throw err;
  }

  let updated = null;
  try {
    await mutateStore((mentors) => {
      const list = ensureSuperAdminRecord(mentors);
      const idx = findMentorIndex(list, key);
      if (idx < 0) {
        const err = new Error("Mentor not found");
        err.status = 404;
        throw err;
      }
      list[idx] = {
        ...list[idx],
        username,
        usernameUpdatedAt: Date.now(),
        ...(contact != null ? { contact } : {}),
      };
      updated = list[idx];
      return list;
    }, `chore: update mentor profile ${key}`);
  } catch (error) {
    if (error.status === 400 || error.status === 404) throw error;
    const store = await readStore().catch(() => readLocalStore());
    const list = ensureSuperAdminRecord(store.mentors || []);
    const idx = findMentorIndex(list, key);
    if (idx < 0) {
      const err = new Error("Mentor not found");
      err.status = 404;
      throw err;
    }
    list[idx] = {
      ...list[idx],
      username,
      usernameUpdatedAt: Date.now(),
      ...(contact != null ? { contact } : {}),
    };
    writeLocalStore(list);
    updated = list[idx];
  }

  try {
    const { syncMentorNameToLicenses } = await import("../licenses/_lib.js");
    await syncMentorNameToLicenses(key, username);
  } catch (error) {
    console.warn("mentor name license sync failed", error.message);
  }

  return publicMentor(updated);
}

/** Operating mentor emails that inherit the superadmin portal brand color. */
function brandThemeLinkedEmails() {
  return Object.keys(DURABLE_MENTOR_PASSWORDS || {})
    .map(normalizeEmail)
    .filter((email) => email && email.includes("@") && email !== SUPER_ADMIN_EMAIL);
}

function applyAppColorToMentorList(list, key, appColor) {
  const now = Date.now();
  const idx = findMentorIndex(list, key);
  if (idx < 0) {
    const err = new Error("Mentor not found");
    err.status = 404;
    throw err;
  }
  list[idx] = {
    ...list[idx],
    appColor,
    appColorUpdatedAt: now,
  };
  // Superadmin App color is the brand theme — mirror onto linked operator
  // accounts so license.mentorEmail lookups (gmail) match the portal choice.
  if (key === SUPER_ADMIN_EMAIL) {
    for (const linked of brandThemeLinkedEmails()) {
      const li = findMentorIndex(list, linked);
      if (li < 0) continue;
      list[li] = {
        ...list[li],
        appColor,
        appColorUpdatedAt: now,
      };
    }
  }
  return list[idx];
}

export async function updateMentorAppColor(email, rawColor) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }
  const appColor = normalizeAppColor(rawColor);
  if (!appColor) {
    const err = new Error("Enter a valid color like #ff2d7a");
    err.status = 400;
    throw err;
  }

  let updated = null;
  try {
    await mutateStore((mentors) => {
      const list = ensureSuperAdminRecord(mentors);
      updated = applyAppColorToMentorList(list, key, appColor);
      return list;
    }, `chore: update app color for ${key}`);
  } catch (error) {
    if (error.status === 400 || error.status === 404) throw error;
    const store = await readStore().catch(() => readLocalStore());
    const list = ensureSuperAdminRecord(store.mentors || []);
    updated = applyAppColorToMentorList(list, key, appColor);
    writeLocalStore(list);
  }

  return publicMentor(updated);
}

export async function updateMentorBanking(email, bankingInput = {}) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }
  const banking = {
    ...normalizeBanking(bankingInput),
    updatedAt: Date.now(),
  };
  if (!banking.accountName || !banking.bankName || !banking.accountNumber) {
    const err = new Error("Account name, bank name, and account number are required");
    err.status = 400;
    throw err;
  }

  let updated = null;
  try {
    await mutateStore((mentors) => {
      const list = ensureSuperAdminRecord(mentors);
      const idx = findMentorIndex(list, key);
      if (idx < 0) {
        const err = new Error("Mentor not found");
        err.status = 404;
        throw err;
      }
      list[idx] = { ...list[idx], banking };
      updated = list[idx];
      return list;
    }, `chore: update banking for ${key}`);
  } catch (error) {
    if (error.status === 400) throw error;
    // Always keep banking on the mentor record locally so the client gets a
    // successful save even when GitHub is unreachable / unauthorized.
    const store = await readStore().catch(() => readLocalStore());
    const list = ensureSuperAdminRecord(store.mentors || []);
    const idx = findMentorIndex(list, key);
    if (idx < 0) {
      if (error.status === 404) throw error;
      const err = new Error("Mentor not found");
      err.status = 404;
      throw err;
    }
    list[idx] = { ...list[idx], banking };
    writeLocalStore(list);
    updated = list[idx];
  }

  return publicMentor(updated);
}

/** Rolling weekly withdrawal-request quota for a mentor (max 2 / 7 days). */
export async function getMentorWithdrawalQuota(email) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Mentor email is required");
    err.status = 400;
    throw err;
  }
  const store = await readStore().catch(() => readLocalStore());
  const mentor = findMentor(ensureSuperAdminRecord(store.mentors || []), key);
  if (!mentor) {
    const err = new Error("Mentor account not found");
    err.status = 404;
    throw err;
  }
  return withdrawalQuotaFromList(key, mentor.withdrawalRequests);
}

/**
 * Atomically append a withdrawal-request timestamp if under the weekly cap.
 * Returns the updated quota. Throws 429 when the limit is already hit.
 */
export async function recordMentorWithdrawalRequest(email) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Mentor email is required");
    err.status = 400;
    throw err;
  }

  let quota = null;
  await mutateStore((mentors) => {
    const list = ensureSuperAdminRecord(mentors);
    const idx = findMentorIndex(list, key);
    if (idx < 0) {
      const err = new Error("Mentor account not found");
      err.status = 404;
      throw err;
    }
    const now = Date.now();
    const recent = pruneWithdrawalRequests(list[idx].withdrawalRequests, now);
    if (recent.length >= WITHDRAW_MAX_PER_WEEK) {
      const err = new Error(
        `Withdrawal limit reached — max ${WITHDRAW_MAX_PER_WEEK} requests per week`
      );
      err.status = 429;
      err.data = { quota: withdrawalQuotaFromList(key, recent, now) };
      throw err;
    }
    const nextStamps = [...recent, now];
    list[idx] = {
      ...list[idx],
      email: key,
      withdrawalRequests: nextStamps,
      withdrawalRequestedAt: now,
    };
    quota = withdrawalQuotaFromList(key, nextStamps, now);
    return list;
  }, `chore: mentor withdrawal request ${key}`);

  return quota;
}

/**
 * Returns the key allotment for a mentor email, or null for unlimited (super admin / missing).
 * Prefers the highest known allotment across durable + in-memory overlays so
 * license create never uses a stale lower cap after super admin raised keys.
 */
export async function getMentorLicenseKeysAllowed(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  if (key === SUPER_ADMIN_EMAIL) return null;
  try {
    const store = await readStore();
    const mentors = ensureSuperAdminRecord(store.mentors);
    const mentor = findMentor(mentors, key);
    if (!mentor) {
      // Fall back to bundled/local file when durable briefly omits the row.
      try {
        const local = readLocalStore();
        const localMentor = findMentor(
          ensureSuperAdminRecord(local.mentors || []),
          key
        );
        if (localMentor) {
          return normalizeLicenseKeysAllowed(localMentor.licenseKeysAllowed, {
            role: localMentor.role,
          });
        }
      } catch {
        // ignore
      }
      return DEFAULT_MENTOR_LICENSE_KEYS;
    }
    const fromStore = normalizeLicenseKeysAllowed(mentor.licenseKeysAllowed, {
      role: mentor.role,
    });
    // Also consider bundled/local in case durable is stale lower.
    try {
      const local = readLocalStore();
      const localMentor = findMentor(
        ensureSuperAdminRecord(local.mentors || []),
        key
      );
      const fromLocal = localMentor
        ? normalizeLicenseKeysAllowed(localMentor.licenseKeysAllowed, {
            role: localMentor.role,
          })
        : null;
      if (fromStore == null) return fromLocal;
      if (fromLocal == null) return fromStore;
      const storeAt = Number(mentor.licenseKeysUpdatedAt) || 0;
      const localAt = Number(localMentor.licenseKeysUpdatedAt) || 0;
      if (localAt > storeAt) return fromLocal;
      if (storeAt > localAt) return fromStore;
      return Math.max(fromStore, fromLocal);
    } catch {
      return fromStore;
    }
  } catch {
    return DEFAULT_MENTOR_LICENSE_KEYS;
  }
}

export async function setMentorPassword({
  adminEmail,
  email,
  password,
  currentPassword,
  username,
  contact,
  status,
} = {}) {
  const key = normalizeEmail(email);
  const pass = String(password || "");
  const admin = normalizeEmail(adminEmail);
  const current = String(currentPassword || "");
  const restoreName = String(username || "").trim();
  const restoreContact = normalizePhone(contact);
  const restoreStatus = String(status || "")
    .trim()
    .toLowerCase();

  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }
  if (pass.length < 6) {
    const err = new Error("Password must be at least 6 characters");
    err.status = 400;
    throw err;
  }

  const isSuperAdmin = admin === SUPER_ADMIN_EMAIL;
  const isOperator = isMentorOperator(admin);
  const canAdminSet = isSuperAdmin || isOperator;
  const isSelf = admin && admin === key;

  if (!canAdminSet && !isSelf) {
    const err = new Error(
      "Only the account owner, operator mentor, or super admin can set a password"
    );
    err.status = 403;
    throw err;
  }

  // Self-service change requires the current password (no email reset flow).
  if (isSelf && !canAdminSet) {
    if (!current) {
      const err = new Error("Enter your current password");
      err.status = 400;
      throw err;
    }
    const store = await readStore();
    const mentors = ensureSuperAdminRecord(store.mentors);
    const me = findMentor(mentors, key);
    if (!me?.passwordHash || !me?.salt) {
      const err = new Error("Account password is missing — ask super admin to set it");
      err.status = 400;
      throw err;
    }
    if (hashPassword(current, me.salt) !== me.passwordHash) {
      const err = new Error("Current password is incorrect");
      err.status = 401;
      throw err;
    }
  }

  let updated = null;
  await mutateStore((mentors) => {
    const list = ensureSuperAdminRecord(mentors);
    const idx = findMentorIndex(list, key);
    const salt = createSalt();
    const passwordHash = hashPassword(pass, salt);
    const passwordUpdatedAt = Date.now();
    if (idx < 0) {
      // Super admin / operator can restore mentors wiped from durable storage
      // by setting a password — recreates the row so Approve / Decline work again.
      if (!canAdminSet) {
        const err = new Error("Mentor not found");
        err.status = 404;
        throw err;
      }
      const nextStatus = ["pending", "approved", "declined"].includes(restoreStatus)
        ? restoreStatus
        : "approved";
      updated = {
        id: crypto.randomUUID(),
        username: restoreName || key.split("@")[0] || "Mentor",
        email: key,
        contact: restoreContact || "",
        role: "mentor",
        status: nextStatus,
        passwordHash,
        salt,
        passwordUpdatedAt,
        createdAt: Date.now(),
        licenseKeysAllowed: DEFAULT_MENTOR_LICENSE_KEYS,
      };
      list.unshift(updated);
      return list;
    }
    list[idx] = {
      ...list[idx],
      email: key,
      salt,
      passwordHash,
      passwordUpdatedAt,
      ...(restoreName ? { username: restoreName } : {}),
      ...(restoreContact ? { contact: restoreContact } : {}),
    };
    updated = list[idx];
    return list;
  }, `chore: set password for mentor ${key}`);

  return publicMentor(updated);
}

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const PASSWORD_RESET_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between emails

function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function passwordResetGenericResult() {
  return {
    ok: true,
    sent: false,
    message:
      "If that email belongs to an approved mentor, a reset link was sent.",
  };
}

/**
 * Email a password-reset link — approved mentors (and super admin) only.
 * Always returns a generic success message to avoid account enumeration.
 */
export async function requestMentorPasswordReset(email) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }

  const store = await readStore().catch(() => readLocalStore());
  const mentor = findMentor(ensureSuperAdminRecord(store.mentors || []), key);
  const role = String(mentor?.role || "").toLowerCase();
  const status = String(mentor?.status || "").toLowerCase();
  const eligible =
    mentor &&
    (role === "superadmin" || status === "approved") &&
    mentor.passwordHash &&
    mentor.salt;

  if (!eligible) {
    return passwordResetGenericResult();
  }

  const lastAt = Number(mentor.passwordResetRequestedAt) || 0;
  if (lastAt && Date.now() - lastAt < PASSWORD_RESET_COOLDOWN_MS) {
    return {
      ...passwordResetGenericResult(),
      cooldown: true,
    };
  }

  const { brevoConfigured, sendBrevoEmail } = await import("../_brevo.js");
  if (!brevoConfigured()) {
    const err = new Error("Email service is not configured");
    err.status = 503;
    throw err;
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(token);
  const expiresAt = Date.now() + PASSWORD_RESET_TTL_MS;
  const requestedAt = Date.now();

  await mutateStore((mentors) => {
    const list = ensureSuperAdminRecord(mentors);
    const idx = findMentorIndex(list, key);
    if (idx < 0) return list;
    list[idx] = {
      ...list[idx],
      email: key,
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: expiresAt,
      passwordResetRequestedAt: requestedAt,
    };
    return list;
  }, `chore: mentor password reset request ${key}`);

  const appUrl = String(process.env.PUBLIC_APP_URL || "https://www.apex-ea.com")
    .trim()
    .replace(/\/+$/, "");
  const resetUrl = `${appUrl}/admin?reset=${encodeURIComponent(token)}`;
  const username = String(mentor.username || "Mentor").trim() || "Mentor";
  const safeName = username
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const subject = "Reset your ApexEA mentor password";
  const textContent = [
    `Hi ${username},`,
    "",
    "We received a request to reset your ApexEA mentor password.",
    "",
    "Open this link to choose a new password (expires in 1 hour):",
    resetUrl,
    "",
    "If you did not ask for this, you can ignore this email.",
    "",
    "— ApexEA",
  ].join("\n");

  const htmlContent = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f5f5f7;">
  <div style="max-width:520px;margin:0 auto;background:#16161d;border:1px solid #2a2a35;border-radius:16px;padding:24px;">
    <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#ff7ab5;">ApexEA mentor</p>
    <h1 style="margin:0 0 16px;font-size:22px;color:#fff;">Reset your password</h1>
    <p style="margin:0 0 14px;color:#c8c8d0;font-size:15px;line-height:1.5;">Hi ${safeName},</p>
    <p style="margin:0 0 18px;color:#c8c8d0;font-size:15px;line-height:1.5;">We received a request to reset your mentor portal password. This link expires in 1 hour.</p>
    <p style="margin:0 0 22px;text-align:center;">
      <a href="${resetUrl}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#ff2d7a;color:#fff;font-weight:700;text-decoration:none;">Choose new password</a>
    </p>
    <p style="margin:0;font-size:12px;line-height:1.45;color:#7a7a88;">If you did not ask for this, ignore this email.</p>
  </div>
</body></html>`;

  const sent = await sendBrevoEmail({
    toEmail: key,
    toName: username,
    subject,
    htmlContent,
    textContent,
    tags: ["mentor-password-reset"],
  });

  if (!sent.ok) {
    const err = new Error(sent.error || "Could not send reset email");
    err.status = sent.skipped ? 503 : 502;
    throw err;
  }

  return {
    ok: true,
    sent: true,
    message:
      "If that email belongs to an approved mentor, a reset link was sent.",
  };
}

/** Complete password reset with the emailed token (approved mentors). */
export async function completeMentorPasswordReset({ token, password } = {}) {
  const rawToken = String(token || "").trim();
  const pass = String(password || "");
  if (!rawToken || rawToken.length < 20) {
    const err = new Error("Reset link is invalid or expired");
    err.status = 400;
    throw err;
  }
  if (pass.length < 6) {
    const err = new Error("Password must be at least 6 characters");
    err.status = 400;
    throw err;
  }

  const tokenHash = hashResetToken(rawToken);
  const now = Date.now();
  let updated = null;

  await mutateStore((mentors) => {
    const list = ensureSuperAdminRecord(mentors);
    const idx = list.findIndex(
      (m) =>
        String(m.passwordResetTokenHash || "") === tokenHash &&
        Number(m.passwordResetExpiresAt) > now
    );
    if (idx < 0) {
      const err = new Error("Reset link is invalid or expired");
      err.status = 400;
      throw err;
    }
    const role = String(list[idx].role || "").toLowerCase();
    const status = String(list[idx].status || "").toLowerCase();
    if (role !== "superadmin" && status !== "approved") {
      const err = new Error("Only approved mentors can reset passwords");
      err.status = 403;
      throw err;
    }
    const salt = createSalt();
    list[idx] = {
      ...list[idx],
      salt,
      passwordHash: hashPassword(pass, salt),
      passwordResetTokenHash: "",
      passwordResetExpiresAt: null,
      passwordResetRequestedAt:
        Number(list[idx].passwordResetRequestedAt) || null,
    };
    updated = list[idx];
    return list;
  }, "chore: complete mentor password reset");

  return publicMentor(updated);
}

/**
 * Super-admin edit/add for mentor license-key allotments.
 * - set: absolute total (e.g. 1500)
 * - add: increase by N keys
 */
export async function setMentorLicenseKeys(email, { set, add } = {}) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }
  if (key === SUPER_ADMIN_EMAIL) {
    const err = new Error("Super admin does not use a license key allotment");
    err.status = 400;
    throw err;
  }

  const hasSet = set != null && set !== "";
  const hasAdd = add != null && add !== "";
  if (!hasSet && !hasAdd) {
    const err = new Error("Provide set or add for license keys");
    err.status = 400;
    throw err;
  }

  let updated = null;
  const applyKeys = (list) => {
    const idx = findMentorIndex(list, key);
    if (idx < 0) {
      const err = new Error("Mentor not found");
      err.status = 404;
      throw err;
    }
    const current = normalizeLicenseKeysAllowed(list[idx].licenseKeysAllowed, {
      role: list[idx].role,
    });
    let next = current ?? DEFAULT_MENTOR_LICENSE_KEYS;
    if (hasSet) {
      const n = Math.floor(Number(set));
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error("Enter a valid key total (0 or more)");
        err.status = 400;
        throw err;
      }
      next = n;
    }
    if (hasAdd) {
      const n = Math.floor(Number(add));
      if (!Number.isFinite(n) || n === 0) {
        const err = new Error("Enter how many keys to add (non-zero)");
        err.status = 400;
        throw err;
      }
      next = Math.max(0, next + n);
    }
    list[idx] = {
      ...list[idx],
      licenseKeysAllowed: next,
      licenseKeysUpdatedAt: Date.now(),
    };
    updated = list[idx];
    return list;
  };

  try {
    await mutateStore(
      (mentors) => applyKeys(ensureSuperAdminRecord(mentors)),
      `chore: set mentor ${key} license keys`
    );
  } catch (error) {
    if (error.status === 400 || error.status === 404) throw error;
    // Still apply locally so this instance is consistent, but surface the
    // durable failure so admins do not think the allotment is saved globally.
    try {
      const store = await readStore().catch(() => readLocalStore());
      const list = ensureSuperAdminRecord(store.mentors || []);
      applyKeys(list);
      writeLocalStore(list);
    } catch {
      // ignore secondary local failure
    }
    const err = new Error(
      error?.message ||
        "Could not save key allotment to the shared store — tap Save again"
    );
    err.status = error?.status || 503;
    throw err;
  }

  return publicMentor(updated);
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}
