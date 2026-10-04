import { endOptions } from "../_cors.js";
import {
  LIFETIME_CURRENCY,
  LIFETIME_PRICE,
  PAYPAL_CLIENT_ID,
  sendJson,
} from "./_lib.js";
import {
  GIVEAWAY_CURRENCY,
  GIVEAWAY_DISPLAY_CURRENCY,
  GIVEAWAY_DISPLAY_PRICE,
  GIVEAWAY_PRICE,
  resolveGiveawayWindow,
  ROBOT_BOT_NAME,
  ROBOT_CURRENCY,
  ROBOT_NCP_CURRENCY,
  ROBOT_NCP_PRICE,
  ROBOT_PRICE,
} from "./_robotPurchase.js";

export const config = { maxDuration: 20 };

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
  const giveawayWindow = await resolveGiveawayWindow();
  sendJson(res, 200, {
    clientId: PAYPAL_CLIENT_ID,
    amount: LIFETIME_PRICE,
    currency: LIFETIME_CURRENCY,
    robot: {
      amount: ROBOT_PRICE,
      currency: ROBOT_CURRENCY,
      displayAmount: ROBOT_NCP_PRICE,
      displayCurrency: ROBOT_NCP_CURRENCY,
      botName: ROBOT_BOT_NAME,
      label: "ZETA SCALPER AI Mobile Robot",
    },
    giveaway: {
      amount: GIVEAWAY_PRICE,
      currency: GIVEAWAY_CURRENCY,
      displayAmount: GIVEAWAY_DISPLAY_PRICE,
      displayCurrency: GIVEAWAY_DISPLAY_CURRENCY,
      botName: ROBOT_BOT_NAME,
      label: "Giveaway — App access + ZETA SCALPER AI",
      window: giveawayWindow,
      shareUrl: "https://www.apex-ea.com/giveaway.html",
    },
    mode: String(process.env.PAYPAL_MODE || "live").toLowerCase() === "sandbox" ? "sandbox" : "live",
    ready: Boolean(PAYPAL_CLIENT_ID) && secretConfigured,
    secretConfigured,
  });
}
