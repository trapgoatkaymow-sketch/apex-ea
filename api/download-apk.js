/**
 * APK download endpoint.
 * Prefer a local file when present; otherwise 302 to GitHub/jsDelivr so we
 * never stream an 8MB+ body through a Vercel serverless function (size limits).
 */
import fs from "node:fs";
import path from "node:path";
import { endOptions } from "./_cors.js";

export const config = {
  maxDuration: 30,
};

const APK_NAME = "apex-ea-v2.20.apk";

/** Stable public URLs — clients follow the redirect and download the binary. */
const REMOTE_APK_URLS = [
  "https://cdn.jsdelivr.net/gh/trapgoatkaymow-sketch/apex-ea@main/public/apex-ea-v2.20.apk",
  "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/public/apex-ea-v2.20.apk",
  "https://cdn.jsdelivr.net/gh/trapgoatkaymow-sketch/apex-ea@main/public/apex-ea.apk",
  "https://raw.githubusercontent.com/trapgoatkaymow-sketch/apex-ea/main/public/apex-ea.apk",
];

const LOCAL_CANDIDATES = [
  path.join(process.cwd(), "public", "apex-ea-v2.20.apk"),
  path.join(process.cwd(), "public", "apex-ea.apk"),
  path.join(process.cwd(), "apex-ea-v2.20.apk"),
  path.join(process.cwd(), "apex-ea.apk"),
  path.join(process.cwd(), "dist", "apex-ea-v2.20.apk"),
  path.join(process.cwd(), "dist", "apex-ea.apk"),
];

function findApk() {
  for (const file of LOCAL_CANDIDATES) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 100000) {
        return file;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function setApkHeaders(res, size = null) {
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader("Content-Disposition", `attachment; filename="${APK_NAME}"`);
  if (size != null) res.setHeader("Content-Length", String(size));
  res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");
}

async function pickRemoteApkUrl() {
  for (const url of REMOTE_APK_URLS) {
    try {
      const head = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: { "user-agent": "apex-ea-download-apk" },
      });
      if (head.ok) {
        const len = Number(head.headers.get("content-length") || 0);
        if (!len || len > 100000) return url;
      }
    } catch {
      // try next
    }
  }
  // Last resort — jsDelivr usually works even when HEAD is blocked.
  return REMOTE_APK_URLS[0];
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

  // Optional: ?direct=1 forces redirect even if a local copy exists (debug).
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `http://${host}`);
  const forceRemote = url.searchParams.get("direct") === "1";

  const file = forceRemote ? null : findApk();
  if (file) {
    const stat = fs.statSync(file);
    res.statusCode = 200;
    setApkHeaders(res, stat.size);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
    return;
  }

  try {
    const remote = await pickRemoteApkUrl();
    res.statusCode = 302;
    res.setHeader("Location", remote);
    res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
    res.setHeader("Access-Control-Allow-Origin", "*");
    // Helpful for browsers that show the intermediate response.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`Download: ${remote}\n`);
  } catch (error) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "APK download temporarily unavailable",
        hint: error?.message || "Try again in a moment",
        links: REMOTE_APK_URLS,
      })
    );
  }
}
