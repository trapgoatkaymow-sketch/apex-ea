import { endOptions } from "../_cors.js";
import {
  extractCaptureClientName,
  extractCaptureEmail,
  extractCapturePurpose,
  getPayPalAccessToken,
  isCaptureCompleted,
  isLifetimeAmountPaid,
  sendJson,
  verifyPayPalWebhookSignature,
} from "./_lib.js";
import {
  extractCaptureAmount,
  extractCaptureId,
  fulfillRobotPurchase,
  isRobotPurchaseCapture,
} from "./_robotPurchase.js";
import {
  setSignupAccessPaid,
  setSignupPremiumScanner,
  setSignupStatus,
  upsertSignup,
} from "../signups/_lib.js";

export const config = { maxDuration: 60 };

async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function lowerHeaders(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

async function resolveEmailFromCapture(capture, resource = {}) {
  let email =
    extractCaptureEmail(capture) ||
    normalizeEmail(resource?.payer?.email_address || capture?.payer?.email_address);
  if (email && email.includes("@")) return email;

  const orderId = String(
    resource?.supplementary_data?.related_ids?.order_id ||
      capture?.supplementary_data?.related_ids?.order_id ||
      ""
  ).trim();
  if (!orderId) return email;

  try {
    const accessToken = await getPayPalAccessToken();
    const base =
      String(process.env.PAYPAL_MODE || "live").toLowerCase() === "sandbox"
        ? "https://api-m.sandbox.paypal.com"
        : "https://api-m.paypal.com";
    const response = await fetch(
      `${base}/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const order = await response.json();
    email =
      extractCaptureEmail(order) ||
      normalizeEmail(order?.payer?.email_address) ||
      email;
  } catch {
    // keep prior
  }
  return email;
}

/**
 * PayPal webhook for Zetascalperai.com NCP payment links + Orders captures.
 *
 * PayPal Developer → Webhooks:
 *   URL: https://www.apex-ea.com/api/paypal/webhook
 *   Event: PAYMENT.CAPTURE.COMPLETED
 * Vercel env: PAYPAL_WEBHOOK_ID
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const rawBody = await readRawBody(req);
    const headers = lowerHeaders(req);
    await verifyPayPalWebhookSignature({
      headers,
      body: rawBody,
      webhookId: process.env.PAYPAL_WEBHOOK_ID || "",
    });

    let event = {};
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      event = {};
    }

    const eventType = String(event?.event_type || "").toUpperCase();
    const resource = event?.resource || {};

    let capture = resource;
    if (resource?.amount && !resource?.purchase_units) {
      capture = {
        id: resource.id,
        status: resource.status,
        payer: resource.payer || {},
        purchase_units: [
          {
            custom_id: resource.custom_id || "",
            payments: {
              captures: [
                {
                  id: resource.id,
                  status: resource.status,
                  amount: resource.amount,
                  custom_id: resource.custom_id || "",
                },
              ],
            },
            amount: resource.amount,
          },
        ],
        supplementary_data: resource.supplementary_data,
      };
    }

    const completed =
      isCaptureCompleted(capture) ||
      String(resource?.status || "").toUpperCase() === "COMPLETED";
    if (!completed) {
      sendJson(res, 200, {
        ok: true,
        ignored: true,
        reason: "not-completed",
        eventType,
      });
      return;
    }

    const purpose = extractCapturePurpose(capture);
    const robot = isRobotPurchaseCapture(capture, { purposeHint: purpose });

    if (robot) {
      const email = await resolveEmailFromCapture(capture, resource);
      const clientName = extractCaptureClientName(capture);
      if (!email || !email.includes("@")) {
        sendJson(res, 200, {
          ok: false,
          error: "robot-payment-missing-email",
          eventType,
          amount: extractCaptureAmount(capture),
        });
        return;
      }
      const fulfilled = await fulfillRobotPurchase({
        email,
        clientName,
        captureId: extractCaptureId(capture) || String(resource?.id || ""),
        orderId: String(
          resource?.supplementary_data?.related_ids?.order_id ||
            resource?.id ||
            ""
        ),
        source: "paypal-webhook",
      });
      sendJson(res, 200, {
        ok: true,
        purpose: "robot",
        email: fulfilled.email,
        licenseKey: fulfilled.key,
        reused: Boolean(fulfilled.reused),
        eventType,
      });
      return;
    }

    if (isLifetimeAmountPaid(capture) || purpose === "access" || purpose === "scanner") {
      const email = await resolveEmailFromCapture(capture, resource);
      if (email && email.includes("@")) {
        await upsertSignup(email, { status: "pending" });
        if (purpose === "scanner") {
          await setSignupPremiumScanner(email, true);
        } else if (isLifetimeAmountPaid(capture) || purpose === "access") {
          await setSignupStatus(email, "approved");
          await setSignupAccessPaid(email, true);
        }
      }
      sendJson(res, 200, {
        ok: true,
        purpose: purpose || "access",
        email,
        eventType,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      ignored: true,
      reason: "unmatched-payment",
      eventType,
      amount: extractCaptureAmount(capture),
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "PayPal webhook failed",
      details: error.data || null,
    });
  }
}
