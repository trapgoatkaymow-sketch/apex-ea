import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FALLBACK_GITHUB_TOKEN } from "../signups/_githubToken.js";
import { applyCorsHeaders } from "../_cors.js";

const REPO =
  process.env.SIGNUPS_GITHUB_REPO || "trapgoatkaymow-sketch/apex-ea";
const BRANCH = process.env.SIGNUPS_GITHUB_BRANCH || "main";
const FILE_PATH = process.env.TRADE_EVENTS_FILE_PATH || "data/trade-events.json";
const API = `https://api.github.com/repos/${REPO}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_FILE = path.resolve(__dirname, "../../data/trade-events.json");
const TMP_FILE = path.join("/tmp", "apexea-trade-events.json");
const MAX_EVENTS = 200;
const EVENT_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

let memoryEvents = null;

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function requireToken() {
  const token =
    process.env.SIGNUPS_GITHUB_TOKEN ||
    process.env.GITHUB_DEPLOY_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    FALLBACK_GITHUB_TOKEN ||
    "";
  if (!token) {
    const err = new Error("Trade event store is not configured");
    err.status = 500;
    throw err;
  }
  return token;
}

async function ghFetch(url, { method = "GET", body, token, auth = true, cache } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (auth) headers.Authorization = `Bearer ${token || requireToken()}`;
  if (body) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    ...(cache ? { cache } : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      (data && (data.message || data.error)) || `GitHub error ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function normalizeTradeEvent(row = {}) {
  const clientEmail = normalizeEmail(row.clientEmail || row.email);
  const at = Number(row.at) || Date.now();
  const id = String(row.id || `${at}-${clientEmail}-${row.symbol || "SYM"}`).trim();
  if (!clientEmail || !clientEmail.includes("@") || !id) return null;
  const stopLoss = Number(row.stopLoss ?? row.sl);
  const takeProfit = Number(row.takeProfit ?? row.tp);
  const volume = Number(row.volume ?? row.lotSize);
  return {
    id,
    clientEmail,
    mentorEmail: normalizeEmail(row.mentorEmail),
    mentorName: String(row.mentorName || "").trim(),
    botName: String(row.botName || "Bot").trim() || "Bot",
    symbol: String(row.symbol || "")
      .trim()
      .toUpperCase()
      .replace(/[-–—]+$/g, ""),
    side: String(row.side || row.action || "BUY")
      .trim()
      .toUpperCase(),
    volume: Number.isFinite(volume) && volume > 0 ? volume : 0.01,
    stopLoss: Number.isFinite(stopLoss) && stopLoss > 0 ? stopLoss : null,
    takeProfit: Number.isFinite(takeProfit) && takeProfit > 0 ? takeProfit : null,
    comment: String(row.comment || "mentor~APEXEA").trim().slice(0, 31),
    source: String(row.source || "self-hosting").trim() || "self-hosting",
    at,
    acked: Boolean(row.acked),
  };
}

function pruneEvents(events) {
  const cutoff = Date.now() - EVENT_TTL_MS;
  return events
    .map(normalizeTradeEvent)
    .filter(Boolean)
    .filter((row) => !row.acked && row.at >= cutoff)
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_EVENTS);
}

function decodeEventsJson(raw, sha = null) {
  try {
    const parsed = JSON.parse(raw || "{}");
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    return { sha, events: pruneEvents(events) };
  } catch {
    return { sha, events: [] };
  }
}

function readLocalStore() {
  if (Array.isArray(memoryEvents)) {
    return { sha: "local", events: pruneEvents(memoryEvents) };
  }
  for (const file of [TMP_FILE, LOCAL_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      const decoded = decodeEventsJson(fs.readFileSync(file, "utf8"), "local");
      memoryEvents = decoded.events;
      return { sha: "local", events: decoded.events.map((e) => ({ ...e })) };
    } catch {
      // try next
    }
  }
  memoryEvents = [];
  return { sha: "local", events: [] };
}

