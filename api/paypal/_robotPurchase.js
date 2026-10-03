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

/**
 * @type {{
 *   startsAt: string,
 *   durationMs?: number,
 *   countdownEndsAt?: string,
 *   countdownVersion?: number,
 *   purchasesEndAt?: string,
 * } | null}
 */
let memoryGiveawayWindow = null;

/** Display-only urgency window — checkout stays open after this elapses. */
export const GIVEAWAY_COUNTDOWN_HOURS = Math.max(
  1,
  Number(process.env.GIVEAWAY_COUNTDOWN_HOURS) || 17
);
/** Bump to force a fresh on-page countdown latch (checkout stays open). */
export const GIVEAWAY_COUNTDOWN_VERSION = 5;

function countdownFromLatched(row) {
  const ms = Date.parse(String(row?.countdownEndsAt || "").trim());
  return Number.isFinite(ms) ? ms : null;
}

function purchasesEndFromLatched(row) {
  const ms = Date.parse(String(row?.purchasesEndAt || "").trim());
  return Number.isFinite(ms) ? ms : null;
}

function windowFromStart(
  startMs,
  nowMs = Date.now(),
  durationMs = GIVEAWAY_DURATION_MS,
  countdownEndsAtMs = null,
  purchasesEndAtMs = null
) {
  const dur = Math.max(60_000, Number(durationMs) || GIVEAWAY_DURATION_MS);
  // Hard checkout close (optional). Display countdown is separate.
  const purchaseEndMs = Number.isFinite(purchasesEndAtMs)
    ? purchasesEndAtMs
    : startMs + dur;
  const displayEndMs = Number.isFinite(countdownEndsAtMs)
    ? countdownEndsAtMs
    : purchaseEndMs;
  // Live countdown prefers the hard special end when it is still ahead.
  const liveCountdownEndMs =
    Number.isFinite(purchasesEndAtMs) && purchasesEndAtMs > nowMs
      ? purchasesEndAtMs
      : displayEndMs;
  const remainingMs = Math.max(0, liveCountdownEndMs - nowMs);
  const notStarted = nowMs < startMs;
  const countdownExpired = nowMs >= displayEndMs;
  const purchasesExpired = nowMs >= purchaseEndMs;
  // Checkout stays open after the on-page timer hits zero, until purchasesEndAt.
  const purchaseOpen = !notStarted && !purchasesExpired;
  return {
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(liveCountdownEndMs).toISOString(),
    countdownEndsAt: new Date(displayEndMs).toISOString(),
    purchasesEndAt: new Date(purchaseEndMs).toISOString(),
    durationMs: dur,
    remainingMs,
    active: purchaseOpen,
    // Countdown hitting zero is not “expired” for checkout.
    expired: purchasesExpired,
    countdownExpired,
    purchasesExpired,
    purchaseOpen,
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
    durationFromLatched(memoryGiveawayWindow),
    countdownFromLatched(memoryGiveawayWindow),
    purchasesEndFromLatched(memoryGiveawayWindow)
  );
}

async function readLatchedWindow() {
  // Always re-read durable so ops extensions (e.g. +12h) win over warm memory.
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
      let countdownEndsAtMs = countdownFromLatched(parsed);
      let purchasesEndAtMs = purchasesEndFromLatched(parsed);
      const countdownVersion = Number(parsed?.countdownVersion) || 0;
      // If warm memory has a later countdown (just extended this instance), keep it.
      const memEnd = countdownFromLatched(memoryGiveawayWindow);
      if (Number.isFinite(memEnd) && (!Number.isFinite(countdownEndsAtMs) || memEnd > countdownEndsAtMs)) {
        countdownEndsAtMs = memEnd;
      }
      const memPurchasesEnd = purchasesEndFromLatched(memoryGiveawayWindow);
      if (
        Number.isFinite(memPurchasesEnd) &&
        (!Number.isFinite(purchasesEndAtMs) || memPurchasesEnd > purchasesEndAtMs)
      ) {
        purchasesEndAtMs = memPurchasesEnd;
      }
      memoryGiveawayWindow = {
        startsAt: new Date(ms).toISOString(),
        durationMs,
        countdownVersion: Math.max(
          countdownVersion,
          Number(memoryGiveawayWindow?.countdownVersion) || 0
        ),
        ...(Number.isFinite(countdownEndsAtMs)
          ? { countdownEndsAt: new Date(countdownEndsAtMs).toISOString() }
          : {}),
        ...(Number.isFinite(purchasesEndAtMs)
          ? { purchasesEndAt: new Date(purchasesEndAtMs).toISOString() }
          : {}),
      };
      return {
        startMs: ms,
        durationMs,
        countdownEndsAtMs,
        purchasesEndAtMs,
        countdownVersion: memoryGiveawayWindow.countdownVersion,
      };
    }
  } catch {
    // fall through — memory / latch
  }
  if (memoryGiveawayWindow?.startsAt) {
    const ms = Date.parse(memoryGiveawayWindow.startsAt);
    if (Number.isFinite(ms)) {
      return {
        startMs: ms,
        durationMs: durationFromLatched(memoryGiveawayWindow),
        countdownEndsAtMs: countdownFromLatched(memoryGiveawayWindow),
        purchasesEndAtMs: purchasesEndFromLatched(memoryGiveawayWindow),
        countdownVersion: Number(memoryGiveawayWindow.countdownVersion) || 0,
      };
    }
  }
  return null;
}

