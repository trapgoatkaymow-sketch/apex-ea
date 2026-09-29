/**
 * Auto-fulfill ZETA SCALPER AI robot purchases from PayPal.
 * Same PayPal account as app-access; distinguished by purpose/amount.
 */
import {
  createLicense,
  listLicenses,
  normalizeLicenseKey,
  sendLicenseKeyEmailOnce,
} from "../licenses/_lib.js";
import { setSignupAccessPaid, upsertSignup } from "../signups/_lib.js";
import { listMentors, SUPER_ADMIN_EMAIL } from "../mentors/_lib.js";

export const ROBOT_PRICE = String(process.env.ROBOT_PURCHASE_PRICE || "95.00").trim();
export const ROBOT_CURRENCY = String(
  process.env.ROBOT_PURCHASE_CURRENCY || "USD"
)
  .trim()
  .toUpperCase();

/** Marketing-site PayPal NCP links still charge R1500 ZAR. */
export const ROBOT_NCP_PRICE = String(
  process.env.ROBOT_NCP_PRICE || "1500.00"
).trim();
export const ROBOT_NCP_CURRENCY = String(
  process.env.ROBOT_NCP_CURRENCY || "ZAR"
)
  .trim()
  .toUpperCase();

export const ROBOT_BOT_ID = String(
  process.env.ROBOT_BOT_ID || "zeta-scalper-ai-mtyew2ps"
).trim();
export const ROBOT_BOT_NAME = String(
  process.env.ROBOT_BOT_NAME || "ZETA SCALPER AI"
).trim();

/** Mentor who owns website robot sales (Zetascalperai.com). */
export const ROBOT_MENTOR_EMAIL = String(
  process.env.ROBOT_MENTOR_EMAIL || "trapgoatkaymow@gmail.com"
)
  .trim()
  .toLowerCase();

/** PayPal NCP payment-link ids used on zetascalperai.com */
export const ROBOT_NCP_LINK_IDS = String(
  process.env.ROBOT_NCP_LINK_IDS || "Q398DPLVNQS56,VTE7JTFTM7CT8"
)
  .split(/[,;\s]+/)
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/**
 * Giveaway checkout — $25 USD charge (display R350).
 * Same fulfill as robot: unlock app access + mint ZETA license + email key.
 */
export const GIVEAWAY_PRICE = String(
  process.env.GIVEAWAY_PURCHASE_PRICE || "25.00"
).trim();
export const GIVEAWAY_CURRENCY = String(
  process.env.GIVEAWAY_PURCHASE_CURRENCY || "USD"
)
  .trim()
  .toUpperCase();
export const GIVEAWAY_DISPLAY_PRICE = String(
  process.env.GIVEAWAY_DISPLAY_PRICE || "350"
).trim();
export const GIVEAWAY_DISPLAY_CURRENCY = String(
  process.env.GIVEAWAY_DISPLAY_CURRENCY || "ZAR"
)
  .trim()
  .toUpperCase();

/**
 * Giveaway offer window (default 5 days = original 24h + 4-day extension).
 * - If GIVEAWAY_STARTS_AT is set on Vercel, that ISO time is the start.
 * - Otherwise the first live request latches "now" into durable storage.
 * - Latched `durationMs` in storage wins when present (so extensions stick).
 */
export const GIVEAWAY_STARTS_AT_ENV = String(
  process.env.GIVEAWAY_STARTS_AT || ""
).trim();
/** Default hours when storage has no durationMs — 24h + 4 days. */
export const GIVEAWAY_DURATION_MS = Math.max(
  60_000,
  (Number(process.env.GIVEAWAY_DURATION_HOURS) || 120) * 60 * 60 * 1000
);

const GIVEAWAY_WINDOW_BLOB = "apexea/giveaway-window.json";
const GIVEAWAY_WINDOW_GITHUB = "data/giveaway-window.json";
const GIVEAWAY_WINDOW_FIREBASE = "apexea/giveawayWindow";

/** @type {{ startsAt: string, durationMs?: number } | null} */
let memoryGiveawayWindow = null;

function windowFromStart(startMs, nowMs = Date.now(), durationMs = GIVEAWAY_DURATION_MS) {
  const dur = Math.max(60_000, Number(durationMs) || GIVEAWAY_DURATION_MS);
  const endMs = startMs + dur;
  const remainingMs = Math.max(0, endMs - nowMs);
  const notStarted = nowMs < startMs;
  const expired = nowMs >= endMs;
  return {
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    durationMs: dur,
    remainingMs,
    active: !notStarted && !expired,
    expired,
    notStarted,
    serverNow: new Date(nowMs).toISOString(),
  };
}

