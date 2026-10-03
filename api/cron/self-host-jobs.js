/**
 * Safety net: re-kick stalled / due self-host trade jobs if a hop was lost.
 * Vercel Cron: every 5 minutes (see vercel.json) — keeps Pro GB-hours down.
 * Primary hops still chain via waitUntil; this only recovers lost kicks.
 */
import {
  getSelfHostJob,
  kickSelfHostJobContinue,
  listQueuedSelfHostJobIds,
} from "../metaapi/_selfHostJobs.js";

export const config = { maxDuration: 30 };

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return true; // allow when unset (dev / first deploy)
  const auth = String(req.headers?.authorization || "");
  return auth === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const ids = await listQueuedSelfHostJobIds();
  const kicked = [];
  const skipped = [];
  const now = Date.now();

  for (const jobId of ids) {
    const job = await getSelfHostJob(jobId);
    if (!job) {
      skipped.push({ jobId, reason: "missing" });
      continue;
    }
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      skipped.push({ jobId, reason: job.status });
      continue;
    }
    const runAt = Number(job.runAt || 0);
    const updatedAt = Number(job.updatedAt || job.createdAt || 0);
    const due = runAt <= now;
    const stale = now - updatedAt > 45_000;
    const leaseUntil = Number(job.leaseUntil || 0);
    const leaseExpired = leaseUntil <= now;
    if (!due && job.status === "scheduled") {
      skipped.push({ jobId, reason: "not-due" });
      continue;
    }
    if (!stale && !leaseExpired && job.status === "running") {
      skipped.push({ jobId, reason: "fresh-running" });
      continue;
    }
    const hop = await kickSelfHostJobContinue({ jobId, req, force: true });
    kicked.push({ jobId, ok: hop.ok, status: hop.status || null });
  }

  sendJson(res, 200, {
    ok: true,
    queued: ids.length,
    kicked: kicked.length,
    details: { kicked, skipped },
  });
}
