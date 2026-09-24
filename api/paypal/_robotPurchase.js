/**
 * Auto-fulfill ZETA SCALPER AI robot purchases from PayPal.
 * Same PayPal account as app-access; distinguished by purpose/amount.
 */
import { createLicense, listLicenses, normalizeLicenseKey } from "../licenses/_lib.js";
import { setSignupAccessPaid, upsertSignup } from "../signups/_lib.js";
import { listMentors, SUPER_ADMIN_EMAIL } from "../mentors/_lib.js";

export const ROBOT_PRICE = String(process.env.ROBOT_PURCHASE_PRICE || "82.50").trim();
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
  if (raw.startsWith("robot:") || raw.startsWith("license:")) return true;

  const { value, currency } = extractCaptureAmount(capture);
  if (amountsMatchRobot(value, currency)) return true;

  // NCP soft descriptors / invoice sometimes embed the link id.
  const blob = JSON.stringify(capture || {}).toUpperCase();
  return ROBOT_NCP_LINK_IDS.some((id) => id && blob.includes(id));
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
