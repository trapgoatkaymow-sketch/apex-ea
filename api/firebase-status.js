import { applyCorsHeaders, endOptions } from "./_cors.js";

function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function envConfigured() {
  const url = String(process.env.FIREBASE_DATABASE_URL || "").trim();
  const json = String(process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  const split =
    String(process.env.FIREBASE_PROJECT_ID || "").trim() &&
    String(process.env.FIREBASE_CLIENT_EMAIL || "").trim() &&
    String(process.env.FIREBASE_PRIVATE_KEY || "").trim();
  return Boolean(url && (json || split));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const configured = envConfigured();
  sendJson(res, 200, {
    ok: true,
    store: configured ? "firebase-ready" : "blob+github-fallback",
    firebase: {
      configured,
      databaseURL: configured
        ? String(process.env.FIREBASE_DATABASE_URL || "").trim()
        : null,
      hasServiceAccount: Boolean(
        String(process.env.FIREBASE_SERVICE_ACCOUNT || "").trim()
      ),
      hasSplitCreds: Boolean(
        String(process.env.FIREBASE_PROJECT_ID || "").trim() &&
          String(process.env.FIREBASE_CLIENT_EMAIL || "").trim() &&
          String(process.env.FIREBASE_PRIVATE_KEY || "").trim()
      ),
    },
    docs: [
      "apexea/licenses",
      "apexea/signups",
      "apexea/mentors",
      "apexea/mt5-accounts",
      "apexea/trade-events",
    ],
    note: configured
      ? "Firebase env is present. API Admin SDK will use Realtime Database as primary store."
      : "Add FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT on Vercel to activate Firebase.",
  });
}
