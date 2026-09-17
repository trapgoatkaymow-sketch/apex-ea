/**
 * Shared durable JSON document store for serverless.
 *
 * Priority for reads:
 *  1) Vercel Blob (BLOB_READ_WRITE_TOKEN) — shared across all instances
 *  2) GitHub Contents API (SIGNUPS_GITHUB_TOKEN / FALLBACK)
 *  3) Env snapshot (e.g. LICENSES_SNAPSHOT_B64) — read-only seed
 *  4) /tmp + in-memory — per-instance only
 *
 * Writes always update /tmp + memory; Blob/GitHub when credentials work.
 */

import fs from "fs";
import path from "path";
import { FALLBACK_GITHUB_TOKEN } from "./signups/_githubToken.js";

const BLOB_API = "https://blob.vercel-storage.com";

function githubToken() {
  return (
    process.env.SIGNUPS_GITHUB_TOKEN ||
    process.env.GITHUB_DEPLOY_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    FALLBACK_GITHUB_TOKEN ||
    ""
  );
}

function blobToken() {
  return String(process.env.BLOB_READ_WRITE_TOKEN || "").trim();
}

async function blobGet(pathname) {
  const token = blobToken();
  if (!token) return null;
  const url = `${BLOB_API}/${String(pathname).replace(/^\//, "")}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-version": "7",
      },
      cache: "no-store",
    });
    if (res.status === 404) return { missing: true, raw: null };
    if (!res.ok) return null;
    const raw = await res.text();
    return { missing: false, raw, etag: res.headers.get("etag") || null };
  } catch {
    return null;
  }
}

async function blobPut(pathname, raw) {
  const token = blobToken();
  if (!token) return { ok: false, reason: "no-blob-token" };
  const url = `${BLOB_API}/${String(pathname).replace(/^\//, "")}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-version": "7",
        "Content-Type": "application/json; charset=utf-8",
        "x-vercel-blob-access": "private",
        "x-vercel-blob-add-random-suffix": "false",
        "x-vercel-blob-allow-overwrite": "true",
      },
      body: String(raw ?? ""),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: text || `blob ${res.status}` };
    }
    return { ok: true, durable: "blob" };
  } catch (error) {
    return { ok: false, reason: error?.message || "blob put failed" };
  }
}

async function githubGet({ repo, branch, filePath }) {
  const token = githubToken();
  if (!token) return null;
  const api = `https://api.github.com/repos/${repo}`;
  try {
    const res = await fetch(
      `${api}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      }
    );
    if (res.status === 404) return { missing: true, raw: null, sha: null };
    if (!res.ok) return null;
    const file = await res.json();
    const raw = Buffer.from(
      String(file.content || "").replace(/\n/g, ""),
      "base64"
    ).toString("utf8");
    return { missing: false, raw, sha: file.sha || null };
  } catch {
    return null;
  }
}

async function githubPut({ repo, branch, filePath, raw, sha, message }) {
  const token = githubToken();
  if (!token) return { ok: false, reason: "no-github-token" };
  const api = `https://api.github.com/repos/${repo}`;
  const body = {
    message: message || `chore: update ${filePath}`,
    content: Buffer.from(String(raw ?? ""), "utf8").toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;
  try {
    const res = await fetch(`${api}/contents/${filePath}`, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        ok: false,
        reason: data?.message || `github ${res.status}`,
        status: res.status,
      };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, durable: "github", sha: data?.content?.sha || null };
  } catch (error) {
    return { ok: false, reason: error?.message || "github put failed" };
  }
}

function readEnvSnapshot(envKey) {
  const b64 = String(process.env[envKey] || "").trim();
  if (!b64) return null;
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function readLocalFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function writeLocalFile(filePath, raw) {
  if (!filePath) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(raw ?? ""), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.blobPath - Vercel Blob pathname (e.g. apexea/mt5-accounts.json)
 * @param {string} [opts.githubRepo]
 * @param {string} [opts.githubBranch]
 * @param {string} [opts.githubPath]
 * @param {string} [opts.snapshotEnv] - env var with base64 JSON seed
 * @param {string[]} [opts.localPaths] - /tmp and bundled fallbacks
 * @returns {Promise<{ raw: string|null, sha: string|null, source: string }>}
 */
export async function durableRead(opts = {}) {
  const {
    blobPath,
    githubRepo =
      process.env.SIGNUPS_GITHUB_REPO || "trapgoatkaymow-sketch/apex-ea",
    githubBranch = process.env.SIGNUPS_GITHUB_BRANCH || "main",
    githubPath,
    snapshotEnv,
    localPaths = [],
  } = opts;

  const blob = blobPath ? await blobGet(blobPath) : null;
  if (blob && !blob.missing && blob.raw != null) {
    return { raw: blob.raw, sha: blob.etag, source: "blob" };
  }

  if (githubPath) {
    const gh = await githubGet({
      repo: githubRepo,
      branch: githubBranch,
      filePath: githubPath,
    });
    if (gh && !gh.missing && gh.raw != null) {
      return { raw: gh.raw, sha: gh.sha, source: "github" };
    }
  }

  if (snapshotEnv) {
    const snap = readEnvSnapshot(snapshotEnv);
    if (snap != null) return { raw: snap, sha: null, source: "snapshot" };
  }

  for (const file of localPaths) {
    const local = readLocalFile(file);
    if (local != null) return { raw: local, sha: "local", source: "local" };
  }

  return { raw: null, sha: null, source: "empty" };
}

/**
 * @returns {Promise<{ ok: boolean, durable: boolean, source?: string, reason?: string, sha?: string|null }>}
 */
export async function durableWrite(opts = {}) {
  const {
    raw,
    blobPath,
    githubRepo =
      process.env.SIGNUPS_GITHUB_REPO || "trapgoatkaymow-sketch/apex-ea",
    githubBranch = process.env.SIGNUPS_GITHUB_BRANCH || "main",
    githubPath,
    githubSha,
    message,
    localPaths = [],
  } = opts;

  const body = String(raw ?? "");
  for (const file of localPaths) writeLocalFile(file, body);

  if (blobPath) {
    const put = await blobPut(blobPath, body);
    if (put.ok) return { ok: true, durable: true, source: "blob" };
  }

  if (githubPath) {
    const put = await githubPut({
      repo: githubRepo,
      branch: githubBranch,
      filePath: githubPath,
      raw: body,
      sha: githubSha,
      message,
    });
    if (put.ok) {
      return { ok: true, durable: true, source: "github", sha: put.sha };
    }
    if (put.status === 409 || put.status === 422) {
      return { ok: false, durable: false, reason: put.reason, conflict: true };
    }
  }

  return {
    ok: true,
    durable: false,
    source: "local",
    reason: "no durable backend (set BLOB_READ_WRITE_TOKEN or SIGNUPS_GITHUB_TOKEN)",
  };
}

export function hasDurableBackend() {
  return Boolean(blobToken() || githubToken());
}
