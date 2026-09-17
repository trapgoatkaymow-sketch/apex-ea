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
  listDeletedKeys,
  listLicenses,
  markLicenseUsed,
  readJsonBody,
  sendJson,
} from "./_lib.js";
import { SUPER_ADMIN_EMAIL } from "../mentors/_lib.js";

export const config = { maxDuration: 60 };

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
      if (
        action === "create-migrate-link" ||
        action === "migratelink" ||
        action === "free-migrate-link"
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
            error: "Only admin can create timed free-migrate links",
          });
          return;
        }
        const { buildMigrateLinkUrl } = await import("./_migrateLink.js");
        const minutes = Math.min(180, Math.max(5, Number(body.minutes) || 30));
        const built = buildMigrateLinkUrl({
          origin: body.origin || "https://www.apex-ea.com",
          invite: body.invite || body.inviteCode,
          botId: body.botId || body.bot,
          botName: body.botName || "ZETA SCALPER AI",
          duration: body.duration || "lifetime",
          minutes,
        });
        sendJson(res, 200, {
          ok: true,
          ...built,
          minutes,
          expiresInMinutes: minutes,
        });
        return;
      }
      const license = await createLicense(body);
      sendJson(res, 200, { license });
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
      const shouldDeactivate =
        action === "deactivate" || body.used === false || body.deactivate === true;
      const license = shouldDeactivate
        ? await deactivateLicense(body.key, {
            adminEmail: body.adminEmail || body.email || "",
            clientEmail: body.clientEmail || body.licenseEmail || "",
            clientName: body.clientName || "",
            botId: body.botId || body.bot?.id || "",
            botName: body.botName || body.bot?.name || "",
          })
        : await markLicenseUsed(body.key, {
            deviceId: body.deviceId || "",
            email: body.email || body.clientEmail || "",
            seed: body.license || body.seed || null,
            botId: body.botId || body.bot?.id || "",
            botName: body.botName || body.bot?.name || "",
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
