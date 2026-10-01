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

/** Trapgoatkaymow client WhatsApp group — included on automatic license emails. */
const DEFAULT_TRAPGOAT_WHATSAPP_URL =
  "https://chat.whatsapp.com/DxPeaEnyFRtDIlTWth4kLs?mode=gi_t";
const TRAPGOAT_MENTOR_EMAIL = "trapgoatkaymow@gmail.com";

function trapgoatWhatsappUrl() {
  // Always use the current group invite; ignore a stale env override if empty/old.
  const fromEnv = env("TRAPGOAT_WHATSAPP_GROUP_URL");
  if (fromEnv && fromEnv.includes("chat.whatsapp.com/")) return fromEnv;
  return DEFAULT_TRAPGOAT_WHATSAPP_URL;
}

function shouldIncludeTrapgoatWhatsapp(license = {}) {
  if (license?.includeWhatsapp === true || license?.forceWhatsapp === true) {
    return true;
  }
  const mentor = String(license.mentorEmail || license.ownerEmail || "")
    .trim()
    .toLowerCase();
  if (mentor === TRAPGOAT_MENTOR_EMAIL) return true;
  // Giveaway + robot checkout fulfill under Trapgoatkaymow even if mentor lags.
  const source = String(license.purchaseSource || "").toLowerCase();
  return (
    source.includes("giveaway") ||
    source.includes("paypal") ||
    source.includes("promo") ||
    source.includes("robot") ||
    source.includes("webhook")
  );
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
  const appUrl = env("PUBLIC_APP_URL", "https://www.apex-ea.com").replace(/\/+$/, "");
  const downloadUrl = "https://apex-ea.tech";
  const copyKeyUrl = `${appUrl}/copy-key.html?key=${encodeURIComponent(key)}`;
  const includeWhatsapp = shouldIncludeTrapgoatWhatsapp(license);
  const whatsappUrl = includeWhatsapp ? trapgoatWhatsappUrl() : "";

  const subject = `Your ${botName} license key — ApexEA`;
  const textContent = [
    `Hi ${toName || "there"},`,
    "",
    `${mentorName} generated a license key for you on ApexEA.`,
    "",
    `Bot: ${botName}`,
    `License key: ${key}`,
    `Copy key: ${copyKeyUrl}`,
    `Access: ${duration}`,
    "",
    "How to activate:",
    `1. Download the app: ${downloadUrl}`,
    "2. Sign in with this email",
    `3. Enter your license key: ${key}`,
    ...(whatsappUrl
      ? [
          "",
          "Join the Trapgoatkaymow ApexEA WhatsApp group for updates and support:",
          whatsappUrl,
        ]
      : []),
    "",
    "Keep this email — you will need the key if you reinstall.",
    "",
    "— ApexEA",
  ].join("\n");

  const whatsappHtml = whatsappUrl
    ? `<div style="margin:0 0 20px;padding:16px 18px;background:#0f1a14;border:1px solid #1f6b3a;border-radius:12px;">
            <p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#c8c8d0;">
              Join the <strong style="color:#fff;">Trapgoatkaymow ApexEA WhatsApp group</strong> for updates and support.
            </p>
            <p style="margin:0;text-align:center;">
              <a href="${escapeHtml(whatsappUrl)}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#25D366;color:#06210f;font-size:14px;font-weight:700;text-decoration:none;">Join WhatsApp group</a>
            </p>
            <p style="margin:10px 0 0;font-size:12px;line-height:1.45;color:#9a9aaa;word-break:break-all;">
              <a href="${escapeHtml(whatsappUrl)}" style="color:#25D366;">${escapeHtml(whatsappUrl)}</a>
            </p>
          </div>`
    : "";

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
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 8px;">
              <tr>
                <td align="left" style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#9a9aaa;vertical-align:middle;">License key</td>
                <td align="right" style="vertical-align:middle;">
                  <a href="${escapeHtml(copyKeyUrl)}" style="display:inline-block;padding:6px 12px;border-radius:999px;background:#ff2d7a;color:#fff;font-size:12px;font-weight:700;text-decoration:none;letter-spacing:0.02em;">Copy</a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:22px;font-weight:700;letter-spacing:0.06em;color:#ff2d7a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(key)}</p>
          </div>
          <p style="margin:0 0 8px;font-size:14px;color:#c8c8d0;"><strong style="color:#fff;">Access:</strong> ${escapeHtml(duration)}</p>
          ${whatsappHtml}
          <p style="margin:0 0 20px;font-size:14px;line-height:1.55;color:#c8c8d0;">
            <a href="${escapeHtml(downloadUrl)}" style="color:#ff7ab5;">Download the app</a>,
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
    tags: whatsappUrl ? ["license-key", "whatsapp-group-invite"] : ["license-key"],
  });
}

