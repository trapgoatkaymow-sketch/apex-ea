/**
 * Auto-fulfill ZETA SCALPER AI robot purchases from PayPal.
 * Same PayPal account as app-access; distinguished by purpose/amount.
 */
import { createLicense, listLicenses, normalizeLicenseKey } from "../licenses/_lib.js";
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
 * 24-hour giveaway window.
 * - If GIVEAWAY_STARTS_AT is set on Vercel, that ISO time is the start.
 * - Otherwise the first live request latches "now" into durable storage so the
 *   offer ends exactly 24 hours later in real time.
 */
export const GIVEAWAY_STARTS_AT_ENV = String(
  process.env.GIVEAWAY_STARTS_AT || ""
).trim();
export const GIVEAWAY_DURATION_MS = Math.max(
  60_000,
  (Number(process.env.GIVEAWAY_DURATION_HOURS) || 24) * 60 * 60 * 1000
);

const GIVEAWAY_WINDOW_BLOB = "apexea/giveaway-window.json";
const GIVEAWAY_WINDOW_GITHUB = "data/giveaway-window.json";

/** @type {{ startsAt: string } | null} */
let memoryGiveawayWindow = null;

function windowFromStart(startMs, nowMs = Date.now()) {
  const endMs = startMs + GIVEAWAY_DURATION_MS;
  const remainingMs = Math.max(0, endMs - nowMs);
  const notStarted = nowMs < startMs;
  const expired = nowMs >= endMs;
  return {
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    durationMs: GIVEAWAY_DURATION_MS,
    remainingMs,
    active: !notStarted && !expired,
    expired,
    notStarted,
    serverNow: new Date(nowMs).toISOString(),
  };
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
    nowMs
  );
}

async function readLatchedStart() {
  if (memoryGiveawayWindow?.startsAt) {
    const ms = Date.parse(memoryGiveawayWindow.startsAt);
    if (Number.isFinite(ms)) return ms;
  }
  try {
    const { durableRead } = await import("../_durableJson.js");
    const doc = await durableRead({
      blobPath: GIVEAWAY_WINDOW_BLOB,
      githubPath: GIVEAWAY_WINDOW_GITHUB,
      localPaths: ["data/giveaway-window.json"],
    });
    let startsAt = "";
    if (doc?.raw) {
      try {
        const parsed = JSON.parse(doc.raw || "{}");
        startsAt = String(parsed?.startsAt || "").trim();
      } catch {
        startsAt = "";
      }
    }
    const ms = Date.parse(startsAt);
    if (Number.isFinite(ms)) {
      memoryGiveawayWindow = { startsAt: new Date(ms).toISOString() };
      return ms;
    }
  } catch {
    // fall through — latch a new start
  }
  return null;
}

async function latchStart(nowMs) {
  const startsAt = new Date(nowMs).toISOString();
  memoryGiveawayWindow = { startsAt };
  const payload = JSON.stringify(
    {
      startsAt,
      durationMs: GIVEAWAY_DURATION_MS,
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
      githubPath: GIVEAWAY_WINDOW_GITHUB,
      localPaths: ["data/giveaway-window.json"],
      message: `giveaway window start ${startsAt}`,
    });
  } catch {
    // memory latch still works for this instance
  }
  return nowMs;
}

/**
 * Resolve the shared 24h window (latches start on first live hit if unset).
 */
export async function resolveGiveawayWindow(nowMs = Date.now()) {
  const envStart = Date.parse(GIVEAWAY_STARTS_AT_ENV);
  if (Number.isFinite(envStart)) {
    return windowFromStart(envStart, nowMs);
  }
  let startMs = await readLatchedStart();
  if (!Number.isFinite(startMs)) {
    startMs = await latchStart(nowMs);
  }
  return windowFromStart(startMs, nowMs);
}

/** Throws 403/410 when the giveaway link is outside its 24h window. */
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
      "This 24-hour giveaway has ended — the link no longer works"
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

/**
 * After PayPal confirms robot money: unlock app access + mint key + email via Brevo.
 * Idempotent on captureId / existing unused key for same email+bot.
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

  // Idempotent: same PayPal capture must not mint a second key.
  if (captureKey) {
    try {
      const licenses = await listLicenses({ preferFresh: true });
      const existing = (licenses || []).find(
        (row) =>
          String(row?.purchaseCaptureId || "").trim() === captureKey ||
          (normalizeEmail(row?.clientEmail) === buyer &&
            String(row?.botId || "").trim() === ROBOT_BOT_ID &&
            String(row?.purchaseOrderId || "").trim() === orderKey &&
            orderKey)
      );
      if (existing?.key) {
        return {
          ok: true,
          reused: true,
          email: buyer,
          license: existing,
          key: existing.key,
        };
      }
    } catch {
      // continue to create
    }
  }

  await upsertSignup(buyer, { status: "pending" });
  // Robot purchase also unlocks app access (same PayPal / one-time lifetime).
  await setSignupAccessPaid(buyer, true);

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
  const license = await createLicense({
    key,
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

  return {
    ok: true,
    reused: false,
    email: buyer,
    license,
    key: license?.key || key,
    emailResult: license?._email || null,
  };
}
