/**
 * Shared durable JSON document store for serverless.
 *
 * Priority for reads:
 *  1) Firebase Realtime Database (FIREBASE_DATABASE_URL + service account)
 *  2) Vercel Blob (BLOB_READ_WRITE_TOKEN) — shared across all instances
 *  3) GitHub Contents API (SIGNUPS_GITHUB_TOKEN / FALLBACK)
 *  4) GitHub raw CDN (when Contents API is rate-limited)
 *  5) Env snapshot (e.g. LICENSES_SNAPSHOT_B64) — read-only seed
 *  6) /tmp + in-memory — per-instance only
 *
 * Writes: Firebase → Blob → GitHub Contents API → isomorphic-git push.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { FALLBACK_GITHUB_TOKEN } from "./signups/_githubToken.js";

async function firebaseApi() {
  try {
    return await import("./_firebaseRtdb.js");
  } catch (error) {
    return {
      firebaseConfigured: () => false,
      firebaseGet: async () => null,
      firebasePut: async () => ({
        ok: false,
        reason: error?.message || "firebase-module-failed",
      }),
      toFirebasePath: (p) =>
        String(p || "")
          .trim()
          .replace(/^\/+/, "")
          .replace(/\.json$/i, "")
          .replace(/[.#$\[\]]/g, "_"),
    };
  }
}

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
    const gitMod = await import("isomorphic-git");
    const git = gitMod.default || gitMod;
    const httpMod = await import("isomorphic-git/http/node/index.js");
    const http = httpMod.default || httpMod;
    if (!git?.clone || !http?.request) return null;
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
 * Merge two mentors.json documents by email so concurrent/cold writes never
 * wipe pending mentor signups that landed in another store (Firebase vs GitHub).
 * Incoming (intended) wins field-level updates for the same email; remote-only
 * rows are always kept. Credentials are never blanked out.
 */
