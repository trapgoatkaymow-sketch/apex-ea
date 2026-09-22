import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/mentors";
const LOCAL_KEY = "apexea-mentors-v1";

export const SUPER_ADMIN_EMAIL = "trapgoatkaymow22@icloud.com";
export const SUPER_ADMIN_PASSWORD = "Admin12";
export const SUPER_ADMIN_USERNAME = "APEX EA";
export const DEFAULT_MENTOR_LICENSE_KEYS = 1500;

async function apiFetch(path = "", { method = "GET", body } = {}) {
  const response = await fetch(`${apiUrl(API_PATH)}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      (data && (data.error || data.message)) ||
      (typeof data === "string" ? data : `Mentor sync failed (${response.status})`);
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function readLocalMentors() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed?.mentors) ? parsed.mentors : [];
  } catch {
    return [];
  }
}

function writeLocalMentors(mentors) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ mentors }));
}

function emptyBanking() {
  return {
    accountName: "",
    bankName: "",
    accountNumber: "",
    branchCode: "",
    accountType: "",
    updatedAt: null,
  };
}

function normalizeBanking(raw = {}) {
  if (!raw || typeof raw !== "object") return emptyBanking();
  return {
    accountName: String(raw.accountName || "").trim(),
    bankName: String(raw.bankName || "").trim(),
    accountNumber: String(raw.accountNumber || "").trim(),
    branchCode: String(raw.branchCode || "").trim(),
    accountType: String(raw.accountType || "").trim(),
    updatedAt: raw.updatedAt ? Number(raw.updatedAt) : null,
  };
}

function normalizeLicenseKeysAllowed(value, { role } = {}) {
  if (String(role || "").toLowerCase() === "superadmin") return null;
  if (value == null || value === "") return DEFAULT_MENTOR_LICENSE_KEYS;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MENTOR_LICENSE_KEYS;
  return n;
}

function publicLocal(mentor) {
  if (!mentor) return null;
  const role = mentor.role || "mentor";
  const id = String(mentor.id || "");
  const inviteFromId = id
    .replace(/-/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return {
    id: mentor.id,
    username: mentor.username,
    email: mentor.email,
    contact: mentor.contact || "",
    role,
    status: mentor.status || "pending",
    createdAt: mentor.createdAt || Date.now(),
    banking: normalizeBanking(mentor.banking),
    licenseKeysAllowed: normalizeLicenseKeysAllowed(mentor.licenseKeysAllowed, {
      role,
    }),
    licenseKeysUpdatedAt: Number(mentor.licenseKeysUpdatedAt) || null,
    inviteCode: String(mentor.inviteCode || inviteFromId || "").trim().toUpperCase(),
    appColor: normalizeLocalAppColor(mentor.appColor),
  };
}

function normalizeLocalAppColor(raw) {
  let value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  if (!value.startsWith("#")) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/.test(value)) return "";
  return value;
}

function ensureLocalSuperAdmin(list) {
  const mentors = Array.isArray(list) ? [...list] : [];
  const email = normalizeEmail(SUPER_ADMIN_EMAIL);
  const idx = mentors.findIndex((m) => m.email === email);
  const record = {
    id: "super-admin",
    username: SUPER_ADMIN_USERNAME,
    email,
    contact: "",
    role: "superadmin",
    status: "approved",
    password: SUPER_ADMIN_PASSWORD,
    createdAt: idx >= 0 ? mentors[idx].createdAt || Date.now() : Date.now(),
  };
  if (idx >= 0) mentors[idx] = { ...mentors[idx], ...record };
  else mentors.unshift(record);
  return mentors;
}

function pickBanking(item, prev) {
  const next = normalizeBanking(item?.banking);
  const old = normalizeBanking(prev?.banking);
  if (next.accountNumber && next.updatedAt && old.updatedAt && next.updatedAt >= old.updatedAt) {
    return next;
  }
  if (old.accountNumber && next.accountNumber && old.updatedAt && next.updatedAt && old.updatedAt > next.updatedAt) {
    return old;
  }
  if (next.accountNumber) return next;
  if (old.accountNumber) return old;
  if (next.updatedAt && (!old.updatedAt || next.updatedAt >= old.updatedAt)) return next;
  return old.accountName || old.bankName ? old : next;
}

const BANKING_CACHE_KEY = "apexea-mentor-banking-v1";

function readBankingCache() {
  try {
    const raw = localStorage.getItem(BANKING_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeBankingCache(email, banking) {
  const key = normalizeEmail(email);
  if (!key) return;
  const all = readBankingCache();
  all[key] = normalizeBanking(banking);
  try {
    localStorage.setItem(BANKING_CACHE_KEY, JSON.stringify(all));
  } catch {
    // ignore quota / private mode
  }
}

function bankingFromCache(email) {
  const key = normalizeEmail(email);
  if (!key) return normalizeBanking();
  return normalizeBanking(readBankingCache()[key]);
}

function preferMentorStatus(incoming, previous) {
  const rank = (status) => {
    const s = String(status || "").toLowerCase();
    if (s === "approved") return 3;
    if (s === "declined") return 2;
    if (s === "pending") return 1;
    return 0;
  };
  if (rank(incoming) >= rank(previous)) {
    return String(incoming || previous || "pending").toLowerCase();
  }
  return String(previous || incoming || "pending").toLowerCase();
}

function mergeMentorLists(localList = [], remoteList = []) {
  const map = new Map();
  // Local first, then remote wins on the same email so GitHub stays source of truth
  // while still keeping locally registered mentors that are not remote yet.
  for (const item of [...localList, ...remoteList]) {
    const email = normalizeEmail(item?.email);
    if (!email) continue;
    const prev = map.get(email);
    map.set(email, {
      id: item.id || prev?.id || email,
      username: item.username || prev?.username || "Mentor",
      email,
      contact: item.contact || prev?.contact || "",
      role:
        String(item.role || prev?.role || "mentor").toLowerCase() === "superadmin"
          ? "superadmin"
          : "mentor",
      status: preferMentorStatus(item.status, prev?.status),
      password: item.password || prev?.password,
      createdAt: Number(item.createdAt || prev?.createdAt) || Date.now(),
      banking: pickBanking(item, prev),
      licenseKeysAllowed: normalizeLicenseKeysAllowed(
        item.licenseKeysAllowed ?? prev?.licenseKeysAllowed,
        {
          role:
            String(item.role || prev?.role || "mentor").toLowerCase() === "superadmin"
              ? "superadmin"
              : "mentor",
        }
      ),
      inviteCode: String(
        item.inviteCode ||
          prev?.inviteCode ||
          String(item.id || prev?.id || "")
            .replace(/-/g, "")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(0, 8)
      )
        .trim()
        .toUpperCase(),
      appColor: (() => {
        const incoming = normalizeLocalAppColor(item.appColor);
        const previous = normalizeLocalAppColor(prev?.appColor);
        if (!incoming) return previous || "";
        if (!previous) return incoming;
        if (incoming === previous) return incoming;
        const incomingAt = Number(item.appColorUpdatedAt || 0) || 0;
        const previousAt = Number(prev?.appColorUpdatedAt || 0) || 0;
        // Prefer the newer stamp; if remote omitted the stamp, still take remote
        // when it is the current `item` (remote wins pass).
        if (incomingAt || previousAt) {
          return incomingAt >= previousAt ? incoming : previous;
        }
        return incoming;
      })(),
      appColorUpdatedAt: (() => {
        const incoming = normalizeLocalAppColor(item.appColor);
        const previous = normalizeLocalAppColor(prev?.appColor);
        const incomingAt = Number(item.appColorUpdatedAt || 0) || 0;
        const previousAt = Number(prev?.appColorUpdatedAt || 0) || 0;
        if (incoming && previous && incoming !== previous) {
          return Math.max(incomingAt, previousAt) || Date.now();
        }
        return Math.max(incomingAt, previousAt) || 0;
      })(),
    });
  }
  return Array.from(map.values()).sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
  );
}

function cacheMentorLocally(mentor) {
  if (!mentor?.email) return;
  const mentors = ensureLocalSuperAdmin(readLocalMentors());
  const key = normalizeEmail(mentor.email);
  const idx = mentors.findIndex((m) => m.email === key);
  const banking = pickBanking(mentor, mentors[idx] || { banking: bankingFromCache(key) });
  const next = {
    id: mentor.id || `local-${Date.now()}`,
    username: mentor.username || "Mentor",
    email: key,
    contact: mentor.contact || "",
    role: mentor.role || "mentor",
    status: mentor.status || "pending",
    password: mentor.password,
    createdAt: mentor.createdAt || Date.now(),
    banking,
    licenseKeysAllowed: normalizeLicenseKeysAllowed(mentor.licenseKeysAllowed, {
      role: mentor.role || "mentor",
    }),
    appColor:
      normalizeLocalAppColor(mentor.appColor) ||
      normalizeLocalAppColor(mentors[idx]?.appColor) ||
      "",
    appColorUpdatedAt: Number(
      mentor.appColorUpdatedAt || mentors[idx]?.appColorUpdatedAt || 0
    ) || 0,
  };
  if (idx >= 0) mentors[idx] = { ...mentors[idx], ...next };
  else mentors.unshift(next);
  writeLocalMentors(mentors);
  if (banking.accountNumber) writeBankingCache(key, banking);
}

export async function fetchMentors() {
  const local = ensureLocalSuperAdmin(readLocalMentors()).map((m) => ({
    ...m,
    banking: pickBanking(m, { banking: bankingFromCache(m.email) }),
  }));
  try {
    const data = await apiFetch();
    const remote = Array.isArray(data?.mentors) ? data.mentors : [];
    const remoteEmails = new Set(
      remote.map((m) => normalizeEmail(m?.email)).filter(Boolean)
    );
    // Keep only local-only rows that still have a plaintext password from a
    // just-completed register (not yet visible on remote). Drop durable ghosts
    // that make Approve / Set password show "Mentor not found".
    const localKeep = local.filter((m) => {
      const email = normalizeEmail(m?.email);
      if (!email) return false;
      if (remoteEmails.has(email)) return true;
      if (email === normalizeEmail(SUPER_ADMIN_EMAIL)) return true;
      const pass = String(m?.password || "").trim();
      if (pass.length < 6) return false;
      const age = Date.now() - (Number(m.createdAt) || 0);
      return age >= 0 && age < 1000 * 60 * 60 * 24;
    });
    const merged = mergeMentorLists(localKeep, remote).map((m) => ({
      ...m,
      banking: pickBanking(m, { banking: bankingFromCache(m.email) }),
    }));
    writeLocalMentors(
      merged.map((m) => ({
        ...m,
        password:
          normalizeEmail(m.email) === normalizeEmail(SUPER_ADMIN_EMAIL)
            ? SUPER_ADMIN_PASSWORD
            : remoteEmails.has(normalizeEmail(m.email))
              ? undefined
              : m.password,
      }))
    );
    return merged.map(publicLocal);
  } catch {
    return local.map(publicLocal);
  }
}

export async function loginMentorAccount({ email, password }) {
  const key = normalizeEmail(email);
  const pass = String(password || "").trim();

  async function attempt() {
    const data = await apiFetch("", {
      method: "POST",
      body: { action: "login", email: key, password: pass },
    });
    const mentor = data?.mentor || null;
    if (!mentor) {
      throw new Error("Sign in failed — try again");
    }
    if (key === normalizeEmail(SUPER_ADMIN_EMAIL)) {
      return { ...mentor, email: key, role: "superadmin", status: "approved" };
    }
    return mentor;
  }

  try {
    try {
      return await attempt();
    } catch (firstError) {
      // One quiet retry on 401 only — cold instances sometimes serve a stale
      // hash once, then succeed after the store refreshes.
      if (firstError?.status === 401) {
        await new Promise((r) => setTimeout(r, 450));
        return await attempt();
      }
      throw firstError;
    }
  } catch (error) {
    // Local fallback (dev / offline) — never mask real API errors as bad password.
    if (key === normalizeEmail(SUPER_ADMIN_EMAIL) && pass === SUPER_ADMIN_PASSWORD) {
      return {
        id: "super-admin",
        username: SUPER_ADMIN_USERNAME,
        email: key,
        contact: "",
        role: "superadmin",
        status: "approved",
        createdAt: Date.now(),
      };
    }
    if (error?.status === 401 || error?.status === 403) {
      throw error;
    }
    const mentors = ensureLocalSuperAdmin(readLocalMentors());
    const mentor = mentors.find((m) => m.email === key);
    if (mentor && String(mentor.password || "").trim() === pass) {
      if (mentor.status !== "approved" && mentor.role !== "superadmin") {
        throw new Error("Account pending approval by super admin");
      }
      return publicLocal(mentor);
    }
    // Prefer the real server/network message over a fake "invalid password".
    throw error?.message
      ? error
      : new Error("Could not reach mentor login — check your connection and try again");
  }
}

/** Weekly used-key activity / deactivation countdown for mentors. */
export async function fetchMentorActivityRemote(email) {
  const key = normalizeEmail(email);
  if (!key.includes("@")) throw new Error("Enter a valid email");
  const data = await apiFetch("", {
    method: "POST",
    body: { action: "activity", email: key, enforce: true },
  });
  return data?.activity || null;
}

export async function registerMentorAccount({
  username,
  email,
  contact,
  password,
}) {
  const payload = {
    action: "register",
    username,
    email,
    contact,
    password,
  };

  try {
    const data = await apiFetch("", { method: "POST", body: payload });
    const mentor = data?.mentor || null;
    if (mentor) cacheMentorLocally({ ...mentor, password });
    return mentor;
  } catch (error) {
    // If remote says conflict / validation, surface it.
    if (error.status && error.status < 500) throw error;

    const key = normalizeEmail(email);
    const name = String(username || "").trim();
    const phone = String(contact || "").trim();
    const pass = String(password || "");
    if (!name) throw new Error("Enter a username");
    if (!key.includes("@")) throw new Error("Enter a valid email");
    if (phone.length < 7) throw new Error("Enter a valid contact number");
    if (pass.length < 6) throw new Error("Password must be at least 6 characters");
    if (key === normalizeEmail(SUPER_ADMIN_EMAIL)) {
      throw new Error("This email is reserved");
    }

    const mentors = ensureLocalSuperAdmin(readLocalMentors());
    if (mentors.some((m) => m.email === key)) {
      throw new Error("An account with this email already exists");
    }
    const created = {
      id: `local-${Date.now()}`,
      username: name,
      email: key,
      contact: phone,
      role: "mentor",
      status: "pending",
      password: pass,
      createdAt: Date.now(),
      licenseKeysAllowed: DEFAULT_MENTOR_LICENSE_KEYS,
    };
    mentors.unshift(created);
    writeLocalMentors(mentors);
    return publicLocal(created);
  }
}

export async function updateMentorStatus(email, status) {
  try {
    const data = await apiFetch("", {
      method: "PATCH",
      body: { email, status },
    });
    const mentor = data?.mentor || null;
    if (mentor && typeof data?.approvalEmailSent === "boolean") {
      mentor.approvalEmailSent = data.approvalEmailSent;
    }
    return mentor;
  } catch (error) {
    if (error.status && error.status < 500) throw error;
    const key = normalizeEmail(email);
    const mentors = ensureLocalSuperAdmin(readLocalMentors());
    const idx = mentors.findIndex((m) => m.email === key);
    if (idx < 0) throw new Error("Mentor not found");
    if (key === normalizeEmail(SUPER_ADMIN_EMAIL)) {
      throw new Error("Cannot change super admin status");
    }
    mentors[idx] = { ...mentors[idx], status };
    writeLocalMentors(mentors);
    return publicLocal(mentors[idx]);
  }
}

export async function updateMentorBanking(email, bankingInput = {}) {
  const banking = {
    ...normalizeBanking(bankingInput),
    updatedAt: Date.now(),
  };
  if (!banking.accountName || !banking.bankName || !banking.accountNumber) {
    throw new Error("Account name, bank name, and account number are required");
  }

  // Always cache immediately so polls / remounts cannot wipe the form.
  writeBankingCache(email, banking);

  try {
    const data = await apiFetch("", {
      method: "POST",
      body: { action: "banking", email, banking },
    });
    const mentor = data?.mentor || null;
    if (mentor) {
      const withBanking = {
        ...mentor,
        banking: pickBanking({ banking }, mentor),
      };
      cacheMentorLocally(withBanking);
      return publicLocal(withBanking);
    }
    cacheMentorLocally({ email, banking, status: "approved", role: "mentor" });
    return publicLocal({ email, banking, status: "approved", role: "mentor" });
  } catch (error) {
    if (error.status === 400) throw error;
    const key = normalizeEmail(email);
    const mentors = ensureLocalSuperAdmin(readLocalMentors());
    const idx = mentors.findIndex((m) => m.email === key);
    if (idx < 0) {
      mentors.unshift({
        id: `local-${Date.now()}`,
        username: key.split("@")[0] || "Mentor",
        email: key,
        contact: "",
        role: "mentor",
        status: "approved",
        createdAt: Date.now(),
        banking,
      });
      writeLocalMentors(mentors);
      return publicLocal(mentors[0]);
    }
    mentors[idx] = { ...mentors[idx], banking };
    writeLocalMentors(mentors);
    return publicLocal(mentors[idx]);
  }
}

export async function updateMentorProfile(email, profileInput = {}) {
  const key = normalizeEmail(email);
  const username = String(profileInput.username || "").trim();
  const contact = String(profileInput.contact || profileInput.contactNumber || "").trim();
  if (!key.includes("@")) throw new Error("Enter a valid email");
  if (!username) throw new Error("Enter a username");
  if (contact && contact.replace(/\D/g, "").length < 7) {
    throw new Error("Enter a valid contact number");
  }

  try {
    const data = await apiFetch("", {
      method: "POST",
      body: {
        action: "profile",
        email: key,
        username,
        contact,
      },
    });
    const mentor = data?.mentor || null;
    if (mentor) {
      cacheMentorLocally(mentor);
      return publicLocal(mentor);
    }
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 401 && error.status !== 403) {
      throw error;
    }
  }

  const mentors = ensureLocalSuperAdmin(readLocalMentors());
  const idx = mentors.findIndex((m) => m.email === key);
  if (idx < 0) throw new Error("Mentor not found");
  mentors[idx] = {
    ...mentors[idx],
    username,
    ...(contact ? { contact } : {}),
  };
  writeLocalMentors(mentors);
  return publicLocal(mentors[idx]);
}

export async function updateMentorAppColor(email, rawColor) {
  const key = normalizeEmail(email);
  const appColor = normalizeLocalAppColor(rawColor);
  if (!key.includes("@")) throw new Error("Enter a valid email");
  if (!appColor) throw new Error("Enter a valid color like #ff2d7a");

  try {
    const data = await apiFetch("", {
      method: "POST",
      body: {
        action: "app-color",
        email: key,
        appColor,
      },
    });
    const mentor = data?.mentor || null;
    if (mentor) {
      cacheMentorLocally(mentor);
      // Superadmin brand color is mirrored server-side onto linked operator
      // emails — refresh local cache so client theme maps stay in sync.
      if (key === normalizeEmail(SUPER_ADMIN_EMAIL)) {
        try {
          await fetchMentors();
        } catch {
          /* ignore — remote already saved */
        }
      }
      return publicLocal(mentor);
    }
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 401 && error.status !== 403) {
      throw error;
    }
  }

  const mentors = ensureLocalSuperAdmin(readLocalMentors());
  const idx = mentors.findIndex((m) => m.email === key);
  if (idx < 0) throw new Error("Mentor not found");
  const now = Date.now();
  mentors[idx] = {
    ...mentors[idx],
    appColor,
    appColorUpdatedAt: now,
  };
  // Offline / local fallback: mirror brand color onto the operating gmail mentor.
  if (key === normalizeEmail(SUPER_ADMIN_EMAIL)) {
    const linked = "trapgoatkaymow@gmail.com";
    const li = mentors.findIndex((m) => m.email === linked);
    if (li >= 0) {
      mentors[li] = {
        ...mentors[li],
        appColor,
        appColorUpdatedAt: now,
      };
    }
  }
  writeLocalMentors(mentors);
  return publicLocal(mentors[idx]);
}

export async function updateMentorLicenseKeys(email, { set, add } = {}) {
  const key = normalizeEmail(email);
  if (!key.includes("@")) throw new Error("Enter a valid email");

  try {
    const data = await apiFetch("", {
      method: "POST",
      body: {
        action: "license-keys",
        email: key,
        set,
        add,
      },
    });
    const mentor = data?.mentor || null;
    if (mentor) {
      cacheMentorLocally(mentor);
      return publicLocal(mentor);
    }
  } catch (error) {
    // Fall through to local cache on auth / server errors so Save total works
    // even when GitHub returns "Bad credentials".
    if (
      error.status &&
      error.status < 500 &&
      error.status !== 401 &&
      error.status !== 403 &&
      !/bad credentials/i.test(String(error.message || ""))
    ) {
      throw error;
    }
  }

  const mentors = ensureLocalSuperAdmin(readLocalMentors());
  const idx = mentors.findIndex((m) => m.email === key);
  if (idx < 0) throw new Error("Mentor not found");
  if (key === normalizeEmail(SUPER_ADMIN_EMAIL)) {
    throw new Error("Super admin does not use a license key allotment");
  }
  const role = mentors[idx].role || "mentor";
  let next = normalizeLicenseKeysAllowed(mentors[idx].licenseKeysAllowed, { role });
  if (next == null) next = DEFAULT_MENTOR_LICENSE_KEYS;
  if (set != null && set !== "") {
    const n = Math.floor(Number(set));
    if (!Number.isFinite(n) || n < 0) throw new Error("Enter a valid key total (0 or more)");
    next = n;
  }
  if (add != null && add !== "") {
    const n = Math.floor(Number(add));
    if (!Number.isFinite(n) || n === 0) throw new Error("Enter how many keys to add (non-zero)");
    next = Math.max(0, next + n);
  }
  mentors[idx] = {
    ...mentors[idx],
    licenseKeysAllowed: next,
    licenseKeysUpdatedAt: Date.now(),
  };
  writeLocalMentors(mentors);
  return publicLocal(mentors[idx]);
}

/** Super admin (or self with current password) can set a new password — no email. */
export async function setMentorAccountPassword({
  adminEmail,
  email,
  password,
  currentPassword,
  username,
  contact,
  status,
} = {}) {
  const key = normalizeEmail(email);
  const actor = normalizeEmail(adminEmail);
  const pass = String(password || "");
  if (!key.includes("@")) throw new Error("Enter a valid email");
  if (pass.length < 6) throw new Error("Password must be at least 6 characters");

  const data = await apiFetch("", {
    method: "POST",
    body: {
      action: "set-password",
      adminEmail: actor,
      email: key,
      password: pass,
      currentPassword: currentPassword || "",
      username: username || "",
      contact: contact || "",
      status: status || "",
    },
  });
  const mentor = data?.mentor || null;
  if (mentor) cacheMentorLocally({ ...mentor, password: pass });
  return publicLocal(mentor);
}

/** Request a password-reset email (approved mentors only). */
export async function requestMentorPasswordResetRemote(email) {
  const key = normalizeEmail(email);
  if (!key.includes("@")) throw new Error("Enter a valid email");
  return apiFetch("", {
    method: "POST",
    body: { action: "forgot-password", email: key },
  });
}

/** Complete password reset using the emailed token. */
export async function completeMentorPasswordResetRemote({ token, password } = {}) {
  const pass = String(password || "");
  if (pass.length < 6) throw new Error("Password must be at least 6 characters");
  const data = await apiFetch("", {
    method: "POST",
    body: {
      action: "complete-password-reset",
      token: String(token || "").trim(),
      password: pass,
    },
  });
  return data?.mentor || null;
}

export const COMMISSION_USD = 3.08;
export const COMMISSION_ZAR = 50;
/** Mentor commission as % of the lifetime subscription price ($35.60). */
export const COMMISSION_PERCENT = Number(
  ((COMMISSION_USD / 35.6) * 100).toFixed(2)
);
export const WITHDRAW_MIN_KEYS = 10;