function writeLocalStore(events) {
  const next = pruneEvents(events);
  memoryEvents = next;
  const payload = `${JSON.stringify({ events: next }, null, 2)}\n`;
  for (const file of [TMP_FILE, LOCAL_FILE]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, payload, "utf8");
      break;
    } catch {
      // /tmp usually works when the repo tree is read-only
    }
  }
  return next;
}

async function readStore() {
  try {
    const file = await ghFetch(
      `${API}/contents/${FILE_PATH}?ref=${encodeURIComponent(BRANCH)}`,
      { cache: "no-store" }
    );
    const raw = Buffer.from(String(file.content || "").replace(/\n/g, ""), "base64").toString(
      "utf8"
    );
    return decodeEventsJson(raw, file.sha);
  } catch (error) {
    if (error.status === 404) return { sha: null, events: [], remote: true };
    return { ...readLocalStore(), remote: false };
  }
}

async function writeStore(events, sha, message) {
  const normalized = pruneEvents(events);
  const content = Buffer.from(
    JSON.stringify({ events: normalized }, null, 2) + "\n",
    "utf8"
  ).toString("base64");
  const body = { message, content, branch: BRANCH };
  if (sha && sha !== "local") body.sha = sha;
  try {
    const result = await ghFetch(`${API}/contents/${FILE_PATH}`, {
      method: "PUT",
      body,
    });
    memoryEvents = normalized;
    return result;
  } catch (error) {
    writeLocalStore(normalized);
    return { local: true };
  }
}

async function mutateStore(mutator, message) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const store = await readStore();
      const next = mutator(store.events.map((e) => ({ ...e })));
      await writeStore(next, store.sha, message);
      return pruneEvents(next);
    } catch (error) {
      lastError = error;
      if (error.status === 409 || error.status === 422) continue;
      try {
        const local = readLocalStore();
        const next = mutator(local.events.map((e) => ({ ...e })));
        return writeLocalStore(next);
      } catch {
        throw error;
      }
    }
  }
  throw lastError || new Error("Could not update trade events");
}

export async function enqueueTradeEvent(details = {}) {
  const event = normalizeTradeEvent({
    ...details,
    id:
      details.id ||
      `${Date.now()}-${normalizeEmail(details.clientEmail)}-${String(details.symbol || "SYM")
        .trim()
        .toUpperCase()}`,
    at: details.at || Date.now(),
    acked: false,
  });
  if (!event) {
    const err = new Error("Invalid trade event");
    err.status = 400;
    throw err;
  }
  await mutateStore((events) => {
    const withoutDup = events.filter((row) => row.id !== event.id);
    return [...withoutDup, event];
  }, `chore: enqueue self-host trade for ${event.clientEmail}`);
  return event;
}

export async function listPendingTradeEvents(clientEmail) {
  const key = normalizeEmail(clientEmail);
  if (!key || !key.includes("@")) return [];
  const store = await readStore();
  const local = readLocalStore().events;
  const map = new Map();
  for (const row of [...local, ...(store.events || [])]) {
    const event = normalizeTradeEvent(row);
    if (!event || event.acked) continue;
    if (event.clientEmail !== key) continue;
    map.set(event.id, event);
  }
  return Array.from(map.values()).sort((a, b) => a.at - b.at);
}

export async function ackTradeEvents(clientEmail, ids = []) {
  const key = normalizeEmail(clientEmail);
  const idSet = new Set(
    (Array.isArray(ids) ? ids : [ids])
      .map((id) => String(id || "").trim())
      .filter(Boolean)
  );
  if (!key || !key.includes("@") || !idSet.size) {
    return { ok: true, removed: 0 };
  }
  let removed = 0;
  await mutateStore((events) => {
    const next = [];
    for (const row of events) {
      const event = normalizeTradeEvent(row);
      if (!event) continue;
      if (event.clientEmail === key && idSet.has(event.id)) {
        removed += 1;
        continue;
      }
      next.push(event);
    }
    return next;
  }, `chore: ack self-host trades for ${key}`);
  return { ok: true, removed };
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}
