import { endOptions } from "../_cors.js";
import {
  createLifetimeOrder,
  extractApproveUrl,
  LIFETIME_CURRENCY,
  LIFETIME_PRICE,
  readJsonBody,
  sendJson,
} from "./_lib.js";

export const config = { maxDuration: 30 };

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
    const order = await createLifetimeOrder(body.email, {
      purpose: body.purpose || "access",
      returnUrl: body.returnUrl || body.return_url || "",
      cancelUrl: body.cancelUrl || body.cancel_url || "",
    });
    const approveUrl = extractApproveUrl(order);
    sendJson(res, 200, {
      id: order.id,
      status: order.status,
      amount: LIFETIME_PRICE,
      currency: LIFETIME_CURRENCY,
      approveUrl,
      links: order.links || [],
      purpose:
        String(body.purpose || "").toLowerCase() === "scanner" ? "scanner" : "access",
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Could not create PayPal order",
      details: error.data || null,
    });
  }
}