function durationFromLatched(row) {
  const n = Number(row?.durationMs);
  return Number.isFinite(n) && n >= 60_000 ? n : GIVEAWAY_DURATION_MS;
}

/** Sync helper when start is already known (tests / env). */
export function getGiveawayWindow(nowMs = Date.now()) {
  const envStart = Date.parse(GIVEAWAY_STARTS_AT_ENV);
  const startMs = Number.isFinite(envStart)
    ? envStart
    : memoryGiveawayWindow?.startsAt
      ? Date.parse(memoryGiveawayWindow.startsAt)
      : nowMs;
  return windowFromStart(
    Number.isFinite(startMs) ? startMs : nowMs,
    nowMs,
    durationFromLatched(memoryGiveawayWindow)
  );
}

async function readLatchedWindow() {
  if (memoryGiveawayWindow?.startsAt) {
    const ms = Date.parse(memoryGiveawayWindow.startsAt);
    if (Number.isFinite(ms)) {
      return { startMs: ms, durationMs: durationFromLatched(memoryGiveawayWindow) };
    }
  }
  try {
    const { durableRead } = await import("../_durableJson.js");
    const doc = await durableRead({
      blobPath: GIVEAWAY_WINDOW_BLOB,
      firebasePath: GIVEAWAY_WINDOW_FIREBASE,
      githubPath: GIVEAWAY_WINDOW_GITHUB,
      localPaths: ["data/giveaway-window.json"],
    });
    let parsed = null;
    if (doc?.raw) {
      try {
        parsed = JSON.parse(doc.raw || "{}");
      } catch {
        parsed = null;
      }
    }
    const startsAt = String(parsed?.startsAt || "").trim();
    const ms = Date.parse(startsAt);
    if (Number.isFinite(ms)) {
      const durationMs = durationFromLatched(parsed);
      memoryGiveawayWindow = {
        startsAt: new Date(ms).toISOString(),
        durationMs,
      };
      return { startMs: ms, durationMs };
    }
  } catch {
    // fall through — latch a new start
  }
  return null;
}

async function latchStart(nowMs, durationMs = GIVEAWAY_DURATION_MS) {
  const startsAt = new Date(nowMs).toISOString();
  const dur = Math.max(60_000, Number(durationMs) || GIVEAWAY_DURATION_MS);
  memoryGiveawayWindow = { startsAt, durationMs: dur };
  const payload = JSON.stringify(
    {
      startsAt,
      durationMs: dur,
      latchedAt: startsAt,
    },
    null,
    2
  );
  try {
    const { durableWrite } = await import("../_durableJson.js");
    await durableWrite({
      raw: payload,
      blobPath: GIVEAWAY_WINDOW_BLOB,
      firebasePath: GIVEAWAY_WINDOW_FIREBASE,
      githubPath: GIVEAWAY_WINDOW_GITHUB,
      localPaths: ["data/giveaway-window.json"],
      githubMode: "fallback",
      message: `giveaway window start ${startsAt}`,
    });
  } catch {
    // memory latch still works for this instance
  }
  return { startMs: nowMs, durationMs: dur };
}

/**
 * Persist an extension (e.g. +4 days) onto the latched window without
 * resetting the original start time.
 */
export async function extendGiveawayWindowByDays(days = 4, nowMs = Date.now()) {
  const addMs = Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000;
  const latched = await readLatchedWindow();
  const startMs = latched?.startMs || nowMs;
  const prevDur = latched?.durationMs || GIVEAWAY_DURATION_MS;
  const nextDur = Math.max(prevDur + addMs, GIVEAWAY_DURATION_MS);
  const startsAt = new Date(startMs).toISOString();
  memoryGiveawayWindow = { startsAt, durationMs: nextDur };
  const payload = JSON.stringify(
    {
      startsAt,
      durationMs: nextDur,
      latchedAt: startsAt,
      extendedAt: new Date(nowMs).toISOString(),
      extendedByDays: Number(days) || 0,
    },
    null,
    2
  );
  try {
    const { durableWrite } = await import("../_durableJson.js");
    await durableWrite({
      raw: payload,
      blobPath: GIVEAWAY_WINDOW_BLOB,
      firebasePath: GIVEAWAY_WINDOW_FIREBASE,
      githubPath: GIVEAWAY_WINDOW_GITHUB,
      localPaths: ["data/giveaway-window.json"],
      githubMode: "fallback",
      message: `chore: extend giveaway window by ${days} days`,
    });
  } catch {
    // memory still holds the extension for this instance
  }
  return windowFromStart(startMs, nowMs, nextDur);
}

