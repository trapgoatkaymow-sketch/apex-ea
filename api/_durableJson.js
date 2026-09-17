/**
 * Shared durable JSON document store for serverless.
 *
 * Priority for reads:
 *  1) Vercel Blob (BLOB_READ_WRITE_TOKEN) — shared across all instances
 *  2) GitHub Contents API (SIGNUPS_GITHUB_TOKEN / FALLBACK)
 *  3) GitHub raw CDN (when Contents API is rate-limited)
 *  4) Env snapshot (e.g. LICENSES_SNAPSHOT_B64) — read-only seed
 *  5) /tmp + in-memory — per-instance only
 *
 * Writes: Blob → GitHub Contents API → isomorphic-git push (bypasses REST rate limits).
 */

import fs from "fs";
import path from "path";
import os from "os";
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

/** Raw CDN / media read — works when Contents API is rate-limited. */
async function githubGetRaw({ repo, branch, filePath }) {
  const token = githubToken();
  const cleaned = String(filePath || "").replace(/^\//, "");
  const bust = Date.now();
  const urls = [
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(
      branch
    )}/${cleaned}?ts=${bust}`,
    `https://cdn.jsdelivr.net/gh/${repo}@${encodeURIComponent(
      branch
    )}/${cleaned}?ts=${bust}`,
  ];
  for (const url of urls) {
    try {
      const headers = {
        Accept: "application/json,text/plain,*/*",
        "Cache-Control": "no-cache",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(url, { headers, cache: "no-store" });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      const raw = await res.text();
      if (raw != null && String(raw).trim()) {
        return { missing: false, raw, sha: null };
      }
    } catch {
      // try next
    }
  }
  return null;
}

/** Shallow clone read — correct but slower; used when CDN is stale. */
async function githubGetViaGit({ repo, branch, filePath }) {
  const token = githubToken();
  if (!token) return null;
  const relPath = String(filePath || "").replace(/^\//, "");
  if (!relPath) return null;
  let dir = null;
  try {
    const git = (await import("isomorphic-git")).default;
    const http = (await import("isomorphic-git/http/node")).default;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "apexea-git-r-"));
    const url = `https://github.com/${repo}.git`;
    const onAuth = () => ({ username: token, password: "x-oauth-basic" });
    await git.clone({
      fs,
      http,
      dir,
      url,
      ref: branch || "main",
      singleBranch: true,
      depth: 1,
      onAuth,
    });
    const abs = path.join(dir, relPath);
    if (!fs.existsSync(abs)) return { missing: true, raw: null, sha: null };
    const raw = fs.readFileSync(abs, "utf8");
    return { missing: false, raw, sha: null };
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
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

/**
 * Merge two licenses.json documents by key so concurrent git pushes do not
 * wipe each other's newly claimed keys. Prefer the newer row stamp; keep
 * used/deviceId/robot fields when either side has them.
 * Empty intended + reset message → overwrite (clear-all).
 */
