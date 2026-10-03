/**
 * Durable broker-connect jobs (Firebase + memory).
 * Lets ConnectEx finish after the HTTP response so clients never sit on 504.
 */
import crypto from "crypto";
import {
  firebaseConfigured,
  firebaseGet,
  firebasePut,
  toFirebasePath,
} from "../_firebaseRtdb.js";

const JOB_ROOT =
  process.env.CONNECT_JOBS_FIREBASE_PATH || "apexea/connectJobs";

const memoryJobs = new Map();

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

export function newConnectJobId() {
  return `cnj_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

export function publicConnectJob(job) {
  if (!job) return null;
  const status = String(job.status || "");
  return {
    id: job.id,
    status,
    pending: status === "queued" || status === "running",
    connectionStatus:
      status === "done"
        ? "CONNECTED"
        : status === "failed"
          ? "FAILED"
          : "CONNECTING",
    login: job.login || "",
    server: job.server || "",
    company: job.company || "",
    platform: job.platform || "MT5",
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null,
    error: job.error || "",
    errorStatus: Number(job.errorStatus || 0) || null,
    session: job.session || null,
  };
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function readJsonPath(path) {
  if (!path) return null;
  if (!firebaseConfigured()) return null;
  try {
    const hit = await withTimeout(firebaseGet(toFirebasePath(path)), 2500, null);
    if (!hit || hit.missing || hit.raw == null) return null;
    let parsed = JSON.parse(String(hit.raw));
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
  const raw = JSON.stringify({ __raw: JSON.stringify(value) });
  if (firebaseConfigured()) {
    const put = await withTimeout(
      firebasePut(toFirebasePath(path), raw),
      2500,
      { ok: false, reason: "firebase-timeout" }
    );
    if (put?.ok) return put;
  }
  return { ok: false, reason: "firebase-unavailable" };
}

export async function saveConnectJob(
  job,
  { durable = true, awaitDurable = false } = {}
) {
  const id = safeId(job?.id);
  if (!id) throw new Error("job id required");
  const next = {
    ...job,
    id,
    // Never persist raw passwords.
    password: undefined,
    updatedAt: Date.now(),
  };
  memoryJobs.set(id, next);
  if (durable) {
    const write = writeJsonPath(jobPath(id), next).then((put) => {
      if (!put?.ok) {
        console.warn(
          "connectJob firebase write failed",
          put?.reason || "unknown"
        );
      }
      return put;
    });
    // Await final done/failed so other instances can poll the result.
    if (awaitDurable) await write;
    else void write;
  }
  return next;
}

export async function getConnectJob(jobId, { preferRemote = false } = {}) {
  const id = safeId(jobId);
  if (!id) return null;
  const local = memoryJobs.has(id) ? memoryJobs.get(id) : null;
  // Always refresh from Firebase when asked — parent isolate memory stays
  // "running" while the worker isolate writes done/failed.
  if (preferRemote || !local) {
    const remote = await readJsonPath(jobPath(id));
    if (remote && remote.id) {
      const remoteUpdated = Number(remote.updatedAt || remote.finishedAt || 0);
      const localUpdated = Number(local?.updatedAt || local?.finishedAt || 0);
      const remoteTerminal =
        remote.status === "done" || remote.status === "failed";
      const localTerminal = local?.status === "done" || local?.status === "failed";
      if (!local || remoteTerminal || remoteUpdated >= localUpdated || !localTerminal) {
        memoryJobs.set(id, remote);
        return remote;
      }
    }
  }
  if (local) return local;
  return null;
}

export async function updateConnectJob(jobId, patch = {}) {
  const prev = (await getConnectJob(jobId)) || {};
  const id = safeId(jobId || prev.id);
  if (!id) throw new Error("job id required");
  const status = String(patch.status || prev.status || "");
  const awaitDurable = status === "done" || status === "failed";
  return saveConnectJob(
    {
      ...prev,
      ...patch,
      id,
      password: undefined,
    },
    { durable: true, awaitDurable }
  );
}