/**
 * Resolve the shared giveaway window (latches start on first live hit if unset).
 */
export async function resolveGiveawayWindow(nowMs = Date.now()) {
  const envStart = Date.parse(GIVEAWAY_STARTS_AT_ENV);
  if (Number.isFinite(envStart)) {
    return windowFromStart(envStart, nowMs, GIVEAWAY_DURATION_MS);
  }
  let latched = await readLatchedWindow();
  if (!latched || !Number.isFinite(latched.startMs)) {
    latched = await latchStart(nowMs);
  }
  // If storage still has the original 24h duration, bump to the extended default
  // so redeploying this build lengthens the live offer without a new start.
  const durationMs = Math.max(latched.durationMs || 0, GIVEAWAY_DURATION_MS);
  if (durationMs > (latched.durationMs || 0)) {
    const startsAt = new Date(latched.startMs).toISOString();
    memoryGiveawayWindow = { startsAt, durationMs };
    // Best-effort persist so Firebase/Blob stop serving the short window.
    try {
      const { durableWrite } = await import("../_durableJson.js");
      await durableWrite({
        raw: JSON.stringify(
          {
            startsAt,
            durationMs,
            latchedAt: startsAt,
            extendedAt: new Date(nowMs).toISOString(),
            extendedByDays: 4,
          },
          null,
          2
        ),
        blobPath: GIVEAWAY_WINDOW_BLOB,
        firebasePath: GIVEAWAY_WINDOW_FIREBASE,
        githubPath: GIVEAWAY_WINDOW_GITHUB,
        localPaths: ["data/giveaway-window.json"],
        githubMode: "fallback",
        message: "chore: extend giveaway window by 4 days",
      });
    } catch {
      // memory bump still applies for this instance
    }
  }
  return windowFromStart(latched.startMs, nowMs, durationMs);
}