async function writeGiveawayWindowDoc(doc, message) {
  const startsAt = String(doc?.startsAt || "").trim();
  const durationMs = Math.max(
    60_000,
    Number(doc?.durationMs) || GIVEAWAY_DURATION_MS
  );
  const countdownEndsAt = String(doc?.countdownEndsAt || "").trim();
  const purchasesEndAt = String(doc?.purchasesEndAt || "").trim();
  memoryGiveawayWindow = {
    startsAt,
    durationMs,
    countdownVersion:
      Number(doc?.countdownVersion) || GIVEAWAY_COUNTDOWN_VERSION,
    ...(countdownEndsAt ? { countdownEndsAt } : {}),
    ...(purchasesEndAt ? { purchasesEndAt } : {}),
  };
  const payload = JSON.stringify(
    {
      startsAt,
      durationMs,
      latchedAt: String(doc?.latchedAt || startsAt),
      ...(countdownEndsAt ? { countdownEndsAt } : {}),
      ...(purchasesEndAt ? { purchasesEndAt } : {}),
      ...(doc?.extendedAt ? { extendedAt: doc.extendedAt } : {}),
      ...(doc?.extendedByDays != null
        ? { extendedByDays: doc.extendedByDays }
        : {}),
      ...(doc?.extendedByHours != null
        ? { extendedByHours: doc.extendedByHours }
        : {}),
      ...(doc?.countdownSetAt ? { countdownSetAt: doc.countdownSetAt } : {}),
      countdownVersion:
        Number(doc?.countdownVersion) || GIVEAWAY_COUNTDOWN_VERSION,
      purchasesOpenAfterCountdown: true,
    },
    null,
    2
  );
  try {
    const { durableWrite } = await import("../_durableJson.js");
    await durableWrite({
      raw: payload + "\n",
      blobPath: GIVEAWAY_WINDOW_BLOB,
      firebasePath: GIVEAWAY_WINDOW_FIREBASE,
      githubPath: GIVEAWAY_WINDOW_GITHUB,
      localPaths: ["data/giveaway-window.json"],
      githubMode: "fallback",
      message: message || `giveaway window ${startsAt}`,
    });
  } catch {
    // memory latch still works for this instance
  }
  return {
    startMs: Date.parse(startsAt),
    durationMs,
    countdownEndsAtMs: countdownFromLatched({ countdownEndsAt }),
    purchasesEndAtMs: purchasesEndFromLatched({ purchasesEndAt }),
  };
}

async function latchStart(nowMs, durationMs = GIVEAWAY_DURATION_MS) {
  const startsAt = new Date(nowMs).toISOString();
  const dur = Math.max(60_000, Number(durationMs) || GIVEAWAY_DURATION_MS);
  const countdownEndsAt = new Date(
    nowMs + GIVEAWAY_COUNTDOWN_HOURS * 60 * 60 * 1000
  ).toISOString();
  return writeGiveawayWindowDoc(
    {
      startsAt,
      durationMs: dur,
      latchedAt: startsAt,
      countdownEndsAt,
      countdownSetAt: startsAt,
    },
    `giveaway window start ${startsAt}`
  );
}

function purchasesEndFields(latchedOrMs) {
  const ms =
    typeof latchedOrMs === "number"
      ? latchedOrMs
      : Number(latchedOrMs?.purchasesEndAtMs);
  if (!Number.isFinite(ms)) return {};
  return { purchasesEndAt: new Date(ms).toISOString() };
}

/**
 * Reset the on-page countdown to N hours from now.
 * Checkout stays open after the timer hits zero (until purchasesEndAt).
 */
