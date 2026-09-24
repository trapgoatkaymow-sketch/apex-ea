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
    const isRobot =
      purposeHint === "robot" ||
      purposeHint === "license" ||
      isRobotPurchaseCapture(capture, { purposeHint });

    if (isRobot) {
      const email = extractCaptureEmail(capture) || fallbackEmail;
      const clientName = extractCaptureClientName(capture) || fallbackName;
      const fulfilled = await fulfillRobotPurchase({
        email,
        clientName,
        captureId: extractCaptureId(capture),
        orderId,
        source: "paypal-order",
      });
      sendJson(res, 200, {
        ok: true,
        orderId,
        email: fulfilled.email,
        purpose: "robot",
        accessPaid: true,
        licenseKey: fulfilled.key,
        license: fulfilled.license
          ? {
              key: fulfilled.license.key,
              botName: fulfilled.license.botName,
              clientEmail: fulfilled.license.clientEmail,
            }
          : null,
        reused: Boolean(fulfilled.reused),
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
