/**
 * Durable self-host trade jobs (Firebase-first).
 * Survives portal close / app switch — execution continues server-side.
 */
import crypto from "crypto";
import {
  firebaseConfigured,
  firebaseGet,
  firebasePut,
  toFirebasePath,
} from "../_firebaseRtdb.js";

const JOB_ROOT = process.env.SELF_HOST_JOBS_FIREBASE_PATH || "apexea/selfHostJobs";
const QUEUE_PATH =
  process.env.SELF_HOST_JOB_QUEUE_FIREBASE_PATH || "apexea/selfHostJobQueue";

const memoryJobs = new Map();
const memoryQueue = new Set();

function safeId(id) {
  return String(id || "")
    .trim()
    .replace(/[.#$[\]]/g, "_")
    .slice(0, 80);
}

function jobPath(jobId) {
  const id = safeId(jobId);
  if (!id) return "";
  return `${JOB_ROOT}/${id}`;
}

export function newSelfHostJobId() {
  return `shj_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

export function publicSelfHostJob(job) {
  if (!job) return null;
  const status = String(job.status || "");
  const running = ["queued", "scheduled", "running"].includes(status);
  return {
    id: job.id,
    status,
    mentorEmail: job.mentorEmail || "",
    hostedByAdmin: job.hostedByAdmin || "",
    symbol: job.symbol,
    side: job.side,
    volume: job.volume,
    tradesCount: job.tradesCount,
    stopLoss: job.stopLoss ?? null,
    takeProfit: job.takeProfit ?? null,
    targeted: Number(job.targeted || (Array.isArray(job.targets) ? job.targets.length : 0) || 0),
    cursor: Number(job.cursor || 0),
    placed: Number(job.placed || 0),
    placedClients: Number(job.placedClients || 0),
    failed: Number(job.failed || 0),
    offline: Number(job.offline || 0),
    runAt: Number(job.runAt || 0),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null,
    error: job.error || "",
    accepted: running,
    background: true,
    results: Array.isArray(job.results) ? job.results : [],
  };
}

async function readJsonPath(path) {
  if (!path) return null;
  if (!firebaseConfigured()) return null;
  try {
    const hit = await firebaseGet(toFirebasePath(path));
    if (!hit || hit.missing || hit.raw == null) return null;
    let parsed = JSON.parse(String(hit.raw));
    // Support older docs that were stored as { __raw: "<job>" } at the JSON layer.
    if (parsed && typeof parsed === "object" && typeof parsed.__raw === "string") {
      parsed = JSON.parse(parsed.__raw);
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeJsonPath(path, value) {
  if (!path) return { ok: false, reason: "empty-path" };
  // Wrap as __raw so email keys with "." never break RTDB child paths.
  const raw = JSON.stringify({ __raw: JSON.stringify(value) });
  if (firebaseConfigured()) {
    const put = await firebasePut(toFirebasePath(path), raw);
    if (put?.ok) return put;
  }
  return { ok: false, reason: "firebase-unavailable" };
}

export async function saveSelfHostJob(job) {
  const id = safeId(job?.id);
  if (!id) throw new Error("job id required");
  const next = {
    ...job,
    id,
    updatedAt: Date.now(),
  };
  memoryJobs.set(id, next);
  const put = await writeJsonPath(jobPath(id), next);
  if (!put.ok) {
    // Memory still holds the job for this instance / chain hop.
    console.warn("selfHostJob firebase write failed", put.reason || "unknown");
  }
  return next;
}

export async function getSelfHostJob(jobId, { preferRemote = false } = {}) {
  const id = safeId(jobId);
  if (!id) return null;
  if (!preferRemote && memoryJobs.has(id)) return memoryJobs.get(id);
  const remote = await readJsonPath(jobPath(id));
  if (remote && remote.id) {
    // Prefer the copy that still has the target roster if memory was a stub.
    const mem = memoryJobs.get(id);
    const remoteTargets = Array.isArray(remote.targets) ? remote.targets.length : 0;
    const memTargets = Array.isArray(mem?.targets) ? mem.targets.length : 0;
    const chosen =
      mem && memTargets > remoteTargets && Number(mem.updatedAt || 0) >= Number(remote.updatedAt || 0)
        ? mem
        : remote;
    memoryJobs.set(id, chosen);
    return chosen;
  }
  if (memoryJobs.has(id)) return memoryJobs.get(id);
  return null;
}

export async function updateSelfHostJob(jobId, patch = {}) {
  const id = safeId(jobId);
  let prev = await getSelfHostJob(id);
  if (!prev || (!Array.isArray(prev.targets) && Number(prev.targeted || 0) > 0)) {
    prev = (await getSelfHostJob(id, { preferRemote: true })) || prev;
  }
  if (!prev) {
    // Never create a stub job from a patch — that wipes the roster.
    throw Object.assign(new Error("Self-host job not found for update"), {
      status: 404,
      code: "JOB_NOT_FOUND",
    });
  }
  const next = { ...prev, ...patch, id: prev.id || id };
  // Protect the target roster from accidental wipes.
  if (!Array.isArray(next.targets) || next.targets.length === 0) {
    if (Array.isArray(prev.targets) && prev.targets.length) {
      next.targets = prev.targets;
    }
  }
  if (!next.targeted && prev.targeted) next.targeted = prev.targeted;
  if (!next.botMetaByClient && prev.botMetaByClient) {
    next.botMetaByClient = prev.botMetaByClient;
  }
  // Monotonic progress — a stale hop must never rewind cursor/results.
  const prevCursor = Number(prev.cursor || 0);
  const nextCursor = Number(next.cursor || 0);
  if (nextCursor < prevCursor && !patch.finishedAt) {
    next.cursor = prevCursor;
    next.placed = Math.max(Number(prev.placed || 0), Number(next.placed || 0));
    next.placedClients = Math.max(
      Number(prev.placedClients || 0),
      Number(next.placedClients || 0)
    );
    next.failed = Math.max(Number(prev.failed || 0), Number(next.failed || 0));
    next.offline = Math.max(Number(prev.offline || 0), Number(next.offline || 0));
    if (
      Array.isArray(prev.results) &&
      (!Array.isArray(next.results) || next.results.length < prev.results.length)
    ) {
      next.results = prev.results;
    }
  }
  return saveSelfHostJob(next);
}

async function readQueue() {
  if (memoryQueue.size) return new Set(memoryQueue);
  const remote = await readJsonPath(QUEUE_PATH);
  const ids = Array.isArray(remote?.ids) ? remote.ids : [];
  for (const id of ids) memoryQueue.add(safeId(id));
  return new Set(memoryQueue);
}

async function writeQueue(ids) {
  const list = [...ids].map(safeId).filter(Boolean).slice(-200);
  memoryQueue.clear();
  for (const id of list) memoryQueue.add(id);
  await writeJsonPath(QUEUE_PATH, { ids: list, updatedAt: Date.now() });
}

export async function enqueueSelfHostJobId(jobId) {
  const id = safeId(jobId);
  if (!id) return;
  const queue = await readQueue();
  queue.add(id);
  await writeQueue(queue);
}

export async function dequeueSelfHostJobId(jobId) {
  const id = safeId(jobId);
  if (!id) return;
  const queue = await readQueue();
  queue.delete(id);
  await writeQueue(queue);
}

export async function listQueuedSelfHostJobIds() {
  return [...(await readQueue())];
}

/** Absolute URL for self-continue hops (works on Vercel + local). */
export function selfHostContinueBaseUrl(req) {
  const envHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_URL ||
    process.env.PUBLIC_SITE_URL ||
    "www.apex-ea.com";
  const proto = "https";
  if (req?.headers?.host && /localhost|127\.0\.0\.1/i.test(String(req.headers.host))) {
    return `http://${req.headers.host}`;
  }
  const host = String(envHost).replace(/^https?:\/\//, "");
  return `${proto}://${host}`;
}

export async function kickSelfHostJobContinue({
  jobId,
  req = null,
  delayMs = 0,
  force = true,
} = {}) {
  const id = safeId(jobId);
  if (!id) return { ok: false, reason: "missing-job" };
  const base = selfHostContinueBaseUrl(req);
  const url = `${base}/api/metaapi/mentor-trade`;
  const body = JSON.stringify({
    jobId: id,
    continue: true,
    force: Boolean(force),
    delayMs: Math.max(0, Number(delayMs) || 0),
  });
  try {
    // Do not await the full job — just ensure the hop is accepted.
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-apexea-self-host-continue": "1",
      },
      body,
      cache: "no-store",
    });
    return { ok: res.ok || res.status === 202, status: res.status };
  } catch (error) {
    return { ok: false, reason: error?.message || "continue-fetch-failed" };
  }
}
