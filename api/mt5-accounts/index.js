import { listLicenses, setLicenseRobotSession, clearLicenseRobotSession } from "../licenses/_lib.js";
import { listMentors } from "../mentors/_lib.js";
import { endOptions } from "../_cors.js";
import {
  listMt5Accounts,
  normalizeMt5Account,
  readJsonBody,
  removeMt5Account,
  sendJson,
  upsertMt5Account,
} from "./_lib.js";

export const config = { maxDuration: 30 };

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

async function assertApprovedMentor(email) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("mentorEmail is required");
    err.status = 400;
    throw err;
  }
  const mentors = await listMentors();
  const mentor = mentors.find((row) => normalizeEmail(row.email) === key);
  if (!mentor) {
    const err = new Error("Mentor not found");
    err.status = 404;
    throw err;
  }
  if (mentor.status !== "approved" && mentor.role !== "superadmin") {
    const err = new Error("Mentor account is not approved");
    err.status = 403;
    throw err;
  }
  return mentor;
}

function accountFromLicense(row, clientName = "") {
  const accountId = String(row?.robotAccountId || "").trim();
  const email = normalizeEmail(row?.clientEmail);
  if (!accountId || !email) return null;
  return {
    email,
    accountId,
    login: String(row.robotLogin || "").trim(),
    server: String(row.robotServer || "").trim(),
    company: String(row.robotCompany || "").trim(),
    platform: String(row.robotPlatform || "MT5").trim().toUpperCase() || "MT5",
    region: "",
    connectedAt: Number(row.robotConnectedAt) || Date.now(),
    updatedAt: Number(row.updatedAt || row.robotConnectedAt) || Date.now(),
    clientName: clientName || String(row.clientName || row.mainText || "").trim(),
    source: "license",
  };
}

async function listAccountsForMentor(mentorEmail) {
  const mentor = await assertApprovedMentor(mentorEmail);
  const licenses = await listLicenses();
  const clientMeta = new Map();
  const byEmail = new Map();

  for (const row of licenses) {
    if (normalizeEmail(row.mentorEmail) !== mentor.email) continue;
    const clientEmail = normalizeEmail(row.clientEmail);
    if (!clientEmail) continue;
    if (!clientMeta.has(clientEmail)) {
      clientMeta.set(clientEmail, {
        clientEmail,
        clientName: String(row.clientName || row.mainText || "").trim(),
      });
    }
    // Durable source: robot session stamped onto the license at connect time.
    const fromLicense = accountFromLicense(
      row,
      clientMeta.get(clientEmail)?.clientName || ""
    );
    if (fromLicense) {
      const prev = byEmail.get(clientEmail);
      if (!prev || (fromLicense.updatedAt || 0) >= (prev.updatedAt || 0)) {
        byEmail.set(clientEmail, fromLicense);
      }
    }
  }

  // Ephemeral per-instance registry (best-effort merge).
  const accounts = await listMt5Accounts();
  for (const row of accounts) {
    const item = normalizeMt5Account(row);
    if (!item || !clientMeta.has(item.email)) continue;
    const prev = byEmail.get(item.email);
    if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) {
      byEmail.set(item.email, {
        ...item,
        clientName: clientMeta.get(item.email)?.clientName || "",
        source: "registry",
      });
    }
  }

  return Array.from(byEmail.values()).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
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
      const mentorEmail = url.searchParams.get("mentorEmail") || "";
      const email = url.searchParams.get("email") || "";

      if (mentorEmail) {
        const accounts = await listAccountsForMentor(mentorEmail);
        sendJson(res, 200, { accounts });
        return;
      }

      if (email) {
        const key = normalizeEmail(email);
        const accounts = (await listMt5Accounts()).filter(
          (row) => normalizeEmail(row.email) === key
        );
        // Also surface durable license-stamped sessions for this email.
        if (!accounts.length) {
          const licenses = await listLicenses();
          for (const row of licenses) {
            if (normalizeEmail(row.clientEmail) !== key) continue;
            const fromLicense = accountFromLicense(row);
            if (fromLicense) accounts.push(fromLicense);
          }
        }
        sendJson(res, 200, { accounts });
        return;
      }

      sendJson(res, 400, { error: "mentorEmail or email query is required" });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const account = await upsertMt5Account(body);
      // Stamp onto licenses so mentor-trade (separate serverless fn) can see it.
      if (account?.accountId && account?.email) {
        try {
          await setLicenseRobotSession(account.email, account);
        } catch {
          // best-effort — registry row still returned
        }
      }
      sendJson(res, 200, { account });
      return;
    }

    if (req.method === "DELETE") {
      const body = await readJsonBody(req);
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      const email = body.email || url.searchParams.get("email") || "";
      const result = await removeMt5Account(email);
      try {
        await clearLicenseRobotSession(email);
      } catch {
        // best-effort
      }
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "MT5 account sync failed",
      details: error.data || null,
    });
  }
}
