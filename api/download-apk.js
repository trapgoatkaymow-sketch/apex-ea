/**
 * Guaranteed APK download — streams the sideload binary with Android MIME type.
 * Prefer local public/ files; fall back to GitHub raw when Vercel omitted the binary.
 */
import fs from "node:fs";
import path from "node:path";
import { endOptions } from "./_cors.js";

export const config = {
  maxDuration: 60,
};

const APK_NAME = "apex-ea-v2.33.apk";
const GITHUB_RAW_CANDIDATES = [
  "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/public/apex-ea-v2.33.apk",
  "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/public/apex-ea.apk",
  "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/public/apex-ea-v2.32.apk",
  "https://github.com/trapgoatkaymow-sketch/apex-ea/raw/main/public/apex-ea-v2.33.apk",
];

const LOCAL_CANDIDATES = [
  path.join(process.cwd(), "public", "apex-ea-v2.33.apk"),
  path.join(process.cwd(), "public", "apex-ea.apk"),
  path.join(process.cwd(), "public", "apex-ea-v2.32.apk"),
  path.join(process.cwd(), "apex-ea-v2.33.apk"),
  path.join(process.cwd(), "apex-ea.apk"),
  path.join(process.cwd(), "dist", "apex-ea-v2.33.apk"),
  path.join(process.cwd(), "dist", "apex-ea.apk"),
];

function findApk() {
  for (const file of LOCAL_CANDIDATES) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch {
      // try next
    }
  }
  return null;
}

function setApkHeaders(res, size = null) {
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${APK_NAME}"`
  );
  if (size != null) res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");
}

async function proxyGithubApk(req, res) {
  let lastError = "APK not found";
  for (const url of GITHUB_RAW_CANDIDATES) {
    try {
      const upstream = await fetch(url, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        redirect: "follow",
        headers: { "user-agent": "apex-ea-download-apk" },
      });
      if (!upstream.ok) {
        lastError = `GitHub ${upstream.status} for ${url}`;
        continue;
      }
      const length = upstream.headers.get("content-length");
      res.statusCode = 200;
      setApkHeaders(res, length ? Number(length) : null);
      if (req.method === "HEAD") {
        res.end();
        return true;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length < 1000) {
        lastError = "GitHub returned empty APK body";
        continue;
      }
      res.setHeader("Content-Length", String(buf.length));
      res.end(buf);
      return true;
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      error: "APK not found on server",
      hint: lastError,
    })
  );
  return false;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const file = findApk();
  if (!file) {
    await proxyGithubApk(req, res);
    return;
  }

  const stat = fs.statSync(file);
  res.statusCode = 200;
  setApkHeaders(res, stat.size);

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(file).pipe(res);
}
