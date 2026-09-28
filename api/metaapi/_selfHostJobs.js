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
    .replace(/[.#$\[\]]/g, "_")
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
  return {
    id: job.id,
    status: job.status,
    mentorEmail: job.mentorEmail || "",
    hostedByAdmin: job.hostedByAdmin || "",
    symbol: job.symbol,
    side: job.side,
    volume: job.volume,
    tradesCount: job.tradesCount,
    stopLoss: job.stopLoss ?? null,
    takeProfit: job.takeProfit ?? null,
    targeted: Number(job.targeted || 0),
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
    accepted: true,
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
    return JSON.parse(String(hit.raw));
  } catch {
    return null;
  }
}

async function writeJsonPath(path, value) {
  if (!path) return { ok: false, reason: "empty-path" };
  const raw = JSON.stringify(value);
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

export async function getSelfHostJob(jobId) {
  const id = safeId(jobId);
  if (!id) return null;
  if (memoryJobs.has(id)) return memoryJobs.get(id);
  const remote = await readJsonPath(jobPath(id));
  if (remote && remote.id) {
    memoryJobs.set(id, remote);
    return remote;
  }
  return null;
}

export async function updateSelfHostJob(jobId, patch = {}) {
  const prev = (await getSelfHostJob(jobId)) || { id: safeId(jobId) };
  return saveSelfHostJob({ ...prev, ...patch, id: prev.id || safeId(jobId) });
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
} = {}) {
  const id = safeId(jobId);
  if (!id) return { ok: false, reason: "missing-job" };
  const base = selfHostContinueBaseUrl(req);
  const url = `${base}/api/metaapi/mentor-trade`;
  const body = JSON.stringify({
    jobId: id,
    continue: true,
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
