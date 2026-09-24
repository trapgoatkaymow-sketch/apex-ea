import { endOptions } from "../_cors.js";
import {
  LIFETIME_CURRENCY,
  LIFETIME_PRICE,
  PAYPAL_CLIENT_ID,
  sendJson,
} from "./_lib.js";
import {
  ROBOT_BOT_NAME,
  ROBOT_CURRENCY,
  ROBOT_PRICE,
} from "./_robotPurchase.js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const secretConfigured = Boolean(process.env.PAYPAL_CLIENT_SECRET);
  sendJson(res, 200, {
    clientId: PAYPAL_CLIENT_ID,
    amount: LIFETIME_PRICE,
    currency: LIFETIME_CURRENCY,
    robot: {
      amount: ROBOT_PRICE,
      currency: ROBOT_CURRENCY,
      botName: ROBOT_BOT_NAME,
      label: "ZETA SCALPER AI Mobile Robot",
    },
    mode: String(process.env.PAYPAL_MODE || "live").toLowerCase() === "sandbox" ? "sandbox" : "live",
    ready: Boolean(PAYPAL_CLIENT_ID) && secretConfigured,
    secretConfigured,
  });
}