/** Send many license emails with light concurrency. */
export async function sendLicenseKeyEmails(licenses = [], { concurrency = 8 } = {}) {
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

/** Build a simple ApexEA announcement email (custom subject/body). */
export function buildBroadcastEmail({
  toName = "",
  subject = "",
  message = "",
  imageUrl = "",
  downloadUrl = "",
  ctaLabel = "",
} = {}) {
  const safeName = String(toName || "").trim() || "there";
  const safeSubject = String(subject || "Message from ApexEA").trim();
  const bodyText = String(message || "").trim();
  const appUrl = env("PUBLIC_APP_URL", "https://www.apex-ea.com").replace(/\/+$/, "");
  const safeDownload = String(downloadUrl || `${appUrl}/android`).trim() || `${appUrl}/android`;
  const safeImage = String(imageUrl || "").trim();
  const safeCta = String(ctaLabel || "Download the new app").trim();
  const paragraphs = bodyText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const htmlBody = paragraphs.length
    ? paragraphs
        .map(
          (line) =>
            `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#c8c8d0;">${escapeHtml(line)}</p>`
        )
        .join("")
    : `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#c8c8d0;">${escapeHtml(bodyText || "—")}</p>`;

  const imageBlock = safeImage
    ? `<p style="margin:8px 0 18px;"><img src="${escapeHtml(safeImage)}" alt="ApexEA update" width="480" style="display:block;width:100%;max-width:480px;height:auto;border-radius:14px;border:1px solid #2a2a35;" /></p>`
    : "";

  const textContent = [
    `Hi ${safeName},`,
    "",
    bodyText,
    "",
    safeImage ? `Screenshot: ${safeImage}` : null,
    `${safeCta}: ${safeDownload}`,
    `Or open ${appUrl}`,
    "",
    "— ApexEA",
  ]
    .filter((line) => line != null)
    .join("\n");

  const htmlContent = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f5f5f7;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0b0b0f;padding:28px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" style="max-width:520px;background:#16161d;border:1px solid #2a2a35;border-radius:16px;padding:28px 24px;">
        <tr><td>
          <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#ff7ab5;">ApexEA</p>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;color:#fff;">${escapeHtml(safeSubject)}</h1>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#c8c8d0;">Hi ${escapeHtml(safeName)},</p>
          ${htmlBody}
          ${imageBlock}
          <p style="margin:8px 0 0;">
            <a href="${escapeHtml(safeDownload)}" style="display:inline-block;padding:14px 20px;border-radius:12px;background:linear-gradient(180deg,#ff7ab5 0%,#ff2d7a 100%);color:#fff;font-size:15px;font-weight:700;text-decoration:none;">${escapeHtml(safeCta)}</a>
          </p>
          <p style="margin:16px 0 0;font-size:13px;line-height:1.55;color:#9a9aaa;">
            Direct link: <a href="${escapeHtml(safeDownload)}" style="color:#ff7ab5;">${escapeHtml(safeDownload)}</a><br/>
            Or open <a href="${escapeHtml(appUrl)}" style="color:#ff7ab5;">${escapeHtml(appUrl)}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: safeSubject, htmlContent, textContent };
}

/** Send one custom broadcast email. */
export async function sendBroadcastEmail(
  recipient = {},
  { subject, message, imageUrl, downloadUrl, ctaLabel } = {}
) {
  const toEmail = String(recipient.email || recipient.toEmail || "")
    .trim()
    .toLowerCase();
  const toName = String(recipient.name || recipient.toName || "").trim();
  if (!toEmail.includes("@")) {
    return { ok: false, error: "Missing recipient email" };
  }
  const built = buildBroadcastEmail({
    toName,
    subject,
    message,
    imageUrl,
    downloadUrl,
    ctaLabel,
  });
  return sendBrevoEmail({
    toEmail,
    toName,
    subject: built.subject,
    htmlContent: built.htmlContent,
    textContent: built.textContent,
    tags: ["broadcast"],
  });
}

/**
 * Notify a mentor that the super admin approved their account.
 * Does not throw — approval must succeed even if mail fails.
 */
export async function sendMentorApprovedEmail({
  toEmail,
  toName = "",
} = {}) {
  const email = String(toEmail || "")
    .trim()
    .toLowerCase();
  const username = String(toName || "").trim() || "Mentor";
  if (!email.includes("@")) {
    return { ok: false, error: "Missing recipient email" };
  }

  const appUrl = env("PUBLIC_APP_URL", "https://www.apex-ea.com").replace(
    /\/+$/,
    ""
  );
  const portalUrl = `${appUrl}/admin`;
  const subject = "Your ApexEA mentor account is approved";
  const textContent = [
    `Hi ${username},`,
    "",
    "Good news — your ApexEA mentor account has been approved by the super admin.",
    "",
    "You can sign in to the mentor portal here:",
    portalUrl,
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
          <p style="margin:0 0 6px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#ff7ab5;">ApexEA mentor</p>
          <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;color:#fff;">You're approved</h1>
          <p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#c8c8d0;">Hi ${escapeHtml(username)},</p>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#c8c8d0;">
            Your mentor account has been approved by the super admin. You can now sign in and manage your clients.
          </p>
          <p style="margin:0 0 22px;text-align:center;">
            <a href="${escapeHtml(portalUrl)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#ff2d7a;color:#fff;font-weight:700;text-decoration:none;">Open mentor portal</a>
          </p>
          <p style="margin:0;font-size:12px;line-height:1.45;color:#7a7a88;">If you did not register as a mentor, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return sendBrevoEmail({
    toEmail: email,
    toName: username,
    subject,
    htmlContent,
    textContent,
    tags: ["mentor-approved"],
  });
}

/** Send custom emails to many recipients with light concurrency. */
export async function sendBroadcastEmails(
  recipients = [],
  { subject, message, imageUrl, downloadUrl, ctaLabel, concurrency = 4 } = {}
) {
  const list = Array.isArray(recipients)
    ? recipients.filter((r) => String(r?.email || "").includes("@"))
    : [];
  const results = [];
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i;
      i += 1;
      const recipient = list[idx];
      const sent = await sendBroadcastEmail(recipient, {
        subject,
        message,
        imageUrl,
        downloadUrl,
        ctaLabel,
      });
      results[idx] = {
        email: recipient.email || "",
        ...sent,
      };
    }
  }
  const n = Math.max(1, Math.min(concurrency, list.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  const sentCount = results.filter((r) => r?.ok).length;
  const failedCount = results.filter((r) => r && !r.ok && !r.skipped).length;
  const skippedCount = results.filter((r) => r?.skipped).length;
  return { results, sentCount, failedCount, skippedCount, total: list.length };
}
