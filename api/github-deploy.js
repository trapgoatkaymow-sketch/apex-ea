import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { waitUntil } from "@vercel/functions";
import { applyCorsHeaders, endOptions } from "./_cors.js";

const gunzip = promisify(zlib.gunzip);

export const config = {
  api: { bodyParser: false },
  maxDuration: 300,
};

const REPO = "trapgoatkaymow-sketch/apex-ea";
const PROJECT_NAME = "gizmo";
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".vercel",
  "android",
  "dist",
  "build",
  ".cursor",
  "__pycache__",
]);

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

async function fetchGithubTarball(token, sha) {
  const url = `https://api.github.com/repos/${REPO}/tarball/${encodeURIComponent(sha)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "apex-ea-deploy-hook",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub tarball ${res.status}: ${text.slice(0, 200)}`);
  }
  const gz = Buffer.from(await res.arrayBuffer());
  // GitHub returns gzip-compressed tar
  if (gz.length >= 2 && gz[0] === 0x1f && gz[1] === 0x8b) {
    return gunzip(gz);
  }
  return gz;
}

function readTarString(buf, start, len) {
  return buf.subarray(start, start + len).toString("utf8").replace(/\0.*$/, "").trim();
}

/** Minimal ustar tar parser for GitHub tarballs. */
function parseTar(buffer) {
  const files = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const sizeOctal = readTarString(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 0);
    const size = parseInt(sizeOctal || "0", 8) || 0;
    offset += 512;
    const content = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (!name || typeFlag === "5") continue;
    if (typeFlag && typeFlag !== "0" && typeFlag !== "\0") continue;
    const full = prefix ? `${prefix}/${name}` : name;
    files.push({ name: full, content: Buffer.from(content) });
  }
  return files;
}

function shouldInclude(relPath) {
  const parts = relPath.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  if (relPath.startsWith(".env") && relPath !== ".env.example") return false;
  const lower = relPath.toLowerCase();
  if (
    lower.endsWith(".apk") ||
    lower.endsWith(".mp4") ||
    lower.endsWith(".bundle")
  ) {
    return false;
  }
  return true;
}

async function uploadFile(token, teamId, sha1, bytes) {
  const res = await fetch(
    `https://api.vercel.com/v2/files?teamId=${encodeURIComponent(teamId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "x-vercel-digest": sha1,
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    }
  );
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function createFileDeployment({ token, teamId, fileEntries, sha }) {
  const res = await fetch(
    `https://api.vercel.com/v13/deployments?teamId=${encodeURIComponent(teamId)}&forceNew=1`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: PROJECT_NAME,
        project: PROJECT_NAME,
        target: "production",
        files: fileEntries,
        meta: {
          githubCommitSha: sha,
          githubCommitRef: "main",
          githubOrg: "trapgoatkaymow-sketch",
          githubRepo: "apex-ea",
          deploySource: "github-deploy-webhook",
        },
      }),
    }
  );
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function deploySha({ vercelToken, teamId, githubToken, sha }) {
  const tarball = await fetchGithubTarball(githubToken, sha);
  const tarFiles = parseTar(tarball);
  const uploads = [];

  for (const f of tarFiles) {
    // GitHub tarball paths: <repo>-<sha>/<path>
    const parts = f.name.split("/");
    if (parts.length < 2) continue;
    const rel = parts.slice(1).join("/");
    if (!rel || !shouldInclude(rel)) continue;
    if (f.content.length > 8_000_000) continue;
    const sha1 = crypto.createHash("sha1").update(f.content).digest("hex");
    uploads.push({
      file: rel,
      sha: sha1,
      size: f.content.length,
      content: f.content,
    });
  }

  if (!uploads.length) {
    throw new Error("No uploadable files found in GitHub tarball");
  }

  const batchSize = 12;
  for (let i = 0; i < uploads.length; i += batchSize) {
    const batch = uploads.slice(i, i + batchSize);
    await Promise.all(
      batch.map((u) => uploadFile(vercelToken, teamId, u.sha, u.content))
    );
  }

  const fileEntries = uploads.map(({ file, sha, size }) => ({ file, sha, size }));
  return createFileDeployment({
    token: vercelToken,
    teamId,
    fileEntries,
    sha,
  });
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
      mode: "github-tarball-upload",
      configured: Boolean(
        process.env.GITHUB_WEBHOOK_SECRET &&
          process.env.VERCEL_DEPLOY_TOKEN &&
          process.env.VERCEL_DEPLOY_TEAM_ID &&
          process.env.GITHUB_DEPLOY_TOKEN
      ),
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const secret = String(process.env.GITHUB_WEBHOOK_SECRET || "").trim();
  const vercelToken = String(process.env.VERCEL_DEPLOY_TOKEN || "").trim();
  const teamId = String(process.env.VERCEL_DEPLOY_TEAM_ID || "").trim();
  const githubToken = String(process.env.GITHUB_DEPLOY_TOKEN || "").trim();

  if (!secret || !vercelToken || !teamId || !githubToken) {
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

  const sha = String(payload.after || payload.head_commit?.id || "").trim();
  if (!sha || /^0+$/.test(sha)) {
    sendJson(res, 200, { ok: true, ignored: "deleted-branch" });
    return;
  }

  try {
    // GitHub webhooks time out around 10s; keep the HTTP response fast and
    // finish the file upload deploy in the background.
    waitUntil(
      deploySha({
        vercelToken,
        teamId,
        githubToken,
        sha,
      }).then((result) => {
        if (!result.ok) {
          console.error("github-deploy failed", result.status, result.json);
        } else {
          console.log("github-deploy ok", result.json?.id, result.json?.url);
        }
      }).catch((err) => {
        console.error(
          "github-deploy error",
          err instanceof Error ? err.message : String(err)
        );
      })
    );

    sendJson(res, 202, {
      ok: true,
      accepted: true,
      sha,
      mode: "github-tarball-upload",
    });
  } catch (err) {
    sendJson(res, 500, {
      error: "Deploy failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