export async function setGiveawayCountdownHours(
  hours = GIVEAWAY_COUNTDOWN_HOURS,
  nowMs = Date.now()
) {
  const hrs = Math.max(1, Number(hours) || GIVEAWAY_COUNTDOWN_HOURS);
  const latched = await readLatchedWindow();
  const startMs = latched?.startMs || nowMs;
  const durationMs = Math.max(
    latched?.durationMs || 0,
    GIVEAWAY_DURATION_MS,
    // Keep purchase window far past the short display countdown.
    hrs * 60 * 60 * 1000 * 100
  );
  const countdownEndsAt = new Date(nowMs + hrs * 60 * 60 * 1000).toISOString();
  const startsAt = new Date(startMs).toISOString();
  const purchasesEndAtMs = latched?.purchasesEndAtMs;
  await writeGiveawayWindowDoc(
    {
      startsAt,
      durationMs,
      latchedAt: startsAt,
      countdownEndsAt,
      countdownSetAt: new Date(nowMs).toISOString(),
      countdownVersion: GIVEAWAY_COUNTDOWN_VERSION,
      extendedAt: new Date(nowMs).toISOString(),
      extendedByDays: 0,
      ...purchasesEndFields(purchasesEndAtMs),
    },
    `chore: set giveaway countdown to ${hrs}h`
  );
  return windowFromStart(
    startMs,
    nowMs,
    durationMs,
    Date.parse(countdownEndsAt),
    purchasesEndAtMs
  );
}

/**
 * Add hours onto the current display countdown (from remaining end, or now if past).
 * Checkout stays open after the timer hits zero (until purchasesEndAt).
 */
export async function extendGiveawayCountdownByHours(
  hours = 12,
  nowMs = Date.now()
) {
  const hrs = Math.max(1, Number(hours) || 12);
  const addMs = hrs * 60 * 60 * 1000;
  const latched = await readLatchedWindow();
  const startMs = latched?.startMs || nowMs;
  const prevEnd = Number.isFinite(latched?.countdownEndsAtMs)
    ? latched.countdownEndsAtMs
    : nowMs;
  const prevPurchasesEnd = Number.isFinite(latched?.purchasesEndAtMs)
    ? latched.purchasesEndAtMs
    : prevEnd;
  // Extend from whichever is later (remaining end or now if already closed).
  const nextEnd = Math.max(prevEnd, prevPurchasesEnd, nowMs) + addMs;
  const durationMs = Math.max(
    latched?.durationMs || 0,
    GIVEAWAY_DURATION_MS,
    addMs * 10,
    nextEnd - startMs
  );
  const startsAt = new Date(startMs).toISOString();
  const countdownEndsAt = new Date(nextEnd).toISOString();
  const purchasesEndAtMs = nextEnd;
  await writeGiveawayWindowDoc(
    {
      startsAt,
      durationMs,
      latchedAt: startsAt,
      countdownEndsAt,
      countdownSetAt: new Date(nowMs).toISOString(),
      countdownVersion: Math.max(
        Number(latched?.countdownVersion) || 0,
        GIVEAWAY_COUNTDOWN_VERSION
      ),
      extendedAt: new Date(nowMs).toISOString(),
      extendedByDays: 0,
      extendedByHours: hrs,
      ...purchasesEndFields(purchasesEndAtMs),
    },
    `chore: extend giveaway countdown by ${hrs}h`
  );
  return windowFromStart(
    startMs,
    nowMs,
    durationMs,
    nextEnd,
    purchasesEndAtMs
  );
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
  const countdownEndsAtMs = latched?.countdownEndsAtMs;
  const purchasesEndAtMs = Number.isFinite(latched?.purchasesEndAtMs)
    ? Math.max(latched.purchasesEndAtMs, startMs + nextDur)
    : startMs + nextDur;
  await writeGiveawayWindowDoc(
    {
      startsAt,
      durationMs: nextDur,
      latchedAt: startsAt,
      extendedAt: new Date(nowMs).toISOString(),
      extendedByDays: Number(days) || 0,
      ...(Number.isFinite(countdownEndsAtMs)
        ? { countdownEndsAt: new Date(countdownEndsAtMs).toISOString() }
        : {}),
      ...purchasesEndFields(purchasesEndAtMs),
    },
    `chore: extend giveaway window by ${days} days`
  );
  return windowFromStart(
    startMs,
    nowMs,
    nextDur,
    countdownEndsAtMs,
    purchasesEndAtMs
  );
}

async function readPackagedGiveawayWindow() {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const { fileURLToPath } = await import("url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const localPath = path.resolve(here, "../../data/giveaway-window.json");
    if (!fs.existsSync(localPath)) return null;
    return JSON.parse(fs.readFileSync(localPath, "utf8") || "{}");
  } catch {
    return null;
  }
}

