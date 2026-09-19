/**
 * Brevo (Sendinblue) transactional email helper.
 *
 * Env (Vercel / server only — never VITE_):
 *   BREVO_API_KEY        — API key from Brevo → SMTP & API → API keys
 *   BREVO_SENDER_EMAIL   — verified sender (e.g. noreply@apex-ea.com)
 *   BREVO_SENDER_NAME    — display name (default: ApexEA)
 *   BREVO_REPLY_TO       — optional reply-to address
 */

const BREVO_API = "https://api.brevo.com/v3/smtp/email";

function env(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

export function brevoConfigured() {
  return Boolean(env("BREVO_API_KEY") && env("BREVO_SENDER_EMAIL"));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDurationLabel(duration, expiresAt) {
  const id = String(duration || "lifetime").toLowerCase();
  if (id === "lifetime" || !expiresAt) return "Lifetime";
  try {
    const d = new Date(Number(expiresAt));
    if (!Number.isFinite(d.getTime())) return id;
    return `${id} · expires ${d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })}`;
  } catch {
    return id;
  }
}

/**
 * Low-level Brevo send. Returns { ok, messageId?, error?, skipped? }.
 * Never throws — callers should not fail license creation on mail errors.
 */
export async function sendBrevoEmail({
  toEmail,
  toName = "",
  subject,
  htmlContent,
  textContent = "",
  tags = [],
} = {}) {
  const apiKey = env("BREVO_API_KEY");
  const senderEmail = env("BREVO_SENDER_EMAIL");
  const senderName = env("BREVO_SENDER_NAME", "ApexEA");
  const replyTo = env("BREVO_REPLY_TO");

  const to = String(toEmail || "")
    .trim()
    .toLowerCase();
  if (!to || !to.includes("@")) {
    return { ok: false, error: "Missing recipient email" };
  }
  if (!apiKey || !senderEmail) {
    return {
      ok: false,
      skipped: true,
      error: "Brevo not configured (set BREVO_API_KEY and BREVO_SENDER_EMAIL)",
    };
  }

  const body = {
    sender: { name: senderName || "ApexEA", email: senderEmail },
    to: [{ email: to, ...(toName ? { name: String(toName).trim() } : {}) }],
    subject: String(subject || "Your ApexEA license key").trim(),
    htmlContent: String(htmlContent || "").trim() || "<p>Your license key is ready.</p>",
  };
  if (textContent) body.textContent = String(textContent);
  if (replyTo && replyTo.includes("@")) {
    body.replyTo = { email: replyTo, name: senderName || "ApexEA" };
  }
  if (Array.isArray(tags) && tags.length) {
    body.tags = tags.map((t) => String(t).slice(0, 50)).filter(Boolean);
  }

  try {
    const res = await fetch(BREVO_API, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg =
        data?.message ||
        data?.error ||
        (raw && raw.slice(0, 200)) ||
        `Brevo HTTP ${res.status}`;
      console.warn("brevo send failed", res.status, msg);
      return { ok: false, error: String(msg), status: res.status };
    }
    return {
      ok: true,
      messageId: data?.messageId || data?.messageIds?.[0] || "",
    };
  } catch (error) {
    console.warn("brevo send error", error?.message || error);
    return { ok: false, error: error?.message || "Brevo network error" };
  }
}

/** Build + send the license key email for one client. */
export async function sendLicenseKeyEmail(license = {}) {
  const toEmail = String(license.clientEmail || license.email || "")
    .trim()
    .toLowerCase();
  const toName = String(license.clientName || license.name || "").trim();
  const key = String(license.key || "").trim().toUpperCase();
  if (!key || !toEmail.includes("@")) {
    return { ok: false, error: "License key or client email missing" };
  }

  const botName = String(license.botName || license.bot?.name || "Bot").trim() || "Bot";
  const mentorName = String(license.mentorName || "").trim() || "your mentor";
  const duration = formatDurationLabel(license.duration, license.expiresAt);
  const appUrl = env("PUBLIC_APP_URL", "https://www.apex-ea.com");
  const downloadUrl = `${appUrl.replace(/\/+$/, "")}/download`;

  const subject = `Your ${botName} license key — ApexEA`;
  const textContent = [
    `Hi ${toName || "there"},`,
    "",
    `${mentorName} generated a license key for you on ApexEA.`,
    "",
    `Bot: ${botName}`,
    `License key: ${key}`,
    `Access: ${duration}`,
    "",
    "How to activate:",
    `1. Open ${appUrl} or install the Android app: ${downloadUrl}`,
    "2. Sign in with this email",
    `3. Enter your license key: ${key}`,
    "",
    "Keep this email — you will need the key if you reinstall.",
    "",
    "— ApexEA",
  ].join("\n");

  const htmlContent = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f5f5f7;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0b0f;padding:28px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#16161d;border:1px solid #2a2a35;border-radius:16px;padding:28px 24px;">
        <tr><td>
          <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#ff7ab5;">ApexEA license</p>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;color:#fff;">Your key is ready</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:#c8c8d0;">
            Hi ${escapeHtml(toName || "there")}, <strong style="color:#fff;">${escapeHtml(mentorName)}</strong>
            generated a license for <strong style="color:#fff;">${escapeHtml(botName)}</strong>.
          </p>
          <div style="margin:0 0 20px;padding:16px 18px;background:#0b0b0f;border:1px solid #3a3a48;border-radius:12px;text-align:center;">
            <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#9a9aaa;">License key</p>
            <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:0.06em;color:#ff2d7a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(key)}</p>
          </div>
          <p style="margin:0 0 8px;font-size:14px;color:#c8c8d0;"><strong style="color:#fff;">Access:</strong> ${escapeHtml(duration)}</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#c8c8d0;">
            Open <a href="${escapeHtml(appUrl)}" style="color:#ff7ab5;">${escapeHtml(appUrl)}</a>
            (or the <a href="${escapeHtml(downloadUrl)}" style="color:#ff7ab5;">Android app</a>),
            sign in with <strong style="color:#fff;">${escapeHtml(toEmail)}</strong>, then enter this key to unlock.
          </p>
          <p style="margin:0;font-size:12px;line-height:1.45;color:#7a7a88;">Keep this email — you will need the key if you reinstall.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return sendBrevoEmail({
    toEmail,
    toName,
    subject,
    htmlContent,
    textContent,
    tags: ["license-key"],
  });
}

/** Send many license emails with light concurrency. */
export async function sendLicenseKeyEmails(licenses = [], { concurrency = 4 } = {}) {
  const list = Array.isArray(licenses) ? licenses.filter(Boolean) : [];
  const results = [];
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i;
      i += 1;
      const license = list[idx];
      const sent = await sendLicenseKeyEmail(license);
      results[idx] = {
        email: license.clientEmail || license.email || "",
        key: license.key || "",
        ...sent,
      };
    }
  }
  const n = Math.max(1, Math.min(concurrency, list.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  const sentCount = results.filter((r) => r?.ok).length;
  const failedCount = results.filter((r) => r && !r.ok && !r.skipped).length;
  const skippedCount = results.filter((r) => r?.skipped).length;
  return { results, sentCount, failedCount, skippedCount };
}
