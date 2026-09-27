/**
 * Durable broadcast dedupe — same client email + campaign is only sent once
 * inside a TTL window (default 7 days). Stops double-taps, script retries,
 * and overlapping admin/script sends from flooding inboxes.
 */
import crypto from "node:crypto";
import { durableRead, durableWrite } from "../_durableJson.js";

const BLOB_PATH =
  process.env.EMAIL_BROADCAST_BLOB_PATH || "apexea/email-broadcasts.json";
const FIREBASE_PATH =
  process.env.EMAIL_BROADCAST_FIREBASE_PATH || "apexea/emailBroadcasts";
/** Never write this high-churn log to GitHub — it burns the Contents API quota. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let memoryLog = null;
/** In-flight campaign locks on this instance (overlapping POSTs). */
const inFlight = new Map();

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeSubject(subject) {
  return String(subject || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Stable campaign key from explicit id or subject text. */
export function broadcastCampaignKey({ campaignId = "", subject = "" } = {}) {
  const explicit = String(campaignId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (explicit) return explicit.slice(0, 80);
  const sub = normalizeSubject(subject);
  if (!sub) return "";
  return `subj-${crypto.createHash("sha1").update(sub).digest("hex").slice(0, 16)}`;
}

function emptyLog() {
  return { version: 1, sends: {}, updatedAt: Date.now() };
}

function decodeLog(raw) {
  if (!raw) return emptyLog();
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!data || typeof data !== "object") return emptyLog();
    const sends =
      data.sends && typeof data.sends === "object" ? data.sends : {};
    return { version: 1, sends: { ...sends }, updatedAt: Number(data.updatedAt) || Date.now() };
  } catch {
    return emptyLog();
  }
}

function sendKey(email, campaignKey) {
  return `${normalizeEmail(email)}|${String(campaignKey || "").trim()}`;
}

function pruneLog(log, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const next = emptyLog();
  next.updatedAt = now;
  for (const [key, row] of Object.entries(log.sends || {})) {
    const at = Number(row?.at) || 0;
    if (!at || now - at > ttlMs) continue;
    next.sends[key] = {
      email: normalizeEmail(row.email),
      campaignKey: String(row.campaignKey || ""),
      subject: String(row.subject || "").slice(0, 180),
      at,
      messageId: String(row.messageId || "").slice(0, 200),
    };
  }
  return next;
}

async function readLog() {
  if (memoryLog?.sends) return pruneLog(memoryLog);
  try {
    const durable = await durableRead({
      blobPath: BLOB_PATH,
      firebasePath: FIREBASE_PATH,
      // No githubPath — avoid Contents API rate-limit storms.
    });
    const raw =
      durable?.raw ??
      (durable?.data != null ? JSON.stringify(durable.data) : null);
    const log = pruneLog(decodeLog(raw));
    memoryLog = log;
    return log;
  } catch {
    return emptyLog();
  }
}

async function writeLog(log, message = "chore: email broadcast dedupe log") {
  const pruned = pruneLog(log);
  memoryLog = pruned;
  const raw = JSON.stringify(pruned, null, 2);
  try {
    await durableWrite({
      blobPath: BLOB_PATH,
      firebasePath: FIREBASE_PATH,
      // Intentionally omit githubPath so we never commit this log to main.
      raw,
      message,
    });
  } catch {
    // Best-effort — memory still blocks repeats on this instance.
  }
  return pruned;
}

/**
 * Split recipients into fresh vs already-sent for this campaign.
 * Also claims the fresh emails immediately so concurrent broadcasts skip them.
 */
export async function claimBroadcastRecipients({
  recipients = [],
  subject = "",
  campaignId = "",
  ttlMs = DEFAULT_TTL_MS,
  force = false,
} = {}) {
  const campaignKey = broadcastCampaignKey({ campaignId, subject });
  const list = Array.isArray(recipients) ? recipients : [];
  const unique = [];
  const seen = new Set();
  for (const entry of list) {
    const email =
      typeof entry === "string"
        ? normalizeEmail(entry)
        : normalizeEmail(entry?.email || entry?.toEmail || "");
    if (!email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    unique.push({
      email,
      name:
        typeof entry === "object"
          ? String(entry?.name || entry?.toName || entry?.clientName || "").trim()
          : "",
    });
  }

  if (!campaignKey || force) {
    return {
      campaignKey,
      send: unique,
      skipped: [],
      skippedCount: 0,
    };
  }

  // Instance lock — two overlapping POSTs for the same campaign serialize claims.
  const prev = inFlight.get(campaignKey) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  inFlight.set(
    campaignKey,
    prev.then(() => gate)
  );
  await prev;

  try {
    const now = Date.now();
    const log = await readLog();
    const send = [];
    const skipped = [];
    for (const row of unique) {
      const key = sendKey(row.email, campaignKey);
      const prior = log.sends[key];
      const at = Number(prior?.at) || 0;
      if (at && now - at <= ttlMs) {
        skipped.push({
          email: row.email,
          reason: "already_sent",
          sentAt: at,
        });
        continue;
      }
      // Claim immediately so a parallel request sees it as sent.
      log.sends[key] = {
        email: row.email,
        campaignKey,
        subject: String(subject || "").slice(0, 180),
        at: now,
        messageId: "pending",
      };
      send.push(row);
    }
    if (send.length) {
      await writeLog(
        log,
        `chore: claim broadcast ${campaignKey} ×${send.length}`
      );
    }
    return {
      campaignKey,
      send,
      skipped,
      skippedCount: skipped.length,
    };
  } finally {
    release();
    if (inFlight.get(campaignKey)?.then) {
      // clear when our gate is the tip
      Promise.resolve().then(() => {
        if (inFlight.get(campaignKey) === gate) inFlight.delete(campaignKey);
      });
    }
  }
}

/** Mark successful / failed sends after Brevo returns. */
export async function finalizeBroadcastSends({
  campaignKey = "",
  subject = "",
  results = [],
} = {}) {
  const key = String(campaignKey || "").trim();
  if (!key) return;
  const now = Date.now();
  const log = await readLog();
  let changed = false;
  for (const row of Array.isArray(results) ? results : []) {
    const email = normalizeEmail(row?.email);
    if (!email.includes("@")) continue;
    const sk = sendKey(email, key);
    if (row?.ok) {
      log.sends[sk] = {
        email,
        campaignKey: key,
        subject: String(subject || "").slice(0, 180),
        at: now,
        messageId: String(row.messageId || "ok").slice(0, 200),
      };
      changed = true;
    } else if (!row?.skipped) {
      // Failed send — free the claim so a retry can reach them.
      if (log.sends[sk]?.messageId === "pending") {
        delete log.sends[sk];
        changed = true;
      }
    }
  }
  if (changed) {
    await writeLog(log, `chore: finalize broadcast ${key}`);
  }
}