function mergeMentorsDocuments(remoteRaw, intendedRaw, opts = {}) {
  const forceIncomingStatus = opts.forceIncomingStatus !== false;
  let remote;
  let intended;
  try {
    remote = JSON.parse(String(remoteRaw || "{}"));
    intended = JSON.parse(String(intendedRaw || "{}"));
  } catch {
    return String(intendedRaw ?? "");
  }
  const intendedList = Array.isArray(intended?.mentors) ? intended.mentors : null;
  const remoteList = Array.isArray(remote?.mentors) ? remote.mentors : null;
  if (!intendedList) return String(intendedRaw ?? "");
  if (!remoteList) return String(intendedRaw ?? "");

  const normEmail = (email) =>
    String(email || "")
      .trim()
      .toLowerCase();
  const stamp = (row) =>
    Number(
      row?.withdrawalRequestedAt ||
        row?.usernameUpdatedAt ||
        row?.statusUpdatedAt ||
        row?.appColorUpdatedAt ||
        row?.licenseKeysUpdatedAt ||
        row?.banking?.updatedAt ||
        row?.createdAt ||
        0
    ) || 0;
  // Only real status writes count — never fall back to createdAt (that made
  // stale approved rows beat a fresh Decline during multi-store reads).
  const statusStamp = (row) => Number(row?.statusUpdatedAt) || 0;
  const statusRank = (status) => {
    const s = String(status || "pending").toLowerCase();
    if (s === "approved") return 3;
    if (s === "declined") return 2;
    if (s === "pending") return 1;
    return 0;
  };

  const map = new Map();
  const ingest = (row, { preferIncoming = false } = {}) => {
    const email = normEmail(row?.email);
    if (!email || !email.includes("@")) return;
    const prev = map.get(email);
    if (!prev) {
      map.set(email, { ...row, email });
      return;
    }
    const incomingNewer = stamp(row) >= stamp(prev);
    const takeIncoming = preferIncoming || incomingNewer;
    const primary = takeIncoming ? row : prev;
    const secondary = takeIncoming ? prev : row;
    let nextStatus = prev.status || row.status || "pending";
    let nextStatusAt = Math.max(statusStamp(prev), statusStamp(row)) || null;
    if (preferIncoming && forceIncomingStatus && row.status) {
      // Write path: the intended document's status always wins.
      nextStatus = row.status;
      nextStatusAt = Math.max(statusStamp(row), Date.now());
    } else if (statusStamp(row) || statusStamp(prev)) {
      const newer = statusStamp(row) >= statusStamp(prev) ? row : prev;
      nextStatus = newer.status || nextStatus;
      nextStatusAt = statusStamp(newer) || nextStatusAt;
    } else if (statusRank(row.status) > statusRank(prev.status)) {
      // Neither stamped — keep stronger status only when strictly greater so we
      // do not flip declined→approved when ranks are compared carelessly.
      nextStatus = row.status || prev.status || nextStatus;
    }
    map.set(email, {
      ...secondary,
      ...primary,
      email,
      status: nextStatus || "pending",
      statusUpdatedAt: nextStatusAt,
      passwordHash: primary.passwordHash || secondary.passwordHash || "",
      salt: primary.salt || secondary.salt || "",
      username: (() => {
        const a = String(primary.username || "").trim();
        const b = String(secondary.username || "").trim();
        const aAt = Number(primary.usernameUpdatedAt) || 0;
        const bAt = Number(secondary.usernameUpdatedAt) || 0;
        // Profile saves stamp usernameUpdatedAt — newest portal username wins
        // across Firebase / Blob / GitHub merges (fixes sticky "Kamogelo").
        if (aAt || bAt) {
          if (aAt >= bAt && a) return a;
          if (bAt > aAt && b) return b;
        }
        return a || b || "";
      })(),
      usernameUpdatedAt:
        Math.max(
          Number(primary.usernameUpdatedAt) || 0,
          Number(secondary.usernameUpdatedAt) || 0
        ) || null,
      contact: primary.contact || secondary.contact || "",
      createdAt: (() => {
        const a = Number(primary.createdAt) || 0;
        const b = Number(secondary.createdAt) || 0;
        if (a && b) return Math.min(a, b);
        return a || b || Date.now();
      })(),
      banking: primary.banking?.accountNumber
        ? primary.banking
        : secondary.banking || primary.banking,
      licenseKeysAllowed:
        primary.licenseKeysAllowed ?? secondary.licenseKeysAllowed,
      appColor: primary.appColor || secondary.appColor || "",
      appColorUpdatedAt: Math.max(
        Number(primary.appColorUpdatedAt) || 0,
        Number(secondary.appColorUpdatedAt) || 0
      ) || null,
      withdrawalRequests: (() => {
        const a = Array.isArray(primary.withdrawalRequests)
          ? primary.withdrawalRequests
          : [];
        const b = Array.isArray(secondary.withdrawalRequests)
          ? secondary.withdrawalRequests
          : [];
        const floor = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const merged = [...a, ...b]
          .map((t) => Number(t))
          .filter((t) => Number.isFinite(t) && t >= floor);
        return Array.from(new Set(merged)).sort((x, y) => x - y);
      })(),
      withdrawalRequestedAt:
        Math.max(
          Number(primary.withdrawalRequestedAt) || 0,
          Number(secondary.withdrawalRequestedAt) || 0
        ) || null,
    });
  };

  // Remote first (preserve), then intended overwrites same emails.
  for (const row of remoteList) ingest(row, { preferIncoming: false });
  for (const row of intendedList) ingest(row, { preferIncoming: true });

  const mentors = Array.from(map.values())
    .filter((m) => m.email && m.email.includes("@") && m.passwordHash && m.salt)
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

  return JSON.stringify({ mentors }, null, 2) + "\n";
}

