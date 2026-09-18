/**
 * Firebase Realtime Database adapter (Admin SDK).
 *
 * Client rules can stay locked (.read/.write false) — Admin SDK bypasses them.
 *
 * Required env (one of):
 *  - FIREBASE_SERVICE_ACCOUNT  → full service-account JSON string
 *  - or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 * Plus:
 *  - FIREBASE_DATABASE_URL     → https://<project>-default-rtdb.<region>.firebasedatabase.app
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

let initAttempted = false;
let initError = "";
let appRef = null;

function parseServiceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.private_key && typeof parsed.private_key === "string") {
        parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
      }
      return parsed;
    } catch (error) {
      initError = `FIREBASE_SERVICE_ACCOUNT JSON invalid: ${error.message}`;
      return null;
    }
  }

  const projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  let privateKey = String(process.env.FIREBASE_PRIVATE_KEY || "").trim();
  if (projectId && clientEmail && privateKey) {
    privateKey = privateKey.replace(/\\n/g, "\n");
    return {
      type: "service_account",
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    };
  }
  return null;
}

function databaseURL() {
  return String(process.env.FIREBASE_DATABASE_URL || "").trim();
}

export function firebaseConfigured() {
  return Boolean(parseServiceAccount() && databaseURL());
}

export function firebaseStatus() {
  return {
    configured: firebaseConfigured(),
    databaseURL: databaseURL() || null,
    initError: initError || null,
    apps: getApps().length,
  };
}

function ensureApp() {
  if (appRef) return appRef;
  if (getApps().length) {
    appRef = getApps()[0];
    return appRef;
  }
  if (initAttempted && initError) return null;
  initAttempted = true;
  const account = parseServiceAccount();
  const url = databaseURL();
  if (!account || !url) {
    initError =
      initError ||
      "Firebase not configured. Set FIREBASE_DATABASE_URL and FIREBASE_SERVICE_ACCOUNT (or PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY).";
    return null;
  }
  try {
    appRef = initializeApp({
      credential: cert(account),
      databaseURL: url,
    });
    return appRef;
  } catch (error) {
    initError = error?.message || "Firebase init failed";
    return null;
  }
}

/** Map blob/file paths like apexea/licenses.json → apexea/licenses */
export function toFirebasePath(blobOrFilePath) {
  const raw = String(blobOrFilePath || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\.json$/i, "");
  if (!raw) return "";
  // RTDB paths cannot contain '.', '#', '$', '[', ']'
  return raw.replace(/[.#$\[\]]/g, "_");
}

/**
 * Read a JSON document from RTDB.
 * @returns {Promise<{ missing?: boolean, raw: string|null, etag?: string|null }|null>}
 */
export async function firebaseGet(docPath) {
  const app = ensureApp();
  if (!app) return null;
  const path = toFirebasePath(docPath);
  if (!path) return null;
  try {
    const snap = await getDatabase(app).ref(path).get();
    if (!snap.exists()) return { missing: true, raw: null };
    const val = snap.val();
    if (typeof val === "string") {
      return { missing: false, raw: val, etag: snap.key || null };
    }
    if (val && typeof val === "object" && typeof val.__raw === "string") {
      return { missing: false, raw: val.__raw, etag: snap.key || null };
    }
    return {
      missing: false,
      raw: JSON.stringify(val ?? null),
      etag: snap.key || null,
    };
  } catch (error) {
    console.warn("firebaseGet failed", path, error?.message || error);
    return null;
  }
}

/**
 * Write a JSON document string to RTDB.
 * @returns {Promise<{ ok: boolean, durable?: string, reason?: string }>}
 */
export async function firebasePut(docPath, raw) {
  const app = ensureApp();
  if (!app) return { ok: false, reason: initError || "firebase-not-configured" };
  const path = toFirebasePath(docPath);
  if (!path) return { ok: false, reason: "empty-path" };
  try {
    let payload;
    try {
      payload = JSON.parse(String(raw ?? ""));
    } catch {
      payload = { __raw: String(raw ?? "") };
    }
    await getDatabase(app).ref(path).set(payload);
    return { ok: true, durable: "firebase" };
  } catch (error) {
    return { ok: false, reason: error?.message || "firebase put failed" };
  }
}
