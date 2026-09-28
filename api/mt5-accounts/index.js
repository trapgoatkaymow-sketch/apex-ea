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

export const config = { maxDuration: 60 };

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/** Short in-instance cache so fan-out / polls do not re-hit GitHub every time. */
const CACHE_TTL_MS = 20_000;
let mentorsCache = { at: 0, rows: null };
let licensesCache = { at: 0, rows: null };

async function cachedMentors() {
  if (
    Array.isArray(mentorsCache.rows) &&
    Date.now() - mentorsCache.at < CACHE_TTL_MS
  ) {
    return mentorsCache.rows;
  }
  const rows = await listMentors();
  mentorsCache = { at: Date.now(), rows };
  return rows;
}

async function cachedLicenses() {
  if (
    Array.isArray(licensesCache.rows) &&
    Date.now() - licensesCache.at < CACHE_TTL_MS
  ) {
    return licensesCache.rows;
  }
  const rows = await listLicenses();
  licensesCache = { at: Date.now(), rows };
  return rows;
}

async function assertApprovedMentor(email) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("mentorEmail is required");
    err.status = 400;
    throw err;
  }
  const mentors = await cachedMentors();
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
    mentorEmail: normalizeEmail(row.mentorEmail),
    source: "license",
  };
}

/** Soft-timeout registry read so a hung GitHub fallback cannot burn the whole invoke. */
async function listRegistryAccountsFast() {
  try {
    return await Promise.race([
      listMt5Accounts(),
      new Promise((resolve) => setTimeout(() => resolve([]), 8_000)),
    ]);
  } catch {
    return [];
  }
}

/**
 * Build connected robot accounts for one mentor (or all approved mentors).
 * Loads licenses/mentors/registry once — never N times per mentor fan-out.
 */
async function listAccountsScoped({ mentorEmail = "", all = false } = {}) {
  const mentors = await cachedMentors();
  const licenses = await cachedLicenses();
  const registry = await listRegistryAccountsFast();

  let mentorFilter = null;
  if (!all) {
    const mentor = await assertApprovedMentor(mentorEmail);
    mentorFilter = new Set([normalizeEmail(mentor.email)]);
  } else {
    mentorFilter = new Set(
      mentors
        .filter((m) => {
          const role = String(m.role || "").toLowerCase();
          const status = String(m.status || "").toLowerCase();
          if (role === "superadmin") return false;
          return status === "approved";
        })
        .map((m) => normalizeEmail(m.email))
        .filter(Boolean)
    );
  }

  const clientMeta = new Map(); // clientEmail -> { mentorEmail, clientName }
  const byEmail = new Map();

  for (const row of licenses) {
    const mentor = normalizeEmail(row.mentorEmail);
    if (!mentor || !mentorFilter.has(mentor)) continue;
    const clientEmail = normalizeEmail(row.clientEmail);
    if (!clientEmail) continue;
    if (!clientMeta.has(clientEmail)) {
      clientMeta.set(clientEmail, {
        mentorEmail: mentor,
        clientName: String(row.clientName || row.mainText || "").trim(),
      });
    }
    const fromLicense = accountFromLicense(
      row,
      clientMeta.get(clientEmail)?.clientName || ""
    );
    if (fromLicense) {
      const prev = byEmail.get(clientEmail);
      if (!prev || (fromLicense.updatedAt || 0) >= (prev.updatedAt || 0)) {
        byEmail.set(clientEmail, {
          ...fromLicense,
          mentorEmail: mentor,
        });
      }
    }
  }

  for (const row of registry) {
    const item = normalizeMt5Account(row);
    if (!item || !clientMeta.has(item.email)) continue;
    const meta = clientMeta.get(item.email);
    if (!mentorFilter.has(meta.mentorEmail)) continue;
    const prev = byEmail.get(item.email);
    if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) {
      byEmail.set(item.email, {
        ...item,
        clientName: meta.clientName || "",
        mentorEmail: meta.mentorEmail,
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
      const all =
        url.searchParams.get("all") === "1" ||
        url.searchParams.get("scope") === "all";

      if (all) {
        const accounts = await listAccountsScoped({ all: true });
        sendJson(res, 200, { accounts, scoped: "all" });
        return;
      }

      if (mentorEmail) {
        const accounts = await listAccountsScoped({ mentorEmail });
        sendJson(res, 200, { accounts });
        return;
      }

      if (email) {
        const key = normalizeEmail(email);
        const accounts = (await listRegistryAccountsFast()).filter(
          (row) => normalizeEmail(row.email) === key
        );
        // Also surface durable license-stamped sessions for this email.
        if (!accounts.length) {
          const licenses = await cachedLicenses();
          for (const row of licenses) {
            if (normalizeEmail(row.clientEmail) !== key) continue;
            const fromLicense = accountFromLicense(row);
            if (fromLicense) accounts.push(fromLicense);
          }
        }
        sendJson(res, 200, { accounts });
        return;
      }

      sendJson(res, 400, { error: "mentorEmail, email, or all=1 is required" });
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
      // Invalidate short caches so the next GET sees the new session.
      licensesCache = { at: 0, rows: null };
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
      licensesCache = { at: 0, rows: null };
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
