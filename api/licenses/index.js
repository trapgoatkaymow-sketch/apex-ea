import { endOptions } from "../_cors.js";
import {
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

export const config = { maxDuration: 60 };

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
      if (action === "bulk" || Array.isArray(body?.clients)) {
        const result = await createLicensesBulk(body);
        sendJson(res, 200, result);
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
          })
        : await markLicenseUsed(body.key, {
            deviceId: body.deviceId || "",
            email: body.email || body.clientEmail || "",
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
      error: error.message || "License sync failed",
      details: error.data || null,
    });
  }
}
