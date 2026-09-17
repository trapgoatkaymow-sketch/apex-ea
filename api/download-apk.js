/**
 * Guaranteed APK download — streams the sideload binary with Android MIME type.
 * Use when static /apex-ea-v2.18.apk is blocked by SPA fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { endOptions } from "./_cors.js";

export const config = {
  maxDuration: 60,
};

const CANDIDATES = [
  path.join(process.cwd(), "public", "apex-ea-v2.18.apk"),
  path.join(process.cwd(), "public", "apex-ea.apk"),
  path.join(process.cwd(), "apex-ea-v2.18.apk"),
  path.join(process.cwd(), "apex-ea.apk"),
  path.join(process.cwd(), "dist", "apex-ea-v2.18.apk"),
  path.join(process.cwd(), "dist", "apex-ea.apk"),
];

function findApk() {
  for (const file of CANDIDATES) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch {
      // try next
    }
  }
  return null;
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
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "APK not found on server",
        hint: "Redeploy with public/apex-ea-v2.18.apk included",
      })
    );
    return;
  }

  const stat = fs.statSync(file);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="apex-ea-v2.18.apk"'
  );
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(file).pipe(res);
}
