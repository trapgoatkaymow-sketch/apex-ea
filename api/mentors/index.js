import { endOptions } from "../_cors.js";
import {
  listMentors,
  loginMentor,
  readJsonBody,
  registerMentor,
  sendJson,
  setMentorLicenseKeys,
  setMentorPassword,
  setMentorStatus,
  updateMentorBanking,
  updateMentorProfile,
} from "./_lib.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  try {
    if (req.method === "GET") {
      const mentors = await listMentors();
      sendJson(res, 200, { mentors });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const action = String(body.action || body.type || "register").toLowerCase();

      if (action === "login") {
        const mentor = await loginMentor({
          email: body.email,
          password: body.password,
        });
        sendJson(res, 200, { mentor });
        return;
      }

      if (action === "register") {
        const mentor = await registerMentor({
          username: body.username,
          email: body.email,
          contact: body.contact || body.contactNumber || body.phone,
          password: body.password,
        });
        sendJson(res, 200, { mentor });
        return;
      }

      if (action === "banking") {
        const mentor = await updateMentorBanking(body.email, body.banking || body);
        sendJson(res, 200, { mentor });
        return;
      }

      if (action === "profile") {
        const mentor = await updateMentorProfile(body.email, body.profile || body);
        sendJson(res, 200, { mentor });
        return;
      }

      if (action === "license-keys" || action === "licensekeys" || action === "keys") {
        const mentor = await setMentorLicenseKeys(body.email, {
          set: body.set ?? body.licenseKeysAllowed ?? body.total,
          add: body.add ?? body.keysToAdd,
        });
        sendJson(res, 200, { mentor });
        return;
      }

      if (
        action === "set-password" ||
        action === "password" ||
        action === "reset-password"
      ) {
        const mentor = await setMentorPassword({
          adminEmail: body.adminEmail || body.actorEmail || body.by || "",
          email: body.email,
          password: body.password || body.newPassword,
          currentPassword: body.currentPassword || body.oldPassword || "",
        });
        sendJson(res, 200, { mentor, passwordSet: true });
        return;
      }

      sendJson(res, 400, { error: "Unknown action" });
      return;
    }

    if (req.method === "PATCH") {
      const body = await readJsonBody(req);
      const action = String(body.action || body.type || "status").toLowerCase();

      if (action === "banking") {
        const mentor = await updateMentorBanking(body.email, body.banking || body);
        sendJson(res, 200, { mentor });
        return;
      }

      if (action === "profile") {
        const mentor = await updateMentorProfile(body.email, body.profile || body);
        sendJson(res, 200, { mentor });
        return;
      }

      if (action === "license-keys" || action === "licensekeys" || action === "keys") {
        const mentor = await setMentorLicenseKeys(body.email, {
          set: body.set ?? body.licenseKeysAllowed ?? body.total,
          add: body.add ?? body.keysToAdd,
        });
        sendJson(res, 200, { mentor });
        return;
      }

      const mentor = await setMentorStatus(body.email, body.status);
      sendJson(res, 200, { mentor });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Mentor sync failed",
      details: error.data || null,
    });
  }
}