/**
 * Merge two licenses.json documents by key so concurrent git pushes do not
 * wipe each other's newly claimed keys. Prefer the newer row stamp.
 * Reactivate/deactivate (newer used:false) must clear device locks — never
 * OR used/deviceId with an older used:true row (that undoes Reactivate).
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
    const winningUsed = Boolean(newer.used);
    map.set(key, {
      ...older,
      ...newer,
      key: String(newer.key || older.key || key),
      // Newer stamp owns used/device lock. used:false clears the phone bind.
      used: winningUsed,
      deviceId: winningUsed
        ? newer.deviceId || older.deviceId || null
        : null,
      boundAt: winningUsed ? newer.boundAt || older.boundAt || null : null,
      usedAt: winningUsed ? newer.usedAt || older.usedAt || null : null,
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

  let git;
  let http;
  try {
    const gitMod = await import("isomorphic-git");
    git = gitMod.default || gitMod;
    // Node ESM cannot import the http/node directory — use the explicit entry.
    const httpMod = await import("isomorphic-git/http/node/index.js");
    http = httpMod.default || httpMod;
  } catch (error) {
    return {
      ok: false,
      reason: `isomorphic-git import failed: ${error?.message || error}`,
      status: 500,
    };
  }
  if (!git?.clone || !http?.request) {
    return { ok: false, reason: "isomorphic-git unavailable", status: 500 };
  }
  const url = `https://github.com/${repo}.git`;
  const onAuth = () => ({ username: token, password: "x-oauth-basic" });
  const intendedBody = String(raw ?? "");
  const commitMessage = message || `chore: update ${relPath}`;
  let lastReason = "git push failed";
  let lastStatus = 500;
  const isLicensesFile = /licenses\.json$/i.test(relPath);
  const isMentorsFile = /mentors\.json$/i.test(relPath);

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
      if (isMentorsFile && fs.existsSync(abs)) {
        const remoteRaw = fs.readFileSync(abs, "utf8");
        body = mergeMentorsDocuments(remoteRaw, intendedBody);
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

/** Seed Firebase from Blob/GitHub on first read so rollout fills RTDB automatically. */
async function seedFirebaseFrom(result, rtdbPath) {
  const fb = await firebaseApi();
  if (
    !result ||
    result.raw == null ||
    !rtdbPath ||
    !fb.firebaseConfigured() ||
    result.source === "firebase"
  ) {
    return result;
  }
  try {
    await fb.firebasePut(rtdbPath, result.raw);
  } catch {
    // best-effort
  }
  return result;
}

