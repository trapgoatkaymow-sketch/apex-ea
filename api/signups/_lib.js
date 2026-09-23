import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FALLBACK_GITHUB_TOKEN } from "./_githubToken.js";
import { applyCorsHeaders } from "../_cors.js";
import { durableRead, durableWrite } from "../_durableJson.js";

const REPO =
  process.env.SIGNUPS_GITHUB_REPO || "trapgoatkaymow-sketch/apex-ea";
const BRANCH = process.env.SIGNUPS_GITHUB_BRANCH || "main";
const FILE_PATH = process.env.SIGNUPS_FILE_PATH || "data/signups.json";
const BLOB_PATH = process.env.SIGNUPS_BLOB_PATH || "apexea/signups.json";
const API = `https://api.github.com/repos/${REPO}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_FILE = path.resolve(__dirname, "../../data/signups.json");
const TMP_FILE = path.join("/tmp", "apexea-signups.json");

/** In-process fallback when GitHub auth fails (expired token, etc.). */
let memorySignups = null;

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeSignup(raw = {}) {
  const email = normalizeEmail(raw.email);
  if (!email || !email.includes("@")) return null;
  return {
    email,
    status: String(raw.status || "pending").toLowerCase(),
    createdAt: Number(raw.createdAt) || Date.now(),
    premiumScanner: Boolean(raw.premiumScanner),
    premiumScannerAt: raw.premiumScannerAt ? Number(raw.premiumScannerAt) : null,
    accessPaid: Boolean(raw.accessPaid),
    accessPaidAt: raw.accessPaidAt ? Number(raw.accessPaidAt) : null,
    // Mentor invite / platform migration — free access, not a PayPal payment.
    accessBypassed: Boolean(raw.accessBypassed),
    accessBypassedAt: raw.accessBypassedAt ? Number(raw.accessBypassedAt) : null,
    appAccessUnlockedAt: raw.appAccessUnlockedAt
      ? Number(raw.appAccessUnlockedAt)
      : null,
  };
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
    const err = new Error("Signup store is not configured");
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

function decodeContent(file) {
  const raw = Buffer.from(String(file.content || "").replace(/\n/g, ""), "base64").toString(
    "utf8"
  );
  try {
    const parsed = JSON.parse(raw || "{}");
    const signups = Array.isArray(parsed?.signups) ? parsed.signups : [];
    return {
      sha: file.sha,
      signups: signups.map(normalizeSignup).filter(Boolean),
    };
  } catch {
    return { sha: file.sha, signups: [] };
  }
}

function decodeSignupsJson(raw, sha = "local") {
  try {
    const parsed = JSON.parse(raw || "{}");
    const signups = Array.isArray(parsed?.signups) ? parsed.signups : [];
    return {
      sha,
      signups: signups.map(normalizeSignup).filter(Boolean),
    };
  } catch {
    return { sha, signups: [] };
  }
}

function readLocalStore() {
  if (Array.isArray(memorySignups)) {
    return { sha: "local", signups: memorySignups.map((s) => ({ ...s })) };
  }
  for (const file of [TMP_FILE, LOCAL_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      const decoded = decodeSignupsJson(fs.readFileSync(file, "utf8"), "local");
      memorySignups = decoded.signups;
      return { sha: "local", signups: decoded.signups.map((s) => ({ ...s })) };
    } catch {
      // try next
    }
  }
  memorySignups = [];
  return { sha: "local", signups: [] };
}

function writeLocalStore(signups) {
  const next = signups.map(normalizeSignup).filter(Boolean);
  memorySignups = next;
  const payload = `${JSON.stringify({ signups: next }, null, 2)}\n`;
  for (const file of [TMP_FILE, LOCAL_FILE]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, payload, "utf8");
      break;
    } catch {
      // /tmp usually works when the repo tree is read-only
    }
  }
  return next;
}

function mergeSignupLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const row of list || []) {
      const item = normalizeSignup(row);
      if (!item) continue;
      const prev = map.get(item.email);
      if (!prev) {
        map.set(item.email, item);
        continue;
      }
      map.set(item.email, {
        ...prev,
        ...item,
        status:
          item.status === "approved" || prev.status === "approved"
            ? "approved"
            : item.status || prev.status,
        premiumScanner: Boolean(prev.premiumScanner || item.premiumScanner),
        premiumScannerAt: Math.max(
          Number(prev.premiumScannerAt) || 0,
          Number(item.premiumScannerAt) || 0
        ) || null,
        accessPaid: Boolean(prev.accessPaid || item.accessPaid),
        accessPaidAt: Math.max(
          Number(prev.accessPaidAt) || 0,
          Number(item.accessPaidAt) || 0
        ) || null,
        appAccessUnlockedAt: Math.max(
          Number(prev.appAccessUnlockedAt) || 0,
          Number(item.appAccessUnlockedAt) || 0
        ) || null,
        createdAt: Math.min(
          Number(prev.createdAt) || Date.now(),
          Number(item.createdAt) || Date.now()
        ),
      });
    }
  }
  return Array.from(map.values());
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
    let remoteSignups = [];
    if (durable.raw) {
      try {
        const parsed = JSON.parse(durable.raw || "{}");
        remoteSignups = Array.isArray(parsed?.signups) ? parsed.signups : [];
      } catch {
        remoteSignups = [];
      }
    }
    memorySignups = mergeSignupLists(readLocalStore().signups, remoteSignups);
    return {
      sha: durable.sha,
      signups: memorySignups.map((s) => ({ ...s })),
      remote: durable.source !== "empty" && durable.source !== "local",
      source: durable.source,
    };
  } catch {
    return { ...readLocalStore(), remote: false };
  }
}

async function writeStore(signups, sha, message) {
  const normalized = mergeSignupLists(signups).sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );
  const raw = JSON.stringify({ signups: normalized }, null, 2) + "\n";
  writeLocalStore(normalized);
  memorySignups = normalized.map((s) => ({ ...s }));

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
    return { local: true, durable: false, reason: result?.reason || null };
  } catch {
    return { local: true };
  }
}

async function mutateStore(mutator, message) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const store = await readStore();
      const next = mutator(store.signups.map((s) => ({ ...s })));
      await writeStore(next, store.sha, message);
      return mergeSignupLists(next);
    } catch (error) {
      lastError = error;
      if (error.status === 409 || error.status === 422) continue;
      try {
        const local = readLocalStore();
        const next = mutator(local.signups.map((s) => ({ ...s })));
        return writeLocalStore(next);
      } catch {
        throw error;
      }
    }
  }
  throw lastError || new Error("Could not update signups store");
}

export async function listSignups() {
  const store = await readStore();
  return store.signups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function upsertSignup(email, { status = "pending" } = {}) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }

  let result = null;
  await mutateStore((signups) => {
    const idx = signups.findIndex((s) => s.email === key);
    if (idx >= 0) {
      const current = signups[idx];
      // Paid / previously unlocked clients keep access when they sign in again
      // (same phone or reinstall) — never demote them back to pending payment.
      if (
        current.status === "approved" ||
        current.accessPaid ||
        current.appAccessUnlockedAt
      ) {
        if (current.status !== "approved") {
          signups[idx] = { ...current, status: "approved" };
          result = signups[idx];
          return signups;
        }
        result = current;
        return signups;
      }
      const updated = {
        ...current,
        status: current.status === "declined" ? "pending" : current.status || "pending",
        createdAt: current.status === "declined" ? Date.now() : current.createdAt,
      };
      if (status === "pending" && current.status !== "approved") {
        updated.status = "pending";
      }
      signups[idx] = updated;
      result = updated;
      return signups;
    }
      result = normalizeSignup({
        email: key,
        status: "pending",
        createdAt: Date.now(),
      });
    return [result, ...signups];
  }, `signup: ${key}`);

  return result;
}

/** Approve many client emails in one store write (CSV license migration). */
export async function upsertSignupsApprovedBulk(emails = []) {
  const list = Array.isArray(emails) ? emails : [];
  const unique = [];
  const seen = new Set();
  for (const raw of list) {
    const email = normalizeEmail(raw);
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    unique.push(email);
  }
  if (!unique.length) return [];

  const updated = [];
  await mutateStore((signups) => {
    const byEmail = new Map(signups.map((s) => [s.email, s]));
    const next = [...signups];
    const now = Date.now();
    for (const email of unique) {
      const current = byEmail.get(email);
      if (current) {
        const row = {
          ...current,
          status: "approved",
          accessPaid: true,
          accessPaidAt: current.accessPaidAt || now,
        };
        const idx = next.findIndex((s) => s.email === email);
        if (idx >= 0) next[idx] = row;
        byEmail.set(email, row);
        updated.push(row);
      } else {
        const row = normalizeSignup({
          email,
          status: "approved",
          createdAt: now,
          accessPaid: true,
          accessPaidAt: now,
        });
        next.unshift(row);
        byEmail.set(email, row);
        updated.push(row);
      }
    }
    return next;
  }, `bulk signup approve: ${unique.length}`);

  return updated;
}

/**
 * Mentor invite / platform migration — approve + free access bypass.
 * Does NOT mark accessPaid (no PayPal), so mentor commission stays clean.
 */
export async function upsertSignupsInviteBypass(emails = []) {
  const list = Array.isArray(emails) ? emails : [];
  const unique = [];
  const seen = new Set();
  for (const raw of list) {
    const email = normalizeEmail(raw);
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    unique.push(email);
  }
  if (!unique.length) return [];

  const updated = [];
  await mutateStore((signups) => {
    const byEmail = new Map(signups.map((s) => [s.email, s]));
    const next = [...signups];
    const now = Date.now();
    for (const email of unique) {
      const current = byEmail.get(email);
      if (current) {
        const row = {
          ...current,
          status: "approved",
          accessBypassed: true,
          accessBypassedAt: current.accessBypassedAt || now,
          // Keep any real PayPal payment if they already paid.
          accessPaid: Boolean(current.accessPaid),
          accessPaidAt: current.accessPaidAt || null,
        };
        const idx = next.findIndex((s) => s.email === email);
        if (idx >= 0) next[idx] = row;
        byEmail.set(email, row);
        updated.push(row);
      } else {
        const row = normalizeSignup({
          email,
          status: "approved",
          createdAt: now,
          accessBypassed: true,
          accessBypassedAt: now,
          accessPaid: false,
        });
        next.unshift(row);
        byEmail.set(email, row);
        updated.push(row);
      }
    }
    return next;
  }, `invite bypass: ${unique.length}`);

  return updated;
}

export async function setSignupStatus(email, status) {
  const key = normalizeEmail(email);
  const next = String(status || "").toLowerCase();
  if (!["pending", "approved", "declined"].includes(next)) {
    const err = new Error("Invalid status");
    err.status = 400;
    throw err;
  }

  let result = null;
  await mutateStore((signups) => {
    const idx = signups.findIndex((s) => s.email === key);
    if (idx >= 0) {
      signups[idx] = { ...signups[idx], status: next };
      result = signups[idx];
      return signups;
    }
    result = normalizeSignup({
      email: key,
      status: next,
      createdAt: Date.now(),
    });
    return [result, ...signups];
  }, `signup ${next}: ${key}`);

  return result;
}

export async function findSignup(email) {
  const key = normalizeEmail(email);
  if (!key) return null;
  const signups = await listSignups();
  return signups.find((s) => s.email === key) || null;
}

export async function setSignupAccessPaid(email, paid = true) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }

  let result = null;
  await mutateStore((signups) => {
    const idx = signups.findIndex((s) => s.email === key);
    const accessPaid = Boolean(paid);
    const accessPaidAt = accessPaid ? Date.now() : null;
    if (idx >= 0) {
      signups[idx] = {
        ...signups[idx],
        accessPaid,
        accessPaidAt: accessPaid
          ? accessPaidAt
          : signups[idx].accessPaidAt || null,
        status: accessPaid ? "approved" : signups[idx].status,
      };
      result = signups[idx];
      return signups;
    }
    result = normalizeSignup({
      email: key,
      status: accessPaid ? "approved" : "pending",
      createdAt: Date.now(),
      accessPaid,
      accessPaidAt,
    });
    return [result, ...signups];
  }, `access paid ${paid ? "on" : "off"}: ${key}`);

  return result;
}

/** Admin payment bypass — free access without counting as a paid unlock. */
export async function setSignupAccessBypassed(email, bypassed = true) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }

  let result = null;
  const now = Date.now();
  await mutateStore((signups) => {
    const idx = signups.findIndex((s) => s.email === key);
    const accessBypassed = Boolean(bypassed);
    if (idx >= 0) {
      const current = signups[idx];
      if (accessBypassed) {
        signups[idx] = {
          ...current,
          status: "approved",
          accessBypassed: true,
          accessBypassedAt: current.accessBypassedAt || now,
        };
      } else {
        // Clearing bypass: unpaid clients lose free access entirely.
        const paid = Boolean(current.accessPaid);
        signups[idx] = {
          ...current,
          accessBypassed: false,
          accessBypassedAt: null,
          ...(paid
            ? {}
            : {
                status: "pending",
                appAccessUnlockedAt: null,
              }),
        };
      }
      result = signups[idx];
      return signups;
    }
    // Clearing bypass on an unknown email — nothing to do.
    if (!accessBypassed) {
      result = null;
      return signups;
    }
    result = normalizeSignup({
      email: key,
      status: "approved",
      createdAt: now,
      accessBypassed: true,
      accessBypassedAt: now,
      accessPaid: false,
    });
    return [result, ...signups];
  }, `access bypass ${bypassed ? "on" : "off"}: ${key}`);

  return result;
}

/**
 * Revoke payment bypass for every client signup except keepEmails (mentors).
 * Unpaid bypassed accounts go back to pending with unlock cleared.
 */
export async function revokeClientAccessBypasses({ keepEmails = [] } = {}) {
  const keep = new Set(
    (Array.isArray(keepEmails) ? keepEmails : [])
      .map((e) => normalizeEmail(e))
      .filter((e) => e && e.includes("@"))
  );

  const revoked = [];
  const skippedMentors = [];

  await mutateStore((signups) => {
    return signups.map((row) => {
      if (!row?.accessBypassed) return row;
      const email = normalizeEmail(row.email);
      if (!email) return row;
      if (keep.has(email)) {
        skippedMentors.push(email);
        return row;
      }
      const paid = Boolean(row.accessPaid);
      const next = {
        ...row,
        accessBypassed: false,
        accessBypassedAt: null,
        ...(paid
          ? {}
          : {
              status: "pending",
              appAccessUnlockedAt: null,
            }),
      };
      revoked.push(next);
      return next;
    });
  }, "revoke client access bypasses (keep mentors)");

  return {
    revokedCount: revoked.length,
    skippedMentorCount: skippedMentors.length,
    revokedEmails: revoked.map((r) => r.email),
    skippedMentorEmails: skippedMentors,
  };
}

export async function setSignupAppAccessUnlocked(email, unlockedAt = Date.now()) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }

  let result = null;
  await mutateStore((signups) => {
    const idx = signups.findIndex((s) => s.email === key);
    const stamp = Number(unlockedAt) || Date.now();
    if (idx >= 0) {
      if (signups[idx].appAccessUnlockedAt) {
        result = signups[idx];
        return signups;
      }
      signups[idx] = {
        ...signups[idx],
        appAccessUnlockedAt: stamp,
      };
      result = signups[idx];
      return signups;
    }
    result = normalizeSignup({
      email: key,
      status: "approved",
      createdAt: Date.now(),
      appAccessUnlockedAt: stamp,
    });
    return [result, ...signups];
  }, `app access unlocked: ${key}`);

  return result;
}

export async function setSignupPremiumScanner(email, enabled = true) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("Enter a valid email");
    err.status = 400;
    throw err;
  }

  let result = null;
  await mutateStore((signups) => {
    const idx = signups.findIndex((s) => s.email === key);
    const premiumScanner = Boolean(enabled);
    const premiumScannerAt = premiumScanner ? Date.now() : null;
    if (idx >= 0) {
      signups[idx] = {
        ...signups[idx],
        // Bypass also unlocks app access so the client is not stuck on paywall.
        status: premiumScanner ? "approved" : signups[idx].status,
        premiumScanner,
        premiumScannerAt: premiumScanner
          ? premiumScannerAt
          : signups[idx].premiumScannerAt || null,
      };
      result = signups[idx];
      return signups;
    }
    result = normalizeSignup({
      email: key,
      status: "approved",
      createdAt: Date.now(),
      premiumScanner,
      premiumScannerAt,
    });
    return [result, ...signups];
  }, `premium scanner ${enabled ? "on" : "off"}: ${key}`);

  return result;
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}
