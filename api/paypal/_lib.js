import { applyCorsHeaders } from "../_cors.js";
const PAYPAL_API_BASE =
  String(process.env.PAYPAL_MODE || "live").toLowerCase() === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

export const LIFETIME_PRICE = "35.60";
export const LIFETIME_CURRENCY = "USD";

export {
  ROBOT_PRICE,
  ROBOT_CURRENCY,
  ROBOT_BOT_ID,
  ROBOT_BOT_NAME,
  ROBOT_MENTOR_EMAIL,
} from "./_robotPurchase.js";

/** Public Client ID (safe for browser). Prefer env on Vercel. */
export const PAYPAL_CLIENT_ID =
  process.env.PAYPAL_CLIENT_ID ||
  process.env.VITE_PAYPAL_CLIENT_ID ||
  "BAA-tao191om5dQpIXlAHBg7tdXs8gvIZSzQvcPGEZDFlIzg7r9hFHKZbF7ExHLvDLZdfmt6aMHYY-3mns";

function requireClientSecret() {
  const secret = process.env.PAYPAL_CLIENT_SECRET || "";
  if (!secret) {
    const err = new Error(
      "PayPal is not fully configured. Set PAYPAL_CLIENT_SECRET on Vercel (from developer.paypal.com)."
    );
    err.status = 500;
    throw err;
  }
  return secret;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

async function paypalFetch(path, { method = "GET", body, accessToken } = {}) {
  const response = await fetch(`${PAYPAL_API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      (data && (data.message || data.error_description || data.error)) ||
      `PayPal error ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

export async function getPayPalAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 30_000) {
    return cachedToken;
  }

  const clientId = PAYPAL_CLIENT_ID;
  const secret = requireClientSecret();
  const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");

  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const err = new Error(
      data.error_description || data.error || "PayPal authentication failed"
    );
    err.status = response.status || 500;
    err.data = data;
    throw err;
  }

  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + Number(data.expires_in || 300) * 1000;
  return cachedToken;
}

export async function createLifetimeOrder(email, { purpose = "access", returnUrl = "", cancelUrl = "", clientName = "" } = {}) {
  const buyer = normalizeEmail(email);
  if (!buyer || !buyer.includes("@")) {
    const err = new Error("Enter a valid email before paying");
    err.status = 400;
    throw err;
  }

  const purposeRaw = String(purpose || "access").toLowerCase();
  const isRobot =
    purposeRaw === "robot" ||
    purposeRaw === "license" ||
    purposeRaw.startsWith("robot:") ||
    purposeRaw.startsWith("license:");
  const kind = isRobot
    ? "robot"
    : purposeRaw === "scanner" || purposeRaw.startsWith("scanner:")
      ? "scanner"
      : "access";

  const { ROBOT_PRICE, ROBOT_CURRENCY } = await import("./_robotPurchase.js");
  const amountValue = kind === "robot" ? ROBOT_PRICE : LIFETIME_PRICE;
  const amountCurrency = kind === "robot" ? ROBOT_CURRENCY : LIFETIME_CURRENCY;
  const nameHint = String(clientName || "")
    .trim()
    .replace(/[:|]/g, " ")
    .slice(0, 40);
  const customId =
    kind === "robot"
      ? `robot:${buyer}${nameHint ? `|${nameHint}` : ""}`.slice(0, 127)
      : `${kind}:${buyer}`.slice(0, 127);

  const accessToken = await getPayPalAccessToken();
  const safeReturn =
    String(returnUrl || "").trim() ||
    (kind === "robot"
      ? "https://www.apex-ea.com/buy-zeta.html?paypal_return=1"
      : "https://apex-ea.com/?paypal_return=1");
  const safeCancel =
    String(cancelUrl || "").trim() ||
    (kind === "robot"
      ? "https://www.apex-ea.com/buy-zeta.html?paypal_cancel=1"
      : "https://apex-ea.com/?paypal_cancel=1");

  return paypalFetch("/v2/checkout/orders", {
    method: "POST",
    accessToken,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: amountCurrency,
            value: amountValue,
          },
          description:
            kind === "robot"
              ? "ZETA SCALPER AI — Mobile Robot Lifetime License"
              : kind === "scanner"
                ? "ApexEA Premium Chart Scanner"
                : "ApexEA Lifetime Access",
          custom_id: customId,
        },
      ],
      application_context: {
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        // BILLING surfaces guest card entry instead of forcing a PayPal login.
        landing_page: kind === "robot" ? "BILLING" : "NO_PREFERENCE",
        brand_name: kind === "robot" ? "ZETA SCALPER AI" : "ApexEA",
        return_url: safeReturn,
        cancel_url: safeCancel,
      },
    },
  });
}

