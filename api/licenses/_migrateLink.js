import crypto from "crypto";

function migrateSecret() {
  return (
    String(process.env.MIGRATE_LINK_SECRET || "").trim() ||
    String(process.env.LICENSES_STORE_TOKEN || "").trim() ||
    "apexea-migrate-link"
  );
}

function normalizeInvite(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Canonical payload for HMAC (order matters). */
export function migrateLinkPayload({ invite, botId, until }) {
  const code = normalizeInvite(invite);
  const bot = String(botId || "").trim();
  const exp = Number(until) || 0;
  return `v1|${code}|${bot}|${exp}`;
}

export function signMigrateLink({ invite, botId, until }) {
  const payload = migrateLinkPayload({ invite, botId, until });
  return crypto
    .createHmac("sha256", migrateSecret())
    .update(payload)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Timed free-migrate links must include until + sig.
 * Permanent mentor invite links (no until) stay valid.
 */
export function assertMigrateLinkFresh(payload = {}) {
  const until = Number(payload.until || payload.expiresAt || 0);
  const sig = String(payload.sig || payload.signature || "").trim().toLowerCase();
  if (!until && !sig) return { timed: false, until: 0 };

  if (!until || until < 1e12) {
    const err = new Error("This free migrate link is invalid");
    err.status = 400;
    throw err;
  }
  if (Date.now() > until) {
    const err = new Error(
      "This free migrate link expired — ask your mentor for a new one"
    );
    err.status = 410;
    throw err;
  }
  const expected = signMigrateLink({
    invite: payload.inviteCode || payload.invite,
    botId: payload.botId || payload.bot?.id,
    until,
  });
  if (!sig || !timingSafeEqual(sig, expected)) {
    const err = new Error("This free migrate link is invalid or tampered");
    err.status = 403;
    throw err;
  }
  return { timed: true, until };
}

export function buildMigrateLinkUrl({
  origin = "https://www.apex-ea.com",
  invite,
  botId,
  botName = "ZETA SCALPER AI",
  duration = "lifetime",
  minutes = 30,
}) {
  const until = Date.now() + Math.max(1, Number(minutes) || 30) * 60 * 1000;
  const code = normalizeInvite(invite);
  const bot = String(botId || "").trim();
  const sig = signMigrateLink({ invite: code, botId: bot, until });
  const url = new URL(String(origin || "https://www.apex-ea.com").replace(/\/$/, ""));
  url.searchParams.set("invite", code);
  url.searchParams.set("bot", bot);
  if (botName) url.searchParams.set("botName", botName);
  url.searchParams.set("duration", duration || "lifetime");
  url.searchParams.set("migrate", "1");
  url.searchParams.set("until", String(until));
  url.searchParams.set("sig", sig);
  return { url: url.toString(), until, sig, invite: code, botId: bot };
}
