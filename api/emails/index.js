import path from "path";
import { fileURLToPath } from "url";
import { endOptions } from "../_cors.js";
import {
  brevoConfigured,
  sendBrevoEmail,
  sendBroadcastEmails,
} from "../_brevo.js";
import { durableRead, durableWrite } from "../_durableJson.js";
import {
  listMentors,
  readJsonBody,
  sendJson,
  SUPER_ADMIN_EMAIL,
} from "../mentors/_lib.js";

export const config = { maxDuration: 60 };

/** Inbox that receives mentor commission withdrawal requests. */
export const WITHDRAWAL_REQUEST_EMAIL = "apexeaa@gmail.com";
/** Max withdrawal request emails a mentor can send per rolling week. */
export const WITHDRAW_MAX_PER_WEEK = 2;
export const WITHDRAW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_PATH =
  process.env.WITHDRAWAL_REQUESTS_FILE_PATH || "data/withdrawal-requests.json";
const BLOB_PATH =
  process.env.WITHDRAWAL_REQUESTS_BLOB_PATH || "apexea/withdrawal-requests.json";
const TMP_FILE = path.join("/tmp", "apexea-withdrawal-requests.json");
const BUNDLED_FILE = path.resolve(__dirname, "../../data/withdrawal-requests.json");

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function assertSuperAdmin(adminEmail) {
  const admin = normalizeEmail(adminEmail);
  const superAdmin = normalizeEmail(SUPER_ADMIN_EMAIL);
  if (!admin || admin !== superAdmin) {
    const err = new Error("Only super admin can send broadcast emails");
    err.status = 403;
    throw err;
  }
}

function escapeText(value) {
  return String(value || "").trim() || "—";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pruneTimestamps(list, now = Date.now()) {
  const floor = now - WITHDRAW_WINDOW_MS;
  return (Array.isArray(list) ? list : [])
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t) && t >= floor)
    .sort((a, b) => a - b);
}

async function readWithdrawStore() {
  const durable = await durableRead({
    blobPath: BLOB_PATH,
    githubPath: FILE_PATH,
    localPaths: [TMP_FILE, BUNDLED_FILE],
  });
  let byEmail = {};
  if (durable.raw != null) {
    try {
      const parsed = JSON.parse(durable.raw || "{}");
      if (parsed?.byEmail && typeof parsed.byEmail === "object") {
        byEmail = parsed.byEmail;
      }
    } catch {
      byEmail = {};
    }
  }
  return {
    byEmail,
    sha: durable.source === "github" ? durable.sha : null,
  };
}

async function writeWithdrawStore(byEmail, sha = null) {
  const payload = JSON.stringify(
    { byEmail, updatedAt: Date.now() },
    null,
    2
  );
  return durableWrite({
    raw: `${payload}\n`,
    blobPath: BLOB_PATH,
    githubPath: FILE_PATH,
    githubSha: sha || undefined,
    message: "chore: record mentor withdrawal request",
    localPaths: [TMP_FILE, BUNDLED_FILE],
  });
}

function quotaForEmail(byEmail, email, now = Date.now()) {
  const key = normalizeEmail(email);
  const recent = pruneTimestamps(byEmail?.[key], now);
  const used = recent.length;
  const remaining = Math.max(0, WITHDRAW_MAX_PER_WEEK - used);
  const oldest = recent[0] || null;
  const resetsAt = oldest ? oldest + WITHDRAW_WINDOW_MS : null;
  return {
    email: key,
    used,
    remaining,
    max: WITHDRAW_MAX_PER_WEEK,
    windowDays: 7,
    resetsAt,
    allowed: remaining > 0,
  };
}

async function getWithdrawQuota(mentorEmail) {
  const email = normalizeEmail(mentorEmail);
  if (!email || !email.includes("@")) {
    const err = new Error("Mentor email is required");
    err.status = 400;
    throw err;
  }
  const store = await readWithdrawStore();
  return quotaForEmail(store.byEmail, email);
}

async function recordWithdrawRequest(mentorEmail) {
  const email = normalizeEmail(mentorEmail);
  const now = Date.now();
  const store = await readWithdrawStore();
  const recent = pruneTimestamps(store.byEmail?.[email], now);
  if (recent.length >= WITHDRAW_MAX_PER_WEEK) {
    const quota = quotaForEmail(store.byEmail, email, now);
    const err = new Error(
      `Withdrawal limit reached — max ${WITHDRAW_MAX_PER_WEEK} requests per week`
    );
    err.status = 429;
    err.data = { quota };
    throw err;
  }
  const next = {
    ...store.byEmail,
    [email]: [...recent, now],
  };
  for (const [key, stamps] of Object.entries(next)) {
    const kept = pruneTimestamps(stamps, now);
    if (!kept.length) delete next[key];
    else next[key] = kept;
  }
  await writeWithdrawStore(next, store.sha);
  return quotaForEmail(next, email, now);
}

