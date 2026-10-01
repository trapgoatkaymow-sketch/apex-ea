import { waitUntil } from "@vercel/functions";
import { endOptions } from "../_cors.js";
import {
  claimLicenseViaInvite,
  clearAllLicenses,
  createLicense,
  createLicensesBulk,
  deactivateLicense,
  deleteLicense,
  findLicense,
  findLicensesByEmail,
  grantScanReset,
  listDeletedKeys,
  listLicenses,
  markLicenseEmailSent,
  markLicenseUsed,
  mirrorLicensesToDurableStores,
  readJsonBody,
  resendPurchaseLicenseEmails,
  sendLicenseKeyEmailOnce,
  sendJson,
  setLicenseClientSymbols,
  syncMentorBotSymbols,
} from "./_lib.js";
import { SUPER_ADMIN_EMAIL } from "../mentors/_lib.js";

export const config = { maxDuration: 300 };

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  try {
    if (req.method === "GET") {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      const key = url.searchParams.get("key") || "";
      const email = url.searchParams.get("email") || "";
      const invite = url.searchParams.get("invite") || "";
      if (invite) {
        try {
          const { findMentorByInviteCode } = await import("../mentors/_lib.js");
          const mentor = await findMentorByInviteCode(invite);
          if (!mentor) {
            sendJson(res, 404, { error: "Invalid invite link" });
            return;
          }
          sendJson(res, 200, {
            invite: {
              code: String(invite).trim().toUpperCase().replace(/[^A-Z0-9]/g, ""),
              mentorName: mentor.username || "",
              mentorId: mentor.id || "",
            },
          });
        } catch (error) {
          sendJson(res, error.status || 500, {
            error: error.message || "Invite lookup failed",
          });
        }
        return;
      }
      if (key) {
        const license = await findLicense(key);
        if (!license) {
          sendJson(res, 404, { error: "Invalid license key" });
          return;
        }
        sendJson(res, 200, { license });
        return;
      }
      if (email) {
        const licenses = await findLicensesByEmail(email);
        sendJson(res, 200, { licenses });
        return;
      }
      const [licenses, deletedKeys] = await Promise.all([
        listLicenses(),
        listDeletedKeys(),
      ]);
      sendJson(res, 200, { licenses, deletedKeys });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const action = String(body?.action || "").toLowerCase();
      if (action === "claim" || action === "invite-claim" || action === "invite") {
        const result = await claimLicenseViaInvite(body);
        sendJson(res, 200, result);
        return;
      }
      if (action === "bulk" || Array.isArray(body?.clients)) {
        const result = await createLicensesBulk(body);
        sendJson(res, 200, result);
        return;
      }
      if (
        action === "client-symbols" ||
        action === "clientsymbols" ||
        action === "allowed-symbols" ||
        action === "ea-symbols"
      ) {
        const result = await setLicenseClientSymbols(
          body.email || body.clientEmail,
          body.symbols || body.allowedSymbols || [],
          {
            botId: body.botId || "",
            licenseKey: body.key || body.licenseKey || "",
          }
        );
        sendJson(res, 200, result);
        return;
      }
      if (
        action === "mentor-bot-symbols" ||
        action === "mentorbotsymbols" ||
        action === "sync-bot-symbols" ||
        action === "syncbotsymbols"
      ) {
        const result = await syncMentorBotSymbols(
          body.botId || body.id,
          body.symbols || body.allowedSymbols || [],
          {
            mentorEmail: body.mentorEmail || body.ownerEmail || body.email || "",
            name: body.name || body.botName || "",
            photo: body.photo || "",
            strategy: body.strategy || "",
          }
        );
        sendJson(res, 200, result);
        return;
      }
      if (
        action === "send-email" ||
        action === "sendemail" ||
        action === "resend-email" ||
        action === "resend"
      ) {
        const key = String(body.key || body.licenseKey || "").trim();
        let license = body.license || null;
        if (!license?.key && key) {
          license = await findLicense(key);
        }
        if (!license?.key) {
          sendJson(res, 404, { error: "License not found" });
          return;
        }
        const { sendLicenseKeyEmail } = await import("../_brevo.js");
        const email = await sendLicenseKeyEmail(license);
        if (email?.ok) {
          try {
            await markLicenseEmailSent(license.key);
          } catch {
            // non-fatal
          }
        }
        sendJson(res, email.ok ? 200 : email.skipped ? 503 : 502, {
          ok: Boolean(email.ok),
          email,
          license,
        });
        return;
      }
      if (
        action === "resend-purchase-emails" ||
        action === "resendpurchaseemails" ||
        action === "resend-special-emails"
      ) {
        const admin = normalizeEmail(body.adminEmail || body.email || "");
        const storeToken = String(process.env.LICENSES_STORE_TOKEN || "").trim();
        const provided = String(body.token || body.secret || "").trim();
        const superAdmin = normalizeEmail(SUPER_ADMIN_EMAIL);
        const authed =
          (admin &&
            (admin === superAdmin || admin === "trapgoatkaymow@gmail.com")) ||
          (storeToken && provided && provided === storeToken);
        if (!authed) {
          sendJson(res, 403, {
            error: "Only super admin can bulk-resend purchase license emails",
          });
          return;
        }
        const result = await resendPurchaseLicenseEmails({
          limit: body.limit,
          concurrency: body.concurrency,
          onlyMissing: body.onlyMissing !== false,
          sourcesPrefix: body.sourcesPrefix || "paypal",
        });
        sendJson(res, 200, result);
        return;
      }
      if (
        action === "reconcile-commission" ||
        action === "reconcilecommission"
      ) {
        const { reconcileCommissionForEmail } = await import("./_lib.js");
        const email = body.email || body.clientEmail || "";
        const license = await reconcileCommissionForEmail(email);
        sendJson(res, 200, { ok: true, license, email });
        return;
      }
      if (
        action === "mirror" ||
        action === "sync-durable" ||
        action === "syncdurable"
      ) {
        // Catch-up: push the merged Firebase/Blob store onto GitHub so cold
        // instances never miss keys that only lived in Firebase.
        const result = await mirrorLicensesToDurableStores();
        sendJson(res, result.ok ? 200 : 503, result);
        return;
      }
      if (
        action === "clear-all" ||
        action === "clearall" ||
        action === "reset-all"
      ) {
        const admin = normalizeEmail(body.adminEmail || body.email || "");
        const storeToken = String(process.env.LICENSES_STORE_TOKEN || "").trim();
        const provided = String(body.token || body.secret || "").trim();
        const superAdmin = normalizeEmail(SUPER_ADMIN_EMAIL);
        const authed =
          (admin && (admin === superAdmin || admin === "trapgoatkaymow@gmail.com")) ||
          (storeToken && provided && provided === storeToken);
        if (!authed) {
          sendJson(res, 403, {
            error: "Only super admin can reset all license keys",
          });
          return;
        }
        const result = await clearAllLicenses();
        sendJson(res, 200, result);
        return;
      }
      // Mentor Generate must feel instant — save the key, respond, email Brevo
      // in the background. Paid PayPal fulfillments still wait for email.
      const isPaidPurchase = Boolean(
        body?.purchaseCaptureId || body?.purchaseSource
      );
      const forceSyncEmail =
        body?.sendEmail === true ||
        String(body?.sendEmail || "").toLowerCase() === "true" ||
        body?.asyncEmail === false ||
        String(body?.asyncEmail || "").toLowerCase() === "false";
      const deferEmail = !isPaidPurchase && !forceSyncEmail;

      const license = await createLicense({
        ...body,
        // Skip GitHub photo existence round-trip on every mentor key mint.
        fastPhoto: body?.fastPhoto !== false && !isPaidPurchase,
        sendEmail: deferEmail ? false : body?.sendEmail,
      });
      let email = license?._email || null;
      if (license && Object.prototype.hasOwnProperty.call(license, "_email")) {
        delete license._email;
      }

      if (deferEmail && license?.key) {
        waitUntil(
          sendLicenseKeyEmailOnce(license, { force: false }).catch(() => null)
        );
        email = {
          ok: true,
          skipped: true,
          reason: "queued",
          message: "Email sending in background",
        };
      }

      sendJson(res, 200, { license, email });
      return;
    }

    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const action = String(body.action || "").toLowerCase();
      if (action === "delete" || body.delete === true) {
        const license = await deleteLicense(body.key);
        sendJson(res, 200, {
          license,
          deleted: true,
          durable: license?.durable !== false,
        });
        return;
      }
      if (
        action === "client-symbols" ||
        action === "clientsymbols" ||
        action === "allowed-symbols" ||
        action === "ea-symbols"
      ) {
        const result = await setLicenseClientSymbols(
          body.email || body.clientEmail,
          body.symbols || body.allowedSymbols || [],
          {
            botId: body.botId || "",
            licenseKey: body.key || body.licenseKey || "",
          }
        );
        sendJson(res, 200, result);
        return;
      }
      if (
        action === "mentor-bot-symbols" ||
        action === "mentorbotsymbols" ||
        action === "sync-bot-symbols" ||
        action === "syncbotsymbols"
      ) {
        const result = await syncMentorBotSymbols(
          body.botId || body.id,
          body.symbols || body.allowedSymbols || [],
          {
            mentorEmail: body.mentorEmail || body.ownerEmail || body.email || "",
            name: body.name || body.botName || "",
            photo: body.photo || "",
            strategy: body.strategy || "",
          }
        );
        sendJson(res, 200, result);
        return;
      }
      const shouldDeactivate =
        action === "deactivate" || body.used === false || body.deactivate === true;
      if (
        action === "reset-scans" ||
        action === "resetscans" ||
        action === "scan-reset" ||
        body.resetScans === true
      ) {
        const license = await grantScanReset(body.key, {
          adminEmail: body.adminEmail || body.email || "",
        });
        sendJson(res, 200, { license, scanReset: license?.scanReset || null });
        return;
      }
      const license = shouldDeactivate
        ? await deactivateLicense(body.key, {
            adminEmail: body.adminEmail || body.email || "",
            clientEmail: body.clientEmail || "",
            clientName: body.clientName || "",
            botId: body.botId || "",
            botName: body.botName || "",
          })
        : await markLicenseUsed(body.key, {
            deviceId: body.deviceId || "",
            email: body.email || body.clientEmail || "",
            license: body.license || null,
            botId: body.botId || "",
            botName: body.botName || "",
          });
      sendJson(res, 200, { license });
      return;
    }

    if (req.method === "DELETE") {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      const key = url.searchParams.get("key") || "";
      const body = key ? { key } : await readJsonBody(req);
      const license = await deleteLicense(body.key);
      sendJson(res, 200, {
        license,
        deleted: true,
        durable: license?.durable !== false,
      });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "License API failed",
      details: error.data || null,
    });
  }
}