export function extractApproveUrl(order) {
  const links = Array.isArray(order?.links) ? order.links : [];
  const approve = links.find((link) => String(link?.rel || "").toLowerCase() === "approve");
  return String(approve?.href || "").trim();
}

export async function captureLifetimeOrder(orderId) {
  const id = String(orderId || "").trim();
  if (!id) {
    const err = new Error("Missing PayPal order id");
    err.status = 400;
    throw err;
  }
  const accessToken = await getPayPalAccessToken();
  return paypalFetch(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {
    method: "POST",
    accessToken,
    body: {},
  });
}

export function extractCaptureEmail(capture) {
  const custom =
    capture?.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ||
    capture?.purchase_units?.[0]?.custom_id ||
    "";
  const payerEmail = capture?.payer?.email_address || "";
  const raw = String(custom || payerEmail || "");
  // robot:email|Name  OR  access:email  OR  scanner:email
  let emailPart = raw;
  if (raw.includes(":")) {
    emailPart = raw.split(":").slice(1).join(":");
  }
  if (emailPart.includes("|")) {
    emailPart = emailPart.split("|")[0];
  }
  return normalizeEmail(emailPart || payerEmail);
}

export function extractCaptureClientName(capture) {
  const custom =
    capture?.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ||
    capture?.purchase_units?.[0]?.custom_id ||
    "";
  const raw = String(custom || "");
  if (!raw.includes("|")) return "";
  return String(raw.split("|").slice(1).join("|") || "").trim();
}

export function extractCapturePurpose(capture) {
  const custom =
    capture?.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ||
    capture?.purchase_units?.[0]?.custom_id ||
    "";
  const raw = String(custom || "").toLowerCase();
  if (raw.startsWith("scanner:")) return "scanner";
  if (raw.startsWith("robot:") || raw.startsWith("license:")) return "robot";
  return "access";
}

export function isCaptureCompleted(capture) {
  const status = String(capture?.status || "").toUpperCase();
  if (status === "COMPLETED") return true;
  const captureStatus = String(
    capture?.purchase_units?.[0]?.payments?.captures?.[0]?.status || ""
  ).toUpperCase();
  return captureStatus === "COMPLETED";
}

export function isLifetimeAmountPaid(capture) {
  const unit = capture?.purchase_units?.[0];
  const captureAmount =
    unit?.payments?.captures?.[0]?.amount || unit?.amount;
  const value = String(captureAmount?.value || "").trim();
  const currency = String(captureAmount?.currency_code || "").toUpperCase();
  return value === LIFETIME_PRICE && currency === LIFETIME_CURRENCY;
}

export async function verifyPayPalWebhookSignature({
  headers = {},
  body = "",
  webhookId = "",
} = {}) {
  const id = String(webhookId || process.env.PAYPAL_WEBHOOK_ID || "").trim();
  if (!id) {
    // Allow processing when webhook id is not configured (dev) — still auth via HTTPS.
    return { ok: true, skipped: true, reason: "PAYPAL_WEBHOOK_ID not set" };
  }
  const accessToken = await getPayPalAccessToken();
  const transmissionId = headers["paypal-transmission-id"] || headers["PayPal-Transmission-Id"];
  const transmissionTime =
    headers["paypal-transmission-time"] || headers["PayPal-Transmission-Time"];
  const certUrl = headers["paypal-cert-url"] || headers["PayPal-Cert-Url"];
  const authAlgo = headers["paypal-auth-algo"] || headers["PayPal-Auth-Algo"];
  const transmissionSig =
    headers["paypal-transmission-sig"] || headers["PayPal-Transmission-Sig"];
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    const err = new Error("Missing PayPal webhook signature headers");
    err.status = 400;
    throw err;
  }
  let webhookEvent = body;
  if (typeof body === "string") {
    try {
      webhookEvent = JSON.parse(body || "{}");
    } catch {
      webhookEvent = {};
    }
  }
  const result = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    accessToken,
    body: {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: id,
      webhook_event: webhookEvent,
    },
  });
  const status = String(result?.verification_status || "").toUpperCase();
  if (status !== "SUCCESS") {
    const err = new Error(`PayPal webhook verification failed (${status || "unknown"})`);
    err.status = 400;
    err.data = result;
    throw err;
  }
  return { ok: true, result };
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}
