/**
 * Lightweight ops health — no secrets returned.
 * GET /api/health
 */
import { endOptions } from "./_cors.js";
import { brevoConfigured } from "./_brevo.js";
import { hasDurableBackend } from "./_durableJson.js";

export const config = { maxDuration: 15 };

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  let firebase = false;
  let firebaseProbe = null;
  try {
    const fb = await import("./_firebaseRtdb.js");
    firebase = Boolean(fb.firebaseConfigured?.());
    if (firebase) {
      const probePath = "apexea/_healthProbe";
      const stamp = `health-${Date.now()}`;
      const put = await fb.firebasePut(probePath, JSON.stringify({ stamp, at: Date.now() }));
      if (!put?.ok) {
        firebaseProbe = { ok: false, step: "put", reason: put?.reason || "put failed" };
      } else {
        const got = await fb.firebaseGet(probePath);
        const raw = String(got?.raw || "");
        firebaseProbe = {
          ok: raw.includes(stamp),
          step: "roundtrip",
          reason: raw.includes(stamp) ? null : "read mismatch",
        };
      }
    }
  } catch (error) {
    firebase = false;
    firebaseProbe = { ok: false, step: "exception", reason: error?.message || "firebase error" };
  }

  const blob = Boolean(String(process.env.BLOB_READ_WRITE_TOKEN || "").trim());
  const github = Boolean(
    String(
      process.env.SIGNUPS_GITHUB_TOKEN ||
        process.env.GITHUB_DEPLOY_TOKEN ||
        process.env.GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        ""
    ).trim()
  );

  // Probe GitHub Contents rate remaining (best-effort, never throws).
  let githubRate = null;
  if (github) {
    try {
      const token =
        process.env.SIGNUPS_GITHUB_TOKEN ||
        process.env.GITHUB_DEPLOY_TOKEN ||
        process.env.GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        "";
      const rateRes = await fetch("https://api.github.com/rate_limit", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "apex-ea-health",
        },
        cache: "no-store",
      });
      if (rateRes.ok) {
        const data = await rateRes.json();
        const core = data?.resources?.core || {};
        githubRate = {
          remaining: Number(core.remaining),
          limit: Number(core.limit),
          reset: Number(core.reset) || null,
        };
      } else {
        githubRate = { remaining: null, status: rateRes.status };
      }
    } catch (error) {
      githubRate = { remaining: null, error: error?.message || "rate check failed" };
    }
  }

  const firebaseHealthy = Boolean(firebase && firebaseProbe?.ok !== false);
  const healthy =
    hasDurableBackend() &&
    firebaseHealthy &&
    (githubRate?.remaining == null || githubRate.remaining > 50);

  sendJson(res, 200, {
    ok: healthy,
    time: new Date().toISOString(),
    brevo: brevoConfigured(),
    durable: {
      any: hasDurableBackend(),
      firebase,
      firebaseProbe,
      blob,
      github,
    },
    githubRate,
    notes: [
      !firebase
        ? "Firebase missing — app falls back to GitHub and can lose memory when rate-limited"
        : null,
      firebase && firebaseProbe && !firebaseProbe.ok
        ? `Firebase configured but write/read probe failed: ${firebaseProbe.reason || "unknown"}`
        : null,
      !blob
        ? "Vercel Blob not configured (BLOB_READ_WRITE_TOKEN) — add a Blob store for backup memory"
        : null,
      githubRate?.remaining != null && githubRate.remaining < 200
        ? "GitHub API quota low — pause high-churn writes"
        : null,
    ].filter(Boolean),
  });
}