async function handleWithdrawRequest(body) {
  const mentorEmail = normalizeEmail(body.mentorEmail || body.email || "");
  if (!mentorEmail || !mentorEmail.includes("@")) {
    const err = new Error("Mentor email is required");
    err.status = 400;
    throw err;
  }

  const mentors = await listMentors();
  const mentor = (Array.isArray(mentors) ? mentors : []).find(
    (m) => normalizeEmail(m.email) === mentorEmail
  );
  if (!mentor) {
    const err = new Error("Mentor account not found");
    err.status = 404;
    throw err;
  }
  const role = String(mentor.role || "").toLowerCase();
  const status = String(mentor.status || "").toLowerCase();
  if (role !== "superadmin" && status !== "approved") {
    const err = new Error("Only approved mentors can request withdrawals");
    err.status = 403;
    throw err;
  }

  const preQuota = await getWithdrawQuota(mentorEmail);
  if (!preQuota.allowed) {
    const err = new Error(
      `Withdrawal limit reached — max ${WITHDRAW_MAX_PER_WEEK} requests per week`
    );
    err.status = 429;
    err.data = { quota: preQuota };
    throw err;
  }

  if (!brevoConfigured()) {
    const err = new Error(
      "Brevo not configured (set BREVO_API_KEY and BREVO_SENDER_EMAIL)"
    );
    err.status = 503;
    throw err;
  }

  const username =
    String(body.username || mentor.username || "").trim() || "Mentor";
  const contact = String(body.contact || mentor.contact || "").trim();
  const paidUnlocks = Number(body.paidUnlocks ?? body.sold ?? 0) || 0;
  const commissionUsd = Number(body.commissionUsd ?? body.usd ?? 0) || 0;
  const commissionZar = Number(body.commissionZar ?? body.zar ?? 0) || 0;
  const banking = body.banking || mentor.banking || {};

  const subject = `Commission withdrawal request — ${username}`;
  const lines = [
    "Mentor commission withdrawal request",
    "",
    `Mentor: ${username}`,
    `Email: ${mentorEmail}`,
    contact ? `Contact: ${contact}` : null,
    "",
    `Paid unlocks: ${paidUnlocks}`,
    `Commission: $${commissionUsd.toFixed(2)} (R${commissionZar})`,
    "",
    "Banking details:",
    `  Account name: ${escapeText(banking.accountName)}`,
    `  Bank name: ${escapeText(banking.bankName)}`,
    `  Account number: ${escapeText(banking.accountNumber)}`,
    `  Branch code: ${escapeText(banking.branchCode)}`,
    `  Account type: ${escapeText(banking.accountType)}`,
    "",
    `Requested at: ${new Date().toISOString()}`,
  ].filter((line) => line != null);

  const textContent = lines.join("\n");
  const htmlContent = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f5f5f7;">
  <div style="max-width:520px;margin:0 auto;background:#16161d;border:1px solid #2a2a35;border-radius:16px;padding:24px;">
    <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#ff7ab5;">ApexEA payout</p>
    <h1 style="margin:0 0 16px;font-size:22px;color:#fff;">Commission withdrawal request</h1>
    <p style="margin:0 0 10px;color:#c8c8d0;"><strong style="color:#fff;">Mentor:</strong> ${escapeHtml(escapeText(username))}</p>
    <p style="margin:0 0 10px;color:#c8c8d0;"><strong style="color:#fff;">Email:</strong> ${escapeHtml(escapeText(mentorEmail))}</p>
    ${contact ? `<p style="margin:0 0 10px;color:#c8c8d0;"><strong style="color:#fff;">Contact:</strong> ${escapeHtml(escapeText(contact))}</p>` : ""}
    <p style="margin:0 0 10px;color:#c8c8d0;"><strong style="color:#fff;">Paid unlocks:</strong> ${paidUnlocks}</p>
    <p style="margin:0 0 18px;color:#c8c8d0;"><strong style="color:#fff;">Commission:</strong> $${commissionUsd.toFixed(2)} (R${commissionZar})</p>
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#9a9aaa;">Banking</p>
    <p style="margin:0 0 6px;color:#c8c8d0;">Account name: ${escapeHtml(escapeText(banking.accountName))}</p>
    <p style="margin:0 0 6px;color:#c8c8d0;">Bank: ${escapeHtml(escapeText(banking.bankName))}</p>
    <p style="margin:0 0 6px;color:#c8c8d0;">Account number: ${escapeHtml(escapeText(banking.accountNumber))}</p>
    <p style="margin:0 0 6px;color:#c8c8d0;">Branch code: ${escapeHtml(escapeText(banking.branchCode))}</p>
    <p style="margin:0;color:#c8c8d0;">Account type: ${escapeHtml(escapeText(banking.accountType))}</p>
  </div>
</body></html>`;

  const email = await sendBrevoEmail({
    toEmail: WITHDRAWAL_REQUEST_EMAIL,
    toName: "ApexEA Payouts",
    subject,
    htmlContent,
    textContent,
    tags: ["commission-withdrawal"],
  });

  if (!email.ok) {
    const err = new Error(email.error || "Could not send withdrawal request");
    err.status = email.skipped ? 503 : 502;
    throw err;
  }

  const quota = await recordWithdrawRequest(mentorEmail);

  return {
    ok: true,
    to: WITHDRAWAL_REQUEST_EMAIL,
    messageId: email.messageId || "",
    quota,
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  try {
    if (req.method === "GET") {
      const url = new URL(req.url || "/", "http://localhost");
      const mentorEmail =
        url.searchParams.get("mentorEmail") ||
        url.searchParams.get("email") ||
        "";
      if (mentorEmail) {
        const quota = await getWithdrawQuota(mentorEmail);
        sendJson(res, 200, {
          ok: true,
          configured: brevoConfigured(),
          withdrawalEmail: WITHDRAWAL_REQUEST_EMAIL,
          quota,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        configured: brevoConfigured(),
        withdrawalEmail: WITHDRAWAL_REQUEST_EMAIL,
        maxPerWeek: WITHDRAW_MAX_PER_WEEK,
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const body = await readJsonBody(req);
    const action = String(body.action || body.type || "broadcast").toLowerCase();

    if (action === "status" || action === "config") {
      sendJson(res, 200, {
        ok: true,
        configured: brevoConfigured(),
        withdrawalEmail: WITHDRAWAL_REQUEST_EMAIL,
        maxPerWeek: WITHDRAW_MAX_PER_WEEK,
      });
      return;
    }

    if (
      action === "withdraw-quota" ||
      action === "withdrawal-quota" ||
      action === "quota"
    ) {
      const quota = await getWithdrawQuota(body.mentorEmail || body.email || "");
      sendJson(res, 200, { ok: true, quota });
      return;
    }

    if (
      action === "withdraw-request" ||
      action === "withdrawal-request" ||
      action === "request-withdrawal"
    ) {
      const result = await handleWithdrawRequest(body);
      sendJson(res, 200, result);
      return;
    }

    if (action !== "broadcast" && action !== "send" && action !== "send-all") {
      sendJson(res, 400, { error: "Unknown action" });
      return;
    }

    assertSuperAdmin(body.adminEmail || body.actorEmail || body.by || "");

    if (!brevoConfigured()) {
      sendJson(res, 503, {
        ok: false,
        error: "Brevo not configured (set BREVO_API_KEY and BREVO_SENDER_EMAIL)",
      });
      return;
    }

    const subject = String(body.subject || "").trim();
    const message = String(body.message || body.body || body.text || "").trim();
    if (!subject) {
      sendJson(res, 400, { error: "Subject is required" });
      return;
    }
    if (!message) {
      sendJson(res, 400, { error: "Message is required" });
      return;
    }

    const rawRecipients = Array.isArray(body.recipients)
      ? body.recipients
      : Array.isArray(body.emails)
        ? body.emails
        : [];

    const recipients = [];
    const seen = new Set();
    for (const entry of rawRecipients) {
      const email =
        typeof entry === "string"
          ? normalizeEmail(entry)
          : normalizeEmail(entry?.email || entry?.toEmail || "");
      if (!email || !email.includes("@") || seen.has(email)) continue;
      seen.add(email);
      recipients.push({
        email,
        name:
          typeof entry === "object"
            ? String(entry?.name || entry?.toName || entry?.clientName || "").trim()
            : "",
      });
    }

    if (!recipients.length) {
      sendJson(res, 400, { error: "No valid recipient emails" });
      return;
    }

    const concurrency = Math.max(
      1,
      Math.min(Number(body.concurrency) || 4, 8)
    );
    const result = await sendBroadcastEmails(recipients, {
      subject,
      message,
      concurrency,
    });

    sendJson(res, 200, {
      ok: true,
      ...result,
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Email send failed",
      details: error.data || null,
      quota: error.data?.quota || undefined,
    });
  }
}