/**
 * @param {object} opts
 * @param {string} opts.blobPath - Vercel Blob pathname (e.g. apexea/mt5-accounts.json)
 * @param {string} [opts.firebasePath] - RTDB path (defaults from blobPath/githubPath)
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
    firebasePath,
    githubRepo =
      process.env.SIGNUPS_GITHUB_REPO || "trapgoatkaymow-sketch/apex-ea",
    githubBranch = process.env.SIGNUPS_GITHUB_BRANCH || "main",
    githubPath,
    snapshotEnv,
    localPaths = [],
  } = opts;

  const fb = await firebaseApi();
  const rtdbPath =
    firebasePath ||
    fb.toFirebasePath(blobPath || githubPath || "") ||
    "";

  const mentorsViaGit = /mentors\.json$/i.test(
    String(githubPath || blobPath || "")
  );

  // Mentors: union-merge across Firebase / Blob / GitHub so a shorter primary
  // copy cannot hide pending signups that only landed in another store.
  if (mentorsViaGit) {
    const pieces = [];
    if (rtdbPath && fb.firebaseConfigured()) {
      const hit = await fb.firebaseGet(rtdbPath);
      if (hit && !hit.missing && hit.raw != null) pieces.push(hit.raw);
    }
    const blob = blobPath ? await blobGet(blobPath) : null;
    if (blob && !blob.missing && blob.raw != null) pieces.push(blob.raw);

    let githubResult = null;
    if (githubPath) {
      const gh = await githubGet({
        repo: githubRepo,
        branch: githubBranch,
        filePath: githubPath,
      });
      if (gh && !gh.missing && gh.raw != null) {
        githubResult = { raw: gh.raw, sha: gh.sha, source: "github" };
      }
      if (!githubResult) {
        const raw = await githubGetRaw({
          repo: githubRepo,
          branch: githubBranch,
          filePath: githubPath,
        });
        if (raw && !raw.missing && raw.raw != null) {
          githubResult = { raw: raw.raw, sha: null, source: "github-raw" };
        }
      }
      if (!githubResult) {
        const viaGit = await githubGetViaGit({
          repo: githubRepo,
          branch: githubBranch,
          filePath: githubPath,
        });
        if (viaGit && !viaGit.missing && viaGit.raw != null) {
          githubResult = { raw: viaGit.raw, sha: null, source: "github-git" };
        }
      }
      if (githubResult?.raw) pieces.push(githubResult.raw);
    }

    for (const file of localPaths) {
      const local = readLocalFile(file);
      if (local != null) pieces.push(local);
    }

    if (pieces.length) {
      let merged = pieces[0];
      for (let i = 1; i < pieces.length; i += 1) {
        // Read-path union: never force later store status over an earlier
        // stamped Decline/Approve — only statusUpdatedAt (or rank) decides.
        merged = mergeMentorsDocuments(merged, pieces[i], {
          forceIncomingStatus: false,
        });
      }
      return seedFirebaseFrom(
        {
          raw: merged,
          sha: githubResult?.sha || null,
          source: pieces.length > 1 ? "mentors-merged" : "mentors",
        },
        rtdbPath
      );
    }
    return { raw: null, sha: null, source: "empty" };
  }

  // 1) Firebase Realtime Database — primary shared store when configured.
  if (rtdbPath && fb.firebaseConfigured()) {
    const hit = await fb.firebaseGet(rtdbPath);
    if (hit && !hit.missing && hit.raw != null) {
      return { raw: hit.raw, sha: hit.etag || null, source: "firebase" };
    }
  }

  const blob = blobPath ? await blobGet(blobPath) : null;
  // Licenses: GitHub is source of truth, but Blob may hold keys written during
  // GitHub outages — merge so Generate → Unlock never misses a fresh key.
  const licensesViaGit = /licenses\.json$/i.test(
    String(githubPath || blobPath || "")
  );
  if (blob && !blob.missing && blob.raw != null && !licensesViaGit) {
    return seedFirebaseFrom(
      { raw: blob.raw, sha: blob.etag, source: "blob" },
      rtdbPath
    );
  }

  if (githubPath) {
    let githubResult = null;
    const gh = await githubGet({
      repo: githubRepo,
      branch: githubBranch,
      filePath: githubPath,
    });
    if (gh && !gh.missing && gh.raw != null) {
      githubResult = { raw: gh.raw, sha: gh.sha, source: "github" };
    }

    const preferFresh = Boolean(opts.preferFresh);

    // Fresh reads (claim/unlock) skip stale CDN and go straight to git.
    if (!githubResult && preferFresh) {
      const viaGit = await githubGetViaGit({
        repo: githubRepo,
        branch: githubBranch,
        filePath: githubPath,
      });
      if (viaGit && !viaGit.missing && viaGit.raw != null) {
        githubResult = { raw: viaGit.raw, sha: null, source: "github-git" };
      }
    }

    if (!githubResult) {
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
          githubResult = { raw: raw.raw, sha: null, source: "github-raw" };
        } else {
          const viaGit = await githubGetViaGit({
            repo: githubRepo,
            branch: githubBranch,
            filePath: githubPath,
          });
          if (viaGit && !viaGit.missing && viaGit.raw != null) {
            githubResult = { raw: viaGit.raw, sha: null, source: "github-git" };
          } else {
            githubResult = { raw: raw.raw, sha: null, source: "github-raw" };
          }
        }
      }
    }

    if (!githubResult) {
      const viaGit = await githubGetViaGit({
        repo: githubRepo,
        branch: githubBranch,
        filePath: githubPath,
      });
      if (viaGit && !viaGit.missing && viaGit.raw != null) {
        githubResult = { raw: viaGit.raw, sha: null, source: "github-git" };
      }
    }

    if (licensesViaGit && githubResult?.raw && blob && !blob.missing && blob.raw) {
      try {
        const merged = mergeLicensesDocuments(
          blob.raw,
          githubResult.raw,
          "license read merge"
        );
        return seedFirebaseFrom(
          {
            raw: merged,
            sha: githubResult.sha,
            source: `${githubResult.source}+blob`,
          },
          rtdbPath
        );
      } catch {
        // fall through to github-only
      }
    }
    if (githubResult?.raw != null) {
      return seedFirebaseFrom(githubResult, rtdbPath);
    }
    if (licensesViaGit && blob && !blob.missing && blob.raw != null) {
      return seedFirebaseFrom(
        { raw: blob.raw, sha: blob.etag, source: "blob" },
        rtdbPath
      );
    }
  }

  if (snapshotEnv) {
    const snap = readEnvSnapshot(snapshotEnv);
    if (snap != null) {
      return seedFirebaseFrom(
        { raw: snap, sha: null, source: "snapshot" },
        rtdbPath
      );
    }
  }

  for (const file of localPaths) {
    const local = readLocalFile(file);
    if (local != null) {
      return seedFirebaseFrom(
        { raw: local, sha: "local", source: "local" },
        rtdbPath
      );
    }
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
    firebasePath,
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

  const fb = await firebaseApi();
  const rtdbPath =
    firebasePath ||
    fb.toFirebasePath(blobPath || githubPath || "") ||
    "";

  const licensesViaGit = /licenses\.json$/i.test(
    String(githubPath || blobPath || "")
  );
  const mentorsViaGit = /mentors\.json$/i.test(
    String(githubPath || blobPath || "")
  );

  // Mentors: merge with existing durable copies before any put so a cold
  // instance with a short roster cannot wipe pending signups.
  let mentorsBody = body;
  if (mentorsViaGit) {
    try {
      if (rtdbPath && fb.firebaseConfigured()) {
        const hit = await fb.firebaseGet(rtdbPath);
        if (hit && !hit.missing && hit.raw != null) {
          mentorsBody = mergeMentorsDocuments(hit.raw, mentorsBody);
        }
      }
      if (blobPath) {
        const blob = await blobGet(blobPath);
        if (blob && !blob.missing && blob.raw != null) {
          mentorsBody = mergeMentorsDocuments(blob.raw, mentorsBody);
        }
      }
      if (githubPath) {
        const gh = await githubGet({
          repo: githubRepo,
          branch: githubBranch,
          filePath: githubPath,
        });
        if (gh && !gh.missing && gh.raw != null) {
          mentorsBody = mergeMentorsDocuments(gh.raw, mentorsBody);
        }
      }
    } catch {
      mentorsBody = body;
    }
    for (const file of localPaths) writeLocalFile(file, mentorsBody);
  }

  // 1) Firebase first when configured — true shared database.
  if (rtdbPath && fb.firebaseConfigured()) {
    const put = await fb.firebasePut(rtdbPath, mentorsViaGit ? mentorsBody : body);
    if (put.ok) {
      // Best-effort mirrors so cold Blob/GitHub reads still work during rollout.
      if (blobPath) await blobPut(blobPath, mentorsViaGit ? mentorsBody : body);
      return { ok: true, durable: true, source: "firebase" };
    }
  }

  // Non-license docs can still use Blob first.
  if (blobPath && !licensesViaGit) {
    const put = await blobPut(blobPath, mentorsViaGit ? mentorsBody : body);
    if (put.ok) return { ok: true, durable: true, source: "blob" };
  }

  if (githubPath) {
    // Resolve / refresh Contents sha so updates work when the caller only
    // read via raw CDN (sha:null) — common under Contents API rate limits.
    let sha = githubSha || null;
    let put = { ok: false, reason: "skipped", status: 0 };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const writeBody = mentorsViaGit ? mentorsBody : body;
      if (!sha) {
        const latest = await githubGet({
          repo: githubRepo,
          branch: githubBranch,
          filePath: githubPath,
        });
        if (latest?.sha) sha = latest.sha;
      }
      put = await githubPut({
        repo: githubRepo,
        branch: githubBranch,
        filePath: githubPath,
        raw: writeBody,
        sha,
        message,
      });
      if (put.ok) {
        // Mirror licenses to Blob after GitHub so cold reads stay fast, but
        // GitHub remains the source of truth.
        if (licensesViaGit && blobPath) {
          await blobPut(blobPath, writeBody);
        }
        return { ok: true, durable: true, source: "github", sha: put.sha };
      }
      // Conflict / missing sha — refresh and retry.
      if (put.status === 409 || put.status === 422 || !sha) {
        const latest = await githubGet({
          repo: githubRepo,
          branch: githubBranch,
          filePath: githubPath,
        });
        sha = latest?.sha || null;
        if (mentorsViaGit && latest?.raw) {
          mentorsBody = mergeMentorsDocuments(latest.raw, mentorsBody);
        }
        continue;
      }
      // Rate limit — break to git push.
      if (put.status === 403 || put.status === 429) break;
      break;
    }

    // Contents API rate-limited / missing sha / bad credentials — Git push.
    const viaGit = await githubPutViaGit({
      repo: githubRepo,
      branch: githubBranch,
      filePath: githubPath,
      raw: mentorsViaGit ? mentorsBody : body,
      message,
    });
    if (viaGit.ok) {
      if (licensesViaGit && blobPath) {
        await blobPut(blobPath, mentorsViaGit ? mentorsBody : body);
      }
      return {
        ok: true,
        durable: true,
        source: "github-git",
        sha: viaGit.sha,
      };
    }

    // Last resort for Generate: Blob is still shared across serverless
    // instances. Prefer this over blocking mentors when GitHub is down.
    if (licensesViaGit && blobPath) {
      const blob = await blobPut(blobPath, body);
      if (blob.ok) {
        return {
          ok: true,
          durable: true,
          source: "blob-fallback",
          reason: viaGit.reason || put.reason || null,
        };
      }
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
