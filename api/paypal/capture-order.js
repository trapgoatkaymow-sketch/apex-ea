import { endOptions } from "../_cors.js";
import {
  captureLifetimeOrder,
  extractCaptureEmail,
  extractCapturePurpose,
  isCaptureCompleted,
  isLifetimeAmountPaid,
  readJsonBody,
  sendJson,
} from "./_lib.js";
import {
  setSignupAccessPaid,
  setSignupPremiumScanner,
  setSignupStatus,
  upsertSignup,
} from "../signups/_lib.js";

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
    const orderId = String(body.orderId || body.id || "").trim();
    const fallbackEmail = String(body.email || "")
      .trim()
      .toLowerCase();

    const capture = await captureLifetimeOrder(orderId);
    if (!isCaptureCompleted(capture)) {
      sendJson(res, 402, {
        error: "Payment was not completed",
        status: capture?.status || null,
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
    const purposeFromOrder = extractCapturePurpose(capture);
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
