import crypto from "node:crypto";
import { applyCorsHeaders, endOptions } from "./_cors.js";

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

const REPO_ID = 1374093656;
const PROJECT_NAME = "gizmo";

function sendJson(res, status, body) {
  applyCorsHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function createProductionDeploy({ token, teamId, sha, ref }) {
  const body = {
    name: PROJECT_NAME,
    project: PROJECT_NAME,
    gitSource: {
      type: "github",
      repoId: REPO_ID,
      ref: ref || "main",
      ...(sha ? { sha } : {}),
    },
    target: "production",
  };

  const res = await fetch(
    `https://api.vercel.com/v13/deployments?teamId=${encodeURIComponent(teamId)}&forceNew=1`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  if (req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      service: "github-deploy",
      configured: Boolean(
        process.env.GITHUB_WEBHOOK_SECRET &&
          process.env.VERCEL_DEPLOY_TOKEN &&
          process.env.VERCEL_DEPLOY_TEAM_ID
      ),
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const secret = String(process.env.GITHUB_WEBHOOK_SECRET || "").trim();
  const token = String(process.env.VERCEL_DEPLOY_TOKEN || "").trim();
  const teamId = String(process.env.VERCEL_DEPLOY_TEAM_ID || "").trim();

  if (!secret || !token || !teamId) {
    sendJson(res, 503, { error: "Deploy webhook not configured" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"];
  if (!verifySignature(rawBody, signature, secret)) {
    sendJson(res, 401, { error: "Invalid signature" });
    return;
  }

  const event = String(req.headers["x-github-event"] || "");
  if (event === "ping") {
    sendJson(res, 200, { ok: true, pong: true });
    return;
  }

  if (event !== "push") {
    sendJson(res, 200, { ok: true, ignored: event || "unknown" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const ref = String(payload.ref || "");
  if (ref !== "refs/heads/main") {
    sendJson(res, 200, { ok: true, ignored: ref });
    return;
  }

  const sha = payload.after || payload.head_commit?.id || "";
  const result = await createProductionDeploy({
    token,
    teamId,
    sha,
    ref: "main",
  });

  if (!result.ok) {
    sendJson(res, 502, {
      error: "Vercel deploy failed",
      status: result.status,
      detail: result.json?.error || result.json,
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    deploymentId: result.json.id,
    url: result.json.url,
    inspectorUrl: result.json.inspectorUrl,
    readyState: result.json.readyState,
  });
}
