import { applyCorsHeaders, endOptions } from "../_cors.js";

function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
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

  try {
    const { firebaseStatus } = await import("../_firebaseRtdb.js");
    const status = firebaseStatus();
    sendJson(res, 200, {
      ok: true,
      store: status.configured ? "firebase" : "blob+github-fallback",
      firebase: status,
      docs: [
        "apexea/licenses",
        "apexea/signups",
        "apexea/mentors",
        "apexea/mt5-accounts",
        "apexea/trade-events",
      ],
      note: status.configured
        ? "Realtime Database is primary. Client rules stay locked; Admin SDK writes from the API."
        : "Add FIREBASE_DATABASE_URL + FIREBASE_SERVICE_ACCOUNT on Vercel to activate Firebase.",
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      store: "blob+github-fallback",
      error: error?.message || "Firebase module failed to load",
      note: "App still runs on Blob/GitHub until Firebase credentials are added.",
    });
  }
}

export const config = { maxDuration: 10 };
