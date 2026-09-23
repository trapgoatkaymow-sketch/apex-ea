import { endOptions } from "../_cors.js";
import {
  listSignups,
  readJsonBody,
  sendJson,
  setSignupAccessBypassed,
  setSignupAccessPaid,
  setSignupAppAccessUnlocked,
  setSignupPremiumScanner,
  setSignupStatus,
  upsertSignup,
  revokeClientAccessBypasses,
} from "./_lib.js";
import {
  listMentors,
  SUPER_ADMIN_EMAIL,
} from "../mentors/_lib.js";
export const config = { maxDuration: 60 };

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function assertSuperAdmin(adminEmail) {
  const admin = normalizeEmail(adminEmail);
  const superAdmin = normalizeEmail(SUPER_ADMIN_EMAIL);
  if (!admin || admin !== superAdmin) {
    const err = new Error("Only super admin can revoke bypassed clients");
    err.status = 403;
    throw err;
  }
}

async function entitleIfLicenseOwner(email, signup) {
  const key = String(email || "")
    .trim()
    .toLowerCase();
  if (!key.includes("@")) return signup;
  if (
    signup &&
    (signup.accessPaid ||
      String(signup.status || "").toLowerCase() === "approved" ||
      signup.appAccessUnlockedAt)
  ) {
    return signup;
  }
  try {
    const { findLicensesByEmail } = await import("../licenses/_lib.js");
    const owned = await findLicensesByEmail(key);
    if (!owned?.length) return signup;
    // Reinstall with an existing license: unlock app access without marking
    // PayPal accessPaid (keeps mentor commission accurate).
    await setSignupStatus(key, "approved");
    return (await setSignupAppAccessUnlocked(key)) || signup;
  } catch {
    return signup;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  try {
    if (req.method === "GET") {
      const signups = await listSignups();
      sendJson(res, 200, { signups });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      let signup = await upsertSignup(body.email, {
        status: body.status || "pending",
      });
      // Old clients who already own a license skip the paywall on reinstall.
      signup = await entitleIfLicenseOwner(body.email, signup);
      sendJson(res, 200, { signup });
      return;
    }

    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      if (body.premiumScanner === true || body.action === "premiumScanner") {
        // Single write — setSignupPremiumScanner also approves the account.
        const signup = await setSignupPremiumScanner(body.email, true);
        sendJson(res, 200, { signup, premiumScanner: true });
        return;
      }
      if (
        body.accessPaid === true ||
        body.action === "accessPaid" ||
        body.action === "markPaid"
      ) {
        const signup = await setSignupAccessPaid(body.email, true);
        try {
          const { reconcileCommissionForEmail } = await import(
            "../licenses/_lib.js"
          );
          await reconcileCommissionForEmail(body.email);
        } catch {
          // Best-effort backfill after payment mark.
        }
        sendJson(res, 200, { signup, accessPaid: true });
        return;
      }
      if (
        body.accessBypassed === true ||
        body.action === "accessBypassed" ||
        body.action === "bypass" ||
        body.action === "accessBypass"
      ) {
        const signup = await setSignupAccessBypassed(body.email, true);
        sendJson(res, 200, { signup, accessBypassed: true });
        return;
      }
      if (
        body.accessBypassed === false ||
        body.action === "clearAccessBypass" ||
        body.action === "removeAccessBypass" ||
        body.action === "clearBypass"
      ) {
        const signup = await setSignupAccessBypassed(body.email, false);
        sendJson(res, 200, { signup, accessBypassed: false });
        return;
      }
      if (
        body.action === "revokeAllBypasses" ||
        body.action === "revoke-bypassed" ||
        body.action === "removeAllBypassed"
      ) {
        assertSuperAdmin(body.adminEmail || body.actorEmail || body.by || "");
        const mentors = await listMentors();
        const keepEmails = [
          SUPER_ADMIN_EMAIL,
          ...(Array.isArray(mentors) ? mentors : []).map((m) => m.email),
          ...(Array.isArray(body.keepEmails) ? body.keepEmails : []),
        ];
        const result = await revokeClientAccessBypasses({ keepEmails });
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      const signup = await setSignupStatus(body.email, body.status);
      sendJson(res, 200, { signup });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Signup API failed",
      details: error.data || null,
    });
  }
}
