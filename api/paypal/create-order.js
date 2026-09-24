import { endOptions } from "../_cors.js";
import {
  createLifetimeOrder,
  extractApproveUrl,
  LIFETIME_CURRENCY,
  LIFETIME_PRICE,
  readJsonBody,
  sendJson,
} from "./_lib.js";
import { ROBOT_CURRENCY, ROBOT_PRICE } from "./_robotPurchase.js";

export const config = { maxDuration: 30 };

function normalizePurpose(raw) {
  const value = String(raw || "access").toLowerCase();
  if (value === "robot" || value === "license" || value.startsWith("robot:")) {
    return "robot";
  }
  if (value === "scanner" || value.startsWith("scanner:")) return "scanner";
  return "access";
}

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
    const purpose = normalizePurpose(body.purpose);
    const order = await createLifetimeOrder(body.email, {
      purpose,
      clientName: body.clientName || body.name || "",
      returnUrl: body.returnUrl || body.return_url || "",
      cancelUrl: body.cancelUrl || body.cancel_url || "",
    });
    const approveUrl = extractApproveUrl(order);
    sendJson(res, 200, {
      id: order.id,
      status: order.status,
      amount: purpose === "robot" ? ROBOT_PRICE : LIFETIME_PRICE,
      currency: purpose === "robot" ? ROBOT_CURRENCY : LIFETIME_CURRENCY,
      approveUrl,
      links: order.links || [],
      purpose,
      botName: purpose === "robot" ? "ZETA SCALPER AI" : null,
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Could not create PayPal order",
      details: error.data || null,
    });
  }
}
