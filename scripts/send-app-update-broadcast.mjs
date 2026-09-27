/**
 * Broadcast the pairs-fix / new-app email to every signup + license client.
 * Uses the live production emails API (Brevo on Vercel).
 *
 * Usage:
 *   node scripts/send-app-update-broadcast.mjs
 *   node scripts/send-app-update-broadcast.mjs --dry-run
 */
import fs from "node:fs";
import path from "node:path";

const API = "https://www.apex-ea.com/api/emails";
const SUPER_ADMIN = "trapgoatkaymow22@icloud.com";
const DOWNLOAD_URL = "https://www.apex-ea.com/apex-ea-v2.34.apk";
const UPDATE_PAGE = "https://www.apex-ea.com/app-update";
const IMAGE_URL = "https://www.apex-ea.com/email/pairs-fixed.png";
const DRY = process.argv.includes("--dry-run");

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function loadRecipients() {
  const seen = new Set();
  const out = [];
  const push = (email, name = "") => {
    const key = normalizeEmail(email);
    if (!key.includes("@") || seen.has(key)) return;
    seen.add(key);
    out.push({ email: key, name: String(name || "").trim() });
  };

  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "data/signups.json"), "utf8")
    );
    const list = Array.isArray(raw) ? raw : raw.signups || [];
    for (const row of list) push(row.email, row.name || row.username || "");
  } catch (error) {
    console.warn("signups read failed", error.message);
  }

  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "data/licenses.json"), "utf8")
    );
    const list = Array.isArray(raw) ? raw : raw.licenses || [];
    for (const row of list) {
      push(row.clientEmail || row.email, row.clientName || row.name || "");
    }
  } catch (error) {
    console.warn("licenses read failed", error.message);
  }

  return out;
}

const subject = "ApexEA update — pairs fixed · download the new app (v2.34)";
const message = [
  "We fixed the Interface 1 pairs / Save Symbol issue.",
  "",
  "You can add your own pairs again, set lot size, action, platform, and number of trades, then tap Save Symbol.",
  "",
  "Please delete the old app and install this new build so you get the fix:",
  DOWNLOAD_URL,
  "",
  `Update page (with screenshot): ${UPDATE_PAGE}`,
].join("\n");

const recipients = loadRecipients();
console.log(`Recipients: ${recipients.length}`);
if (!recipients.length) {
  console.error("No recipients found");
  process.exit(1);
}

if (DRY) {
  console.log("Dry run — first 10:", recipients.slice(0, 10));
  console.log({ subject, downloadUrl: DOWNLOAD_URL, imageUrl: IMAGE_URL });
  process.exit(0);
}

const body = {
  action: "broadcast",
  adminEmail: SUPER_ADMIN,
  subject,
  message,
  imageUrl: IMAGE_URL,
  downloadUrl: DOWNLOAD_URL,
  ctaLabel: "Download new app (v2.34)",
  recipients,
  concurrency: 4,
};

const res = await fetch(API, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
let data = null;
try {
  data = text ? JSON.parse(text) : null;
} catch {
  data = { raw: text };
}
console.log("HTTP", res.status);
console.log(JSON.stringify(data, null, 2).slice(0, 4000));
if (!res.ok) process.exit(1);
console.log(
  `Done — sent=${data?.sentCount ?? "?"} failed=${data?.failedCount ?? "?"} total=${data?.total ?? recipients.length}`
);
