import { endOptions } from "../_cors.js";
import {
  getPayPalAccessToken,
  PAYPAL_CLIENT_ID,
  sendJson,
  readJsonBody,
} from "./_lib.js";
import { SUPER_ADMIN_EMAIL } from "../mentors/_lib.js";

export const config = { maxDuration: 30 };

const WEBHOOK_URL = "https://www.apex-ea.com/api/paypal/webhook";
const EVENT_TYPES = ["PAYMENT.CAPTURE.COMPLETED"];

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * One-time setup: register PayPal webhook for robot auto-fulfill.
 * POST { adminEmail } as super admin.
 * Returns webhook id to store as PAYPAL_WEBHOOK_ID on Vercel.
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
    const body = await readJsonBody(req);
    const admin = normalizeEmail(body.adminEmail || body.email || "");
    const setupToken = String(body.setupToken || body.token || "").trim();
    const expectedToken = String(process.env.PAYPAL_SETUP_TOKEN || "").trim();
    const isSuper = admin && admin === normalizeEmail(SUPER_ADMIN_EMAIL);
    const tokenOk = expectedToken && setupToken && setupToken === expectedToken;
    if (!isSuper && !tokenOk) {
      sendJson(res, 403, { error: "Only super admin can register the PayPal webhook" });
      return;
    }

    const accessToken = await getPayPalAccessToken();
    const base =
      String(process.env.PAYPAL_MODE || "live").toLowerCase() === "sandbox"
        ? "https://api-m.sandbox.paypal.com"
        : "https://api-m.paypal.com";

    // Reuse existing webhook on the same URL if present.
    const listed = await fetch(`${base}/v1/notifications/webhooks`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(data?.message || `PayPal list webhooks failed (${r.status})`);
        err.status = r.status;
        err.data = data;
        throw err;
      }
      return data;
    });

    const existing = (listed?.webhooks || []).find(
      (w) => String(w?.url || "").replace(/\/$/, "") === WEBHOOK_URL.replace(/\/$/, "")
    );
    if (existing?.id) {
      sendJson(res, 200, {
        ok: true,
        reused: true,
        webhookId: existing.id,
        url: existing.url,
        eventTypes: (existing.event_types || []).map((e) => e.name),
        clientIdPrefix: String(PAYPAL_CLIENT_ID || "").slice(0, 12),
        note: "Set Vercel env PAYPAL_WEBHOOK_ID to this webhookId (already registered).",
      });
      return;
    }

    const created = await fetch(`${base}/v1/notifications/webhooks`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        event_types: EVENT_TYPES.map((name) => ({ name })),
      }),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(data?.message || `PayPal create webhook failed (${r.status})`);
        err.status = r.status;
        err.data = data;
        throw err;
      }
      return data;
    });

    sendJson(res, 200, {
      ok: true,
      reused: false,
      webhookId: created.id,
      url: created.url,
      eventTypes: EVENT_TYPES,
      note: "Set Vercel env PAYPAL_WEBHOOK_ID to webhookId, then redeploy.",
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Could not register PayPal webhook",
      details: error.data || null,
    });
  }
}