function mergeLicensesDocuments(remoteRaw, intendedRaw, message = "") {
  const isReset = /reset all license|clear all license/i.test(String(message || ""));
  let remote;
  let intended;
  try {
    remote = JSON.parse(String(remoteRaw || "{}"));
    intended = JSON.parse(String(intendedRaw || "{}"));
  } catch {
    return String(intendedRaw ?? "");
  }
  const intendedList = Array.isArray(intended?.licenses) ? intended.licenses : null;
  const remoteList = Array.isArray(remote?.licenses) ? remote.licenses : null;
  if (!intendedList) return String(intendedRaw ?? "");
  if (isReset && intendedList.length === 0) {
    return (
      JSON.stringify(
        {
          licenses: [],
          deletedKeys: intended?.deletedKeys || {},
        },
        null,
        2
      ) + "\n"
    );
  }
  if (!remoteList) return String(intendedRaw ?? "");

  const map = new Map();
  const stamp = (row) =>
    Number(row?.updatedAt || row?.usedAt || row?.createdAt || 0) || 0;
  const ingest = (row) => {
    const key = String(row?.key || "")
      .trim()
      .toUpperCase();
    if (!key) return;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...row, key: String(row.key || key) });
      return;
    }
    const preferIncoming = stamp(row) >= stamp(prev);
    const newer = preferIncoming ? row : prev;
    const older = preferIncoming ? prev : row;
    map.set(key, {
      ...older,
      ...newer,
      key: String(newer.key || older.key || key),
      used: Boolean(newer.used || older.used),
      deviceId: newer.deviceId || older.deviceId || null,
      boundAt: newer.boundAt || older.boundAt || null,
      usedAt: newer.usedAt || older.usedAt || null,
      robotAccountId: newer.robotAccountId || older.robotAccountId || "",
      robotLogin: newer.robotLogin || older.robotLogin || "",
      robotServer: newer.robotServer || older.robotServer || "",
      robotCompany: newer.robotCompany || older.robotCompany || "",
      robotPlatform: newer.robotPlatform || older.robotPlatform || "",
      robotConnectedAt: newer.robotConnectedAt || older.robotConnectedAt || null,
      updatedAt: Math.max(stamp(newer), stamp(older)),
      bot: newer.bot || older.bot || null,
    });
  };
  for (const row of remoteList) ingest(row);
  for (const row of intendedList) ingest(row);

  const deletedKeys = {
    ...(remote?.deletedKeys && typeof remote.deletedKeys === "object"
      ? remote.deletedKeys
      : {}),
    ...(intended?.deletedKeys && typeof intended.deletedKeys === "object"
      ? intended.deletedKeys
      : {}),
  };
  // Tombstones remove keys from the merged list.
  const deletedSet = new Set(
    Object.keys(deletedKeys).map((k) => String(k).trim().toUpperCase())
  );
  const licenses = Array.from(map.values())
    .filter((row) => {
      const key = String(row?.key || "")
        .trim()
        .toUpperCase();
      return key && !deletedSet.has(key) && !deletedSet.has(key.replace(/-/g, ""));
    })
    .sort((a, b) => stamp(b) - stamp(a));

  return JSON.stringify({ licenses, deletedKeys }, null, 2) + "\n";
}

/**
 * Write via Git Smart HTTP (isomorphic-git). Bypasses Contents API rate limits
 * that otherwise block license generation on Vercel.
 *
 * On non-fast-forward / ref lock races, re-clone and merge licenses.json so a
 * concurrent claim cannot wipe another client's just-saved key.
 */
