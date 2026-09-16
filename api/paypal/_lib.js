import { applyCorsHeaders } from "../_cors.js";
const PAYPAL_API_BASE =
  String(process.env.PAYPAL_MODE || "live").toLowerCase() === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";

export const LIFETIME_PRICE = "35.60";
export const LIFETIME_CURRENCY = "USD";

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

export async function createLifetimeOrder(email, { purpose = "access" } = {}) {
  const buyer = normalizeEmail(email);
  if (!buyer || !buyer.includes("@")) {
    const err = new Error("Enter a valid email before paying");
    err.status = 400;
    throw err;
  }

  const kind = String(purpose || "access").toLowerCase() === "scanner" ? "scanner" : "access";
  const accessToken = await getPayPalAccessToken();
  return paypalFetch("/v2/checkout/orders", {
    method: "POST",
    accessToken,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: LIFETIME_CURRENCY,
            value: LIFETIME_PRICE,
          },
          description:
            kind === "scanner"
              ? "ApexEA Premium Chart Scanner"
              : "ApexEA Lifetime Access",
          custom_id: `${kind}:${buyer}`.slice(0, 127),
        },
      ],
      application_context: {
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        brand_name: "ApexEA",
        return_url: "https://apex-ea.com/",
        cancel_url: "https://apex-ea.com/",
      },
    },
  });
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
  const emailPart = raw.includes(":") ? raw.split(":").slice(1).join(":") : raw;
  return normalizeEmail(emailPart || payerEmail);
}

export function extractCapturePurpose(capture) {
  const custom =
    capture?.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ||
    capture?.purchase_units?.[0]?.custom_id ||
    "";
  const raw = String(custom || "");
  if (raw.toLowerCase().startsWith("scanner:")) return "scanner";
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
