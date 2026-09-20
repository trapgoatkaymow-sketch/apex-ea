import { endOptions } from "../_cors.js";
import { brevoConfigured, sendBroadcastEmails } from "../_brevo.js";
import {
  readJsonBody,
  sendJson,
  SUPER_ADMIN_EMAIL,
} from "../mentors/_lib.js";

export const config = { maxDuration: 60 };

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

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  try {
    if (req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        configured: brevoConfigured(),
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
      sendJson(res, 200, { ok: true, configured: brevoConfigured() });
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
    });
  }
}