/**
 * Resolve the shared giveaway window (latches start on first live hit if unset).
 * Display countdown is separate from checkout — payments stay open after zero
 * until purchasesEndAt (if set).
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
  const packaged = await readPackagedGiveawayWindow();
  const packagedPurchasesEnd = Date.parse(
    String(packaged?.purchasesEndAt || "")
  );
  const packagedDuration = Number(packaged?.durationMs) || 0;
  // Take the later hard close so ops Firebase/Blob extensions win over a
  // stale packaged end (and a newer packaged ship still wins when ahead).
  let purchasesEndAtMs = (() => {
    const candidates = [packagedPurchasesEnd, latched.purchasesEndAtMs].filter(
      (ms) => Number.isFinite(ms)
    );
    return candidates.length ? Math.max(...candidates) : null;
  })();
  let durationMs = Math.max(
    latched.durationMs || 0,
    packagedDuration || 0,
    Number.isFinite(purchasesEndAtMs)
      ? Math.max(60_000, purchasesEndAtMs - latched.startMs)
      : 0,
    // Only fall back to default duration when no hard close is configured.
    Number.isFinite(purchasesEndAtMs) ? 0 : GIVEAWAY_DURATION_MS
  );
  let countdownEndsAtMs = latched.countdownEndsAtMs;
  const storedVersion = Number(latched.countdownVersion) || 0;
  // Version bump latches a fresh countdown once per bump (v5 = +21h).
  if (
    !Number.isFinite(countdownEndsAtMs) ||
    storedVersion < GIVEAWAY_COUNTDOWN_VERSION
  ) {
    // Prefer packaged absolute countdown — including when already past (keep zeros).
    const packagedEnd = Date.parse(String(packaged?.countdownEndsAt || ""));
    const packagedVer = Number(packaged?.countdownVersion) || 0;
    if (
      packagedVer >= GIVEAWAY_COUNTDOWN_VERSION &&
      Number.isFinite(packagedEnd)
    ) {
      const startsAt = new Date(latched.startMs).toISOString();
      const hardEndMs = Number.isFinite(purchasesEndAtMs)
        ? Math.max(purchasesEndAtMs, packagedEnd)
        : packagedEnd;
      await writeGiveawayWindowDoc(
        {
          startsAt,
          durationMs: Math.max(durationMs, packagedDuration || 0),
          latchedAt: startsAt,
          countdownEndsAt: new Date(packagedEnd).toISOString(),
          countdownSetAt:
            String(packaged?.countdownSetAt || "").trim() ||
            new Date(nowMs).toISOString(),
          countdownVersion: GIVEAWAY_COUNTDOWN_VERSION,
          extendedAt: new Date(nowMs).toISOString(),
          extendedByHours:
            Number(packaged?.extendedByHours) || GIVEAWAY_COUNTDOWN_HOURS,
          extendedByDays: 0,
          ...purchasesEndFields(hardEndMs),
        },
        "chore: latch packaged giveaway countdown"
      );
      return windowFromStart(
        latched.startMs,
        nowMs,
        Math.max(durationMs, packagedDuration || 0),
        packagedEnd,
        hardEndMs
      );
    }
    // Fresh 17h display from deploy time only when packaged has no countdown.
    return await setGiveawayCountdownHours(GIVEAWAY_COUNTDOWN_HOURS, nowMs);
  }

  // Only latch when the resolved end/duration is strictly newer than durable —
  // never write a stale packaged end back over a live ops extension.
  const needsPurchasesLatch =
    Number.isFinite(purchasesEndAtMs) &&
    (!Number.isFinite(latched.purchasesEndAtMs) ||
      purchasesEndAtMs > latched.purchasesEndAtMs);
  const needsDurationLatch = durationMs > (latched.durationMs || 0);
  if (needsPurchasesLatch || needsDurationLatch) {
    const startsAt = new Date(latched.startMs).toISOString();
    await writeGiveawayWindowDoc(
      {
        startsAt,
        durationMs,
        latchedAt: startsAt,
        ...(Number.isFinite(countdownEndsAtMs)
          ? { countdownEndsAt: new Date(countdownEndsAtMs).toISOString() }
          : {}),
        countdownSetAt:
          String(packaged?.countdownSetAt || "").trim() || undefined,
        countdownVersion: storedVersion || GIVEAWAY_COUNTDOWN_VERSION,
        extendedAt: new Date(nowMs).toISOString(),
        extendedByHours: Number(packaged?.extendedByHours) || 0,
        extendedByDays: Number(packaged?.extendedByDays) || 0,
        ...purchasesEndFields(purchasesEndAtMs),
      },
      "chore: latch giveaway purchases end"
    );
  }
  return windowFromStart(
    latched.startMs,
    nowMs,
    durationMs,
    countdownEndsAtMs,
    purchasesEndAtMs
  );
}

/** Throws 403 when the giveaway has not started or purchasesEndAt has passed. */
export async function assertGiveawayActive(nowMs = Date.now()) {
  const window = await resolveGiveawayWindow(nowMs);
  if (window.notStarted) {
    const err = new Error("This giveaway has not started yet");
    err.status = 403;
    err.data = { giveaway: window };
    throw err;
  }
  if (window.purchaseOpen === false || window.purchasesExpired) {
    const err = new Error("This giveaway special has ended");
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

function purchaseMailPayload(license = {}) {
  return {
    ...license,
    // Always stamp Trapgoatkaymow so WhatsApp group is included.
    mentorEmail:
      String(license.mentorEmail || "").trim() || ROBOT_MENTOR_EMAIL,
    includeWhatsapp: true,
    forceWhatsapp: true,
  };
}

async function ensurePurchaseEmail(license, { force = false } = {}) {
  if (!license?.key) return { ok: false, error: "License key missing" };
  if (!force && Number(license.emailSentAt)) {
    return {
      ok: true,
      skipped: true,
      reason: "already-sent",
      emailSentAt: Number(license.emailSentAt),
    };
  }
  const mailLicense = purchaseMailPayload(license);
  let last = null;
  // Paid buyers must get the key + WhatsApp link — retry Brevo hard.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      last = await sendLicenseKeyEmailOnce(mailLicense, {
        force: force || attempt > 0,
      });
      if (last?.ok || Number(last?.emailSentAt)) return last;
    } catch (error) {
      last = { ok: false, error: error?.message || "Email send failed" };
    }
    // Fallback: call Brevo directly (bypass claim races) then stamp.
    try {
      const { sendLicenseKeyEmail } = await import("../_brevo.js");
      const direct = await sendLicenseKeyEmail(mailLicense);
      if (direct?.ok) {
        try {
          const { markLicenseEmailSent } = await import("../licenses/_lib.js");
          const stamp = Date.now();
          await markLicenseEmailSent(mailLicense.key, stamp);
          return { ...direct, emailSentAt: stamp };
        } catch {
          return { ...direct, emailSentAt: Date.now() };
        }
      }
      last = direct || last;
    } catch (error) {
      last = { ok: false, error: error?.message || "Email send failed" };
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  return last || { ok: false, error: "Email send failed" };
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
      let emailResult = await ensurePurchaseEmail(existing);
      if (!(emailResult?.ok || Number(emailResult?.emailSentAt) || Number(existing.emailSentAt))) {
        emailResult = await ensurePurchaseEmail(existing, { force: true });
      }
      const license = Number(emailResult?.emailSentAt)
        ? { ...existing, emailSentAt: emailResult.emailSentAt }
        : existing;
      return {
        ok: true,
        reused: true,
        email: buyer,
        license,
        key: existing.key,
        emailResult,
        emailSent: Boolean(
          emailResult?.ok || Number(license?.emailSentAt)
        ),
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
        // Paid buyers must get Brevo synchronously here (not deferred).
        sendEmail: true,
        asyncEmail: false,
        skipQuota: true,
        purchaseCaptureId: captureKey || null,
        purchaseOrderId: orderKey || null,
        purchaseSource: source,
        purchasePaid: true,
        purchasePaidAt: Date.now(),
        purchaseAmount: String(source || "")
          .toLowerCase()
          .includes("giveaway")
          ? GIVEAWAY_PRICE
          : ROBOT_PRICE,
        purchaseCurrency: String(source || "")
          .toLowerCase()
          .includes("giveaway")
          ? GIVEAWAY_CURRENCY
          : ROBOT_CURRENCY,
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
  if (!Number(license?.emailSentAt) && !(emailResult?.ok || Number(emailResult?.emailSentAt))) {
    emailResult = await ensurePurchaseEmail(license);
  }
  // createLicense may have returned a soft email failure — force more passes.
  if (!Number(license?.emailSentAt) && !(emailResult?.ok || Number(emailResult?.emailSentAt))) {
    emailResult = await ensurePurchaseEmail(license, { force: true });
  }
  if (emailResult?.emailSentAt) {
    license = { ...license, emailSentAt: emailResult.emailSentAt };
  }

  return {
    ok: true,
    reused: Boolean(license?._createdNew === false),
    email: buyer,
    license,
    key: license?.key || key,
    emailResult,
    emailSent: Boolean(emailResult?.ok || Number(license?.emailSentAt)),
  };
}