/** Throws 403/410 when the giveaway link is outside its offer window. */
export async function assertGiveawayActive(nowMs = Date.now()) {
  const window = await resolveGiveawayWindow(nowMs);
  if (window.notStarted) {
    const err = new Error("This giveaway has not started yet");
    err.status = 403;
    err.data = { giveaway: window };
    throw err;
  }
  if (window.expired) {
    const err = new Error(
      "This giveaway has ended — the link no longer works"
    );
    err.status = 410;
    err.data = { giveaway: window };
    throw err;
  }
  return window;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function randomLicenseKey(existingKeys = new Set()) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chunk = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(
      ""
    );
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const key = `APEX-${chunk()}-${chunk()}`;
    if (!existingKeys.has(normalizeLicenseKey(key))) return key;
  }
  return `APEX-${chunk()}-${chunk()}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

function amountEquals(value, expected) {
  const v = String(value || "").trim();
  const e = String(expected || "").trim();
  if (!v || !e) return false;
  if (v === e) return true;
  return Number(v) === Number(e);
}

export function amountsMatchRobot(value, currency) {
  const c = String(currency || "").trim().toUpperCase();
  if (!c) return false;
  // Orders API checkout (this PayPal app only supports USD).
  if (c === ROBOT_CURRENCY && amountEquals(value, ROBOT_PRICE)) return true;
  // zetascalperai.com NCP payment links (R1500 ZAR).
  if (c === ROBOT_NCP_CURRENCY && amountEquals(value, ROBOT_NCP_PRICE)) return true;
  return false;
}

export function amountsMatchGiveaway(value, currency) {
  const c = String(currency || "").trim().toUpperCase();
  if (!c) return false;
  if (c === GIVEAWAY_CURRENCY && amountEquals(value, GIVEAWAY_PRICE)) return true;
  // Soft match display ZAR if someone pays via a ZAR link later.
  if (
    c === GIVEAWAY_DISPLAY_CURRENCY &&
    amountEquals(value, GIVEAWAY_DISPLAY_PRICE)
  ) {
    return true;
  }
  return false;
}

export function extractCaptureId(captureOrResource) {
  return String(
    captureOrResource?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      captureOrResource?.id ||
      ""
  ).trim();
}

export function extractCaptureAmount(captureOrResource) {
  const unit = captureOrResource?.purchase_units?.[0];
  const amount =
    unit?.payments?.captures?.[0]?.amount ||
    unit?.amount ||
    captureOrResource?.amount ||
    null;
  return {
    value: String(amount?.value || "").trim(),
    currency: String(amount?.currency_code || "").trim().toUpperCase(),
  };
}

/**
 * Detect robot purpose from Orders custom_id OR amount (NCP payment links).
 */
export function isRobotPurchaseCapture(capture, { purposeHint = "" } = {}) {
  const custom =
    capture?.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ||
    capture?.purchase_units?.[0]?.custom_id ||
    "";
  const raw = String(custom || purposeHint || "").toLowerCase();
  if (raw.startsWith("giveaway:")) return false;
  if (raw.startsWith("robot:") || raw.startsWith("license:")) return true;

  const { value, currency } = extractCaptureAmount(capture);
  if (amountsMatchGiveaway(value, currency)) return false;
  if (amountsMatchRobot(value, currency)) return true;

  // NCP soft descriptors / invoice sometimes embed the link id.
  const blob = JSON.stringify(capture || {}).toUpperCase();
  return ROBOT_NCP_LINK_IDS.some((id) => id && blob.includes(id));
}

/**
 * Giveaway Orders custom_id OR $25 / R350 amount.
 * Fulfillment is the same as robot (access + license key email).
 */
export function isGiveawayPurchaseCapture(capture, { purposeHint = "" } = {}) {
  const custom =
    capture?.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ||
    capture?.purchase_units?.[0]?.custom_id ||
    "";
  const raw = String(custom || purposeHint || "").toLowerCase();
  if (
    raw === "giveaway" ||
    raw.startsWith("giveaway:") ||
    raw.startsWith("promo:")
  ) {
    return true;
  }
  const { value, currency } = extractCaptureAmount(capture);
  return amountsMatchGiveaway(value, currency);
}

async function resolveMentor() {
  const email = ROBOT_MENTOR_EMAIL || normalizeEmail(SUPER_ADMIN_EMAIL);
  let mentorId = "";
  let mentorName = "ZETA SCALPER AI";
  try {
    const mentors = await listMentors();
    const hit = (Array.isArray(mentors) ? mentors : []).find(
      (m) => normalizeEmail(m.email) === email
    );
    if (hit) {
      mentorId = String(hit.id || "").trim();
      mentorName = String(hit.username || mentorName).trim() || mentorName;
    }
  } catch {
    // defaults
  }
  return { mentorEmail: email, mentorId, mentorName };
}

function findPurchaseLicense(licenses, { buyer, captureKey, orderKey } = {}) {
  const rows = Array.isArray(licenses) ? licenses : [];
  if (captureKey) {
    const byCapture = rows
      .filter(
        (row) => String(row?.purchaseCaptureId || "").trim() === captureKey
      )
      .sort(
        (a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0)
      );
    if (byCapture[0]?.key) return byCapture[0];
  }
  if (orderKey && buyer) {
    const byOrder = rows
      .filter(
        (row) =>
          normalizeEmail(row?.clientEmail) === buyer &&
          String(row?.botId || "").trim() === ROBOT_BOT_ID &&
          String(row?.purchaseOrderId || "").trim() === orderKey
      )
      .sort(
        (a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0)
      );
    if (byOrder[0]?.key) return byOrder[0];
  }
  return null;
}

async function ensurePurchaseEmail(license) {
  if (!license?.key) return { ok: false, error: "License key missing" };
  if (Number(license.emailSentAt)) {
    return {
      ok: true,
      skipped: true,
      reason: "already-sent",
      emailSentAt: Number(license.emailSentAt),
    };
  }
  try {
    return await sendLicenseKeyEmailOnce(license, { force: false });
  } catch (error) {
    return { ok: false, error: error?.message || "Email send failed" };
  }
}

/**
 * After PayPal confirms robot money: unlock app access + mint key + email via Brevo.
 * Idempotent on captureId / orderId; retries Brevo when emailSentAt is missing.
 */
export async function fulfillRobotPurchase({
  email,
  clientName = "",
  captureId = "",
  orderId = "",
  source = "paypal",
} = {}) {
  const buyer = normalizeEmail(email);
  if (!buyer || !buyer.includes("@")) {
    const err = new Error("Paid, but no buyer email was found");
    err.status = 400;
    throw err;
  }

  const name =
    String(clientName || "").trim() ||
    buyer.split("@")[0] ||
    "Client";
  const captureKey = String(captureId || "").trim();
  const orderKey = String(orderId || "").trim();

  // Unlock access first so a later license/email glitch does not strand a payer.
  await upsertSignup(buyer, { status: "pending" });
  await setSignupAccessPaid(buyer, true);

  // Idempotent: same PayPal capture / order must not mint a second key.
  try {
    const licenses = await listLicenses({ preferFresh: true });
    const existing = findPurchaseLicense(licenses, {
      buyer,
      captureKey,
      orderKey,
    });
    if (existing?.key) {
      const emailResult = await ensurePurchaseEmail(existing);
      return {
        ok: true,
        reused: true,
        email: buyer,
        license: Number(emailResult?.emailSentAt)
          ? { ...existing, emailSentAt: emailResult.emailSentAt }
          : existing,
        key: existing.key,
        emailResult,
      };
    }
  } catch {
    // continue to create
  }

  const mentor = await resolveMentor();
  let existingKeys = new Set();
  try {
    const licenses = await listLicenses({ preferFresh: true });
    existingKeys = new Set(
      (licenses || []).map((row) => normalizeLicenseKey(row.key)).filter(Boolean)
    );
  } catch {
    existingKeys = new Set();
  }

  const key = randomLicenseKey(existingKeys);
  let license;
  let createError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      license = await createLicense({
        key: attempt === 0 ? key : randomLicenseKey(existingKeys),
        botId: ROBOT_BOT_ID,
        botName: ROBOT_BOT_NAME,
        clientEmail: buyer,
        clientName: name,
        mainText: name,
        mentorEmail: mentor.mentorEmail,
        mentorId: mentor.mentorId,
        mentorName: mentor.mentorName,
        duration: "lifetime",
        sendEmail: true,
        skipQuota: true,
        purchaseCaptureId: captureKey || null,
        purchaseOrderId: orderKey || null,
        purchaseSource: source,
        bot: {
          id: ROBOT_BOT_ID,
          name: ROBOT_BOT_NAME,
          photo: `/api/licenses/photo?botId=${encodeURIComponent(ROBOT_BOT_ID)}`,
          strategy: "scalper",
          symbols: [],
        },
      });
      createError = null;
      break;
    } catch (error) {
      createError = error;
      // Durable 503 / conflict — brief wait then retry (buyer already paid).
      if (error?.status === 503 || error?.status === 409) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  if (!license) {
    // Last chance: another concurrent fulfill may have written the key.
    try {
      const licenses = await listLicenses({ preferFresh: true });
      const raced = findPurchaseLicense(licenses, {
        buyer,
        captureKey,
        orderKey,
      });
      if (raced?.key) {
        const emailResult = await ensurePurchaseEmail(raced);
        return {
          ok: true,
          reused: true,
          email: buyer,
          license: raced,
          key: raced.key,
          emailResult,
        };
      }
    } catch {
      // fall through
    }
    throw createError || new Error("Could not create license after payment");
  }

  // Capture + webhook race: prefer the oldest key for this capture.
  if (captureKey && license?._createdNew) {
    try {
      await new Promise((r) => setTimeout(r, 250));
      const licenses = await listLicenses({ preferFresh: true });
      const primary = findPurchaseLicense(licenses, {
        buyer,
        captureKey,
        orderKey,
      });
      if (primary?.key && primary.key !== license.key) {
        const emailResult = await ensurePurchaseEmail(primary);
        return {
          ok: true,
          reused: true,
          email: buyer,
          license: primary,
          key: primary.key,
          emailResult,
        };
      }
    } catch {
      // keep newly created license
    }
  }

  let emailResult = license?._email || null;
  if (!Number(license?.emailSentAt)) {
    emailResult = await ensurePurchaseEmail(license);
    if (emailResult?.emailSentAt) {
      license = { ...license, emailSentAt: emailResult.emailSentAt };
    }
  }

  return {
    ok: true,
    reused: Boolean(license?._createdNew === false),
    email: buyer,
    license,
    key: license?.key || key,
    emailResult,
  };
}
