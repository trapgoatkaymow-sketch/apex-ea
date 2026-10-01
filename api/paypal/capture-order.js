import { waitUntil } from "@vercel/functions";
import { endOptions } from "../_cors.js";
import {
  captureLifetimeOrder,
  extractCaptureClientName,
  extractCaptureEmail,
  extractCapturePurpose,
  isCaptureCompleted,
  isLifetimeAmountPaid,
  readJsonBody,
  sendJson,
} from "./_lib.js";
import {
  assertGiveawayActive,
  extractCaptureId,
  fulfillRobotPurchase,
  isGiveawayPurchaseCapture,
  isRobotPurchaseCapture,
} from "./_robotPurchase.js";
import { sendLicenseKeyEmailOnce } from "../licenses/_lib.js";
import {
  setSignupAccessPaid,
  setSignupPremiumScanner,
  setSignupStatus,
  upsertSignup,
} from "../signups/_lib.js";

export const config = { maxDuration: 120 };

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
    const orderId = String(body.orderId || body.id || "").trim();
    const fallbackEmail = String(body.email || "")
      .trim()
      .toLowerCase();
    const fallbackName = String(body.clientName || body.name || "").trim();

    const capture = await captureLifetimeOrder(orderId);
    if (!isCaptureCompleted(capture)) {
      sendJson(res, 402, {
        error: "Payment was not completed",
        status: capture?.status || null,
      });
      return;
    }

    const purposeFromOrder = extractCapturePurpose(capture);
    const purposeHint = String(body.purpose || purposeFromOrder || "").toLowerCase();
    const isGiveaway =
      purposeHint === "giveaway" ||
      purposeHint === "promo" ||
      isGiveawayPurchaseCapture(capture, { purposeHint });
    const isRobot =
      !isGiveaway &&
      (purposeHint === "robot" ||
        purposeHint === "license" ||
        isRobotPurchaseCapture(capture, { purposeHint }));

    if (isGiveaway || isRobot) {
      // Buyer already paid — never abort fulfill on the display countdown.
      const email = extractCaptureEmail(capture) || fallbackEmail;
      const clientName = extractCaptureClientName(capture) || fallbackName;
      const captureId = extractCaptureId(capture);
      let fulfilled = null;
      let fulfillError = null;
      // Buyer already paid — retry durable/email glitches before failing.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          fulfilled = await fulfillRobotPurchase({
            email,
            clientName,
            captureId,
            orderId,
            source: isGiveaway ? "paypal-giveaway" : "paypal-order",
          });
          fulfillError = null;
          break;
        } catch (error) {
          fulfillError = error;
          if (
            attempt < 2 &&
            (error?.status === 503 ||
              error?.status === 409 ||
              error?.status === 500)
          ) {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          throw error;
        }
      }
      if (!fulfilled) throw fulfillError || new Error("Could not fulfill purchase");
      // If the key was minted but Brevo failed, one more dedicated email pass
      // before we tell the buyer they're done (they already paid).
      let emailSent = Boolean(
        fulfilled.emailSent ||
          fulfilled.emailResult?.ok ||
          Number(fulfilled.license?.emailSentAt)
      );
      if (!emailSent && fulfilled.key) {
        try {
          const again = await fulfillRobotPurchase({
            email: fulfilled.email,
            clientName,
            captureId,
            orderId,
            source: isGiveaway ? "paypal-giveaway" : "paypal-order",
          });
          fulfilled = again || fulfilled;
          emailSent = Boolean(
            again?.emailSent ||
              again?.emailResult?.ok ||
              Number(again?.license?.emailSentAt)
          );
        } catch {
          // keep original fulfill — key still returned below
        }
      }

      // Buyer already paid — keep retrying Brevo after the response so every
      // purchase gets the license key + WhatsApp group link.
      if (fulfilled?.key && fulfilled?.email) {
        const mailLicense = {
          ...(fulfilled.license || {}),
          key: fulfilled.key,
          clientEmail: fulfilled.email,
          clientName: clientName || fulfilled.license?.clientName || "",
          botName: fulfilled.license?.botName || "ZETA SCALPER AI",
          mentorEmail:
            fulfilled.license?.mentorEmail || "trapgoatkaymow@gmail.com",
          mentorName: fulfilled.license?.mentorName || "Trapgoatkaymow",
          duration: fulfilled.license?.duration || "lifetime",
          purchaseSource:
            fulfilled.license?.purchaseSource ||
            (isGiveaway ? "paypal-giveaway" : "paypal-order"),
          includeWhatsapp: true,
          forceWhatsapp: true,
        };
        waitUntil(
          (async () => {
            let ok = emailSent;
            for (let attempt = 0; attempt < 4 && !ok; attempt += 1) {
              try {
                const again = await sendLicenseKeyEmailOnce(mailLicense, {
                  force: true,
                });
                ok = Boolean(again?.ok || Number(again?.emailSentAt));
                if (ok) break;
              } catch {
                // retry
              }
              try {
                const { sendLicenseKeyEmail } = await import("../_brevo.js");
                const direct = await sendLicenseKeyEmail(mailLicense);
                if (direct?.ok) {
                  try {
                    const { markLicenseEmailSent } = await import(
                      "../licenses/_lib.js"
                    );
                    await markLicenseEmailSent(mailLicense.key, Date.now());
                  } catch {
                    // non-fatal
                  }
                  ok = true;
                  break;
                }
              } catch {
                // retry
              }
              await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
            }
          })()
        );
      }

      sendJson(res, 200, {
        ok: true,
        orderId,
        email: fulfilled.email,
        purpose: isGiveaway ? "giveaway" : "robot",
        accessPaid: true,
        licenseKey: fulfilled.key || fulfilled.license?.key || null,
        license: fulfilled.license
          ? {
              key: fulfilled.license.key,
              botName: fulfilled.license.botName,
              clientEmail: fulfilled.license.clientEmail,
            }
          : fulfilled.key
            ? {
                key: fulfilled.key,
                botName: "ZETA SCALPER AI",
                clientEmail: fulfilled.email,
              }
            : null,
        reused: Boolean(fulfilled.reused),
        emailSent,
        whatsappUrl:
          "https://chat.whatsapp.com/DxPeaEnyFRtDIlTWth4kLs?mode=gi_t",
        captureStatus: capture.status,
      });
      return;
    }

    if (!isLifetimeAmountPaid(capture)) {
      sendJson(res, 402, {
        error: "Payment amount did not match lifetime access price",
      });
      return;
    }

    const email = extractCaptureEmail(capture) || fallbackEmail;
    if (!email || !email.includes("@")) {
      sendJson(res, 400, { error: "Paid, but no email was linked to the order" });
      return;
    }

    // Only the PayPal order purpose unlocks scanner — never app-access payment,
    // even when the client sends purpose=scanner by mistake.
    const scannerPaid = purposeFromOrder === "scanner";

    await upsertSignup(email, { status: "pending" });
    let signup = await setSignupStatus(email, "approved");
    if (scannerPaid) {
      signup = await setSignupPremiumScanner(email, true);
    } else {
      // App-access lifetime payment — required for mentor commission eligibility.
      signup = await setSignupAccessPaid(email, true);
      try {
        const { reconcileCommissionForEmail } = await import(
          "../licenses/_lib.js"
        );
        await reconcileCommissionForEmail(email);
      } catch {
        // Commission backfill is best-effort; payment already succeeded.
      }
    }

    sendJson(res, 200, {
      ok: true,
      orderId,
      email,
      purpose: scannerPaid ? "scanner" : "access",
      premiumScanner: Boolean(signup?.premiumScanner),
      accessPaid: Boolean(signup?.accessPaid),
      signup,
      captureStatus: capture.status,
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Could not capture PayPal payment",
      details: error.data || null,
    });
  }
}