async function githubPutViaGit({ repo, branch, filePath, raw, message }) {
  const token = githubToken();
  if (!token) return { ok: false, reason: "no-github-token" };
  const relPath = String(filePath || "").replace(/^\//, "");
  if (!relPath) return { ok: false, reason: "missing github path" };

  const git = (await import("isomorphic-git")).default;
  const http = (await import("isomorphic-git/http/node")).default;
  const url = `https://github.com/${repo}.git`;
  const onAuth = () => ({ username: token, password: "x-oauth-basic" });
  const intendedBody = String(raw ?? "");
  const commitMessage = message || `chore: update ${relPath}`;
  let lastReason = "git push failed";
  let lastStatus = 500;
  const isLicensesFile = /licenses\.json$/i.test(relPath);

  // store-licenses receives concurrent invite claims — merge + retry on NFF.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let dir = null;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "apexea-git-"));
      await git.clone({
        fs,
        http,
        dir,
        url,
        ref: branch || "main",
        singleBranch: true,
        depth: 1,
        onAuth,
      });

      const abs = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      let body = intendedBody;
      // After a conflict (or always when file exists), merge so we never push a
      // stale full-document overwrite that drops keys from a parallel claim.
      if (isLicensesFile && fs.existsSync(abs)) {
        const remoteRaw = fs.readFileSync(abs, "utf8");
        body = mergeLicensesDocuments(remoteRaw, intendedBody, commitMessage);
      }
      fs.writeFileSync(abs, body, "utf8");
      await git.add({ fs, dir, filepath: relPath });
      // Skip empty commits when merge equals tip (another writer already landed).
      try {
        const status = await git.status({ fs, dir, filepath: relPath });
        if (status === "unmodified") {
          return { ok: true, durable: "github-git", sha: null, merged: true };
        }
      } catch {
        // continue to commit
      }
      let sha = null;
      try {
        sha = await git.commit({
          fs,
          dir,
          message: commitMessage,
          author: {
            name: "Apex EA",
            email: "noreply@apex-ea.com",
          },
        });
      } catch (commitErr) {
        const msg = String(commitErr?.message || commitErr || "");
        if (/nothing to commit|no changes|same as/i.test(msg)) {
          return { ok: true, durable: "github-git", sha: null, merged: true };
        }
        throw commitErr;
      }
      await git.push({
        fs,
        http,
        dir,
        remote: "origin",
        ref: branch || "main",
        onAuth,
      });
      return { ok: true, durable: "github-git", sha };
    } catch (error) {
      lastReason =
        error?.data?.statusMessage ||
        error?.message ||
        "git push failed";
      lastStatus = error?.data?.statusCode || 500;
      const retryable =
        lastStatus === 429 ||
        lastStatus === 500 ||
        lastStatus === 502 ||
        lastStatus === 503 ||
        /too many requests|rate limit|busy|non-fast-forward|rejected|cannot lock ref|not updated/i.test(
          String(lastReason)
        );
      if (lastStatus === 401 || lastStatus === 403) {
        return { ok: false, reason: lastReason, status: lastStatus };
      }
      if (!retryable && attempt >= 1) break;
      // Back off on GitHub throttling / ref lock so invite claims can land.
      const waitMs = Math.min(25000, 600 * 2 ** attempt + Math.floor(Math.random() * 400));
      await new Promise((r) => setTimeout(r, waitMs));
    } finally {
      if (dir) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  return {
    ok: false,
    reason: lastReason,
    status: lastStatus,
    conflict: /non-fast-forward|rejected|cannot lock ref|not updated/i.test(
      String(lastReason)
    ),
  };
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

    const preferFresh = Boolean(opts.preferFresh);

    // Fresh reads (claim/unlock) skip stale CDN and go straight to git.
    if (preferFresh) {
      const viaGit = await githubGetViaGit({
        repo: githubRepo,
        branch: githubBranch,
        filePath: githubPath,
      });
      if (viaGit && !viaGit.missing && viaGit.raw != null) {
        return { raw: viaGit.raw, sha: null, source: "github-git" };
      }
    }

    const raw = await githubGetRaw({
      repo: githubRepo,
      branch: githubBranch,
      filePath: githubPath,
    });
    if (raw && !raw.missing && raw.raw != null) {
      let looksEmpty = false;
      try {
        const parsed = JSON.parse(raw.raw || "{}");
        looksEmpty =
          Array.isArray(parsed?.licenses) && parsed.licenses.length === 0;
      } catch {
        looksEmpty = false;
      }
      if (!looksEmpty) {
        return { raw: raw.raw, sha: null, source: "github-raw" };
      }
      const viaGit = await githubGetViaGit({
        repo: githubRepo,
        branch: githubBranch,
        filePath: githubPath,
      });
      if (viaGit && !viaGit.missing && viaGit.raw != null) {
        return { raw: viaGit.raw, sha: null, source: "github-git" };
      }
      return { raw: raw.raw, sha: null, source: "github-raw" };
    }

    const viaGit = await githubGetViaGit({
      repo: githubRepo,
      branch: githubBranch,
      filePath: githubPath,
    });
    if (viaGit && !viaGit.missing && viaGit.raw != null) {
      return { raw: viaGit.raw, sha: null, source: "github-git" };
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
    // Prefer Contents API when we have a sha (fast). Without a sha — or when
    // the API is rate-limited — fall through to Git Smart HTTP push.
    let put = { ok: false, reason: "skipped", status: 0 };
    if (githubSha) {
      put = await githubPut({
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
    } else {
      // Try Contents create/update without sha once (new file); otherwise git.
      put = await githubPut({
        repo: githubRepo,
        branch: githubBranch,
        filePath: githubPath,
        raw: body,
        sha: null,
        message,
      });
      if (put.ok) {
        return { ok: true, durable: true, source: "github", sha: put.sha };
      }
    }

    // Contents API rate-limited / missing sha / bad credentials — Git push.
    const viaGit = await githubPutViaGit({
      repo: githubRepo,
      branch: githubBranch,
      filePath: githubPath,
      raw: body,
      message,
    });
    if (viaGit.ok) {
      return {
        ok: true,
        durable: true,
        source: "github-git",
        sha: viaGit.sha,
      };
    }
    if (put.status === 409 || put.status === 422 || viaGit.conflict) {
      return {
        ok: false,
        durable: false,
        reason: viaGit.reason || put.reason,
        conflict: true,
      };
    }
    return {
      ok: false,
      durable: false,
      reason: viaGit.reason || put.reason || "github write failed",
      status: viaGit.status || put.status,
      conflict: Boolean(viaGit.conflict),
    };
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
