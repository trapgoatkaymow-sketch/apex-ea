import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FALLBACK_GITHUB_TOKEN } from "../signups/_githubToken.js";
import { applyCorsHeaders } from "../_cors.js";

const REPO =
  process.env.SIGNUPS_GITHUB_REPO || "trapgoatkaymow-sketch/apex-ea";
const BRANCH = process.env.SIGNUPS_GITHUB_BRANCH || "main";
const FILE_PATH =
  process.env.ECONOMIC_CALENDAR_FILE_PATH || "data/economic-calendar.json";
const API = `https://api.github.com/repos/${REPO}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_FILE = path.resolve(__dirname, "../../data/economic-calendar.json");
const TMP_FILE = path.join("/tmp", "apexea-economic-calendar.json");

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
    const err = new Error("Economic calendar store is not configured");
    err.status = 500;
    throw err;
  }
  return token;
}

function tokenCandidates() {
  return [
    ...new Set(
      [
        process.env.SIGNUPS_GITHUB_TOKEN,
        process.env.GITHUB_TOKEN,
        process.env.GH_TOKEN,
        FALLBACK_GITHUB_TOKEN,
      ].filter(Boolean)
    ),
  ];
}

async function ghFetch(url, { method = "GET", body, token, auth = true, cache } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (body) headers["Content-Type"] = "application/json";

  const tokens = auth ? (token ? [token] : tokenCandidates()) : [null];
  if (auth && tokens.length === 0) {
    const err = new Error("Economic calendar store is not configured");
    err.status = 500;
    throw err;
  }

  let lastError = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const active = tokens[i];
    const requestHeaders = { ...headers };
    if (auth && active) requestHeaders.Authorization = `Bearer ${active}`;

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
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
    if (response.ok) return data;

    const message =
      (data && (data.message || data.error)) || `GitHub error ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    lastError = err;

    const retryable =
      auth &&
      i < tokens.length - 1 &&
      (response.status === 401 ||
        response.status === 403 ||
        /bad credentials/i.test(message));
    if (!retryable) throw err;
  }
  throw lastError || new Error("GitHub request failed");
}

export function normalizeEventDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayDateKeySa(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Johannesburg",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // fall through
  }
  return normalizeEventDate(now.toISOString().slice(0, 10));
}

const DEFAULT_EVENT_TIMES_ET = {
  NFP: "08:30",
  PPI: "08:30",
  CPI: "08:30",
  FOMC: "14:00",
};

const DEFAULT_EVENT_TIMES_SAST = {
  NFP: "14:30",
  PPI: "14:30",
  CPI: "14:30",
  FOMC: "20:00",
};

function normalizeMacroTitle(title) {
  const raw = String(title || "")
    .trim()
    .toUpperCase();
  if (DEFAULT_EVENT_TIMES_ET[raw]) return raw;
  if (/\bNFP\b|NON[\s-]?FARM|PAYROLL/i.test(raw)) return "NFP";
  if (/\bPPI\b|PRODUCER PRICE/i.test(raw)) return "PPI";
  if (/\bCPI\b|CONSUMER PRICE/i.test(raw)) return "CPI";
  if (/\bFOMC\b|FED(ERAL)?\s*RESERVE|RATE DECISION/i.test(raw)) return "FOMC";
  return raw;
}

function getZoneOffsetIso(date, timeZone) {
  const probe = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(probe);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+2";
  const match = tzName.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return timeZone === "Africa/Johannesburg" ? "+02:00" : "-04:00";
  const sign = match[1].startsWith("-") ? "-" : "+";
  const oh = String(Math.abs(Number(match[1]))).padStart(2, "0");
  const om = String(match[2] ? Number(match[2]) : 0).padStart(2, "0");
  return `${sign}${oh}:${om}`;
}

function etClockToSast(date, timeEt) {
  const day = normalizeEventDate(date);
  const [hh, mm] = String(timeEt || "08:30")
    .split(":")
    .map((n) => Number(n));
  const hour = Number.isFinite(hh) ? hh : 8;
  const minute = Number.isFinite(mm) ? mm : 30;
  const etOffset = getZoneOffsetIso(day, "America/New_York");
  const iso = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${etOffset}`;
  const startEt = Date.parse(iso);
  if (!Number.isFinite(startEt)) return DEFAULT_EVENT_TIMES_SAST.NFP;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Johannesburg",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(startEt));
  const h = parts.find((p) => p.type === "hour")?.value || "14";
  const m = parts.find((p) => p.type === "minute")?.value || "30";
  return `${h}:${m}`;
}

function resolveTimeSa({ date, title, timeSa, timeEt }) {
  if (timeSa) return String(timeSa).trim();
  const macro = normalizeMacroTitle(title);
  const et = String(timeEt || DEFAULT_EVENT_TIMES_ET[macro] || "08:30").trim() || "08:30";
  return etClockToSast(date, et) || DEFAULT_EVENT_TIMES_SAST[macro] || "14:30";
}

function getEventStartMs(date, title, timeSa, timeEt) {
  const day = normalizeEventDate(date);
  if (!day) return null;
  const clock = resolveTimeSa({ date: day, title, timeSa, timeEt });
  const [hh, mm] = clock.split(":").map((n) => Number(n));
  const hour = Number.isFinite(hh) ? hh : 14;
  const minute = Number.isFinite(mm) ? mm : 30;
  const offset = getZoneOffsetIso(day, "Africa/Johannesburg");
  const iso = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function getEditLockState({ date, title, timeSa, timeEt }, now = new Date()) {
  const day = normalizeEventDate(date);
  const today = todayDateKeySa(now);
  if (!day) return { editable: false, message: "Enter a valid event date" };
  if (day < today) {
    return {
      editable: false,
      message: "Signal direction expired — it removes itself the day after the event",
    };
  }
  const start = getEventStartMs(day, title, timeSa, timeEt);
  if (start == null) return { editable: true, message: "" };
  // Match client: editable until the event starts (SAST).
  const lockAt = start;
  if (now.getTime() >= lockAt) {
    const macro = normalizeMacroTitle(title) || "event";
    const clock = resolveTimeSa({ date: day, title, timeSa, timeEt });
    return {
      editable: false,
      message: `Editing locked — ${macro} already started (${clock} SAST)`,
    };
  }
  return { editable: true, message: "" };
}

export function publicEvent(row = {}) {
  const id = String(row.id || "").trim();
  const date = normalizeEventDate(row.date || row.eventDate);
  const mentorEmail = normalizeEmail(row.mentorEmail);
  if (!id || !date || !mentorEmail) return null;
  return {
    id,
    officialEventId: String(row.officialEventId || id || "").trim(),
    date,
    title: String(row.title || "").trim() || "Economic event",
    directions: String(row.directions || "").trim(),
    mentorEmail,
    createdAt: Number(row.createdAt) || Date.now(),
    updatedAt: Number(row.updatedAt) || Number(row.createdAt) || Date.now(),
  };
}

function decodeEventsJson(raw, sha = null) {
  try {
    const parsed = JSON.parse(raw || "{}");
    const events = Array.isArray(parsed?.events)
      ? parsed.events.map(publicEvent).filter(Boolean)
      : [];
    return { sha, events };
  } catch {
    return { sha, events: [] };
  }
}

function readLocalStore() {
  if (Array.isArray(memoryEvents)) {
    return { sha: "local", events: memoryEvents.map((e) => ({ ...e })) };
  }
  for (const file of [TMP_FILE, LOCAL_FILE]) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf8");
        const decoded = decodeEventsJson(raw, "local");
        memoryEvents = decoded.events;
        return { sha: "local", events: decoded.events.map((e) => ({ ...e })) };
      }
    } catch {
      // try next
    }
  }
  memoryEvents = [];
  return { sha: "local", events: [] };
}

function writeLocalStore(events) {
  const next = events.map((e) => ({ ...e })).filter(Boolean);
  memoryEvents = next;
  const payload = JSON.stringify({ events: next }, null, 2) + "\n";
  try {
    fs.mkdirSync(path.dirname(TMP_FILE), { recursive: true });
    fs.writeFileSync(TMP_FILE, payload, "utf8");
  } catch {
    // ignore
  }
  try {
    fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_FILE, payload, "utf8");
  } catch {
    // memory still holds data
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
    const decoded = decodeEventsJson(raw, file.sha);
    if (Array.isArray(memoryEvents) && memoryEvents.length) {
      const byId = new Map(decoded.events.map((e) => [e.id, e]));
      for (const local of memoryEvents) {
        const remote = byId.get(local.id);
        if (!remote || Number(local.updatedAt || 0) >= Number(remote.updatedAt || 0)) {
          byId.set(local.id, local);
        }
      }
      decoded.events = Array.from(byId.values());
    }
    return decoded;
  } catch (error) {
    if (error.status === 404) {
      return { sha: null, events: [], remote: true };
    }
    return { ...readLocalStore(), remote: false };
  }
}

async function writeStore(events, sha, message) {
  const normalized = events
    .map(publicEvent)
    .filter(Boolean)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.createdAt - b.createdAt);
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
    writeLocalStore(normalized);
    return result;
  } catch (error) {
    writeLocalStore(normalized);
    if (error.status === 401 || error.status === 403) {
      return { local: true };
    }
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
      return next.map(publicEvent).filter(Boolean);
    } catch (error) {
      lastError = error;
      if (error.status === 409 || error.status === 422) continue;
      try {
        const local = readLocalStore();
        const next = mutator(local.events.map((e) => ({ ...e })));
        return writeLocalStore(next.map(publicEvent).filter(Boolean));
      } catch {
        throw error;
      }
    }
  }
  throw lastError || new Error("Could not update economic calendar");
}

export async function listEvents({ mentorEmail = "" } = {}) {
  const store = await readStore();
  const key = normalizeEmail(mentorEmail);
  const today = todayDateKeySa();
  let events = store.events
    .map(publicEvent)
    .filter(Boolean)
    // Signal directions remove themselves the day after the event.
    .filter((e) => e.date >= today);
  if (key) events = events.filter((e) => e.mentorEmail === key);

  // Persist purge when expired rows still sit in the store.
  const purged = store.events.map(publicEvent).filter(Boolean).filter((e) => e.date >= today);
  if (purged.length !== store.events.length) {
    try {
      await writeStore(purged, store.sha, "chore: purge expired economic calendar directions");
    } catch {
      writeLocalStore(purged);
    }
  }

  return events.sort(
    (a, b) => String(a.date).localeCompare(String(b.date)) || a.createdAt - b.createdAt
  );
}

export async function upsertEvent(input = {}) {
  const mentorEmail = normalizeEmail(input.mentorEmail);
  const date = normalizeEventDate(input.date || input.eventDate);
  const title = String(input.title || "").trim() || "Economic event";
  const directions = String(input.directions || "").trim();
  const officialEventId =
    String(input.officialEventId || "").trim() ||
    String(input.id || "").trim() ||
    `${normalizeMacroTitle(title).toLowerCase() || "event"}-${date}`;
  // Scope by mentor so one mentor cannot overwrite another's direction.
  const preferredId = `${mentorEmail}__${officialEventId}`;
  const requestedId = String(input.id || "").trim();

  if (!mentorEmail || !mentorEmail.includes("@")) {
    const err = new Error("Mentor email is required");
    err.status = 400;
    throw err;
  }
  if (!date) {
    const err = new Error("Enter a valid event date");
    err.status = 400;
    throw err;
  }

  const lock = getEditLockState({
    date,
    title,
    timeSa: input.timeSa,
    timeEt: input.timeEt,
  });
  if (!lock.editable) {
    const err = new Error(lock.message);
    err.status = 403;
    throw err;
  }

  let saved = null;
  await mutateStore((events) => {
    const today = todayDateKeySa();
    const kept = events.filter((e) => normalizeEventDate(e.date) >= today);
    const idx = kept.findIndex((e) => {
      if (normalizeEmail(e.mentorEmail) !== mentorEmail) return false;
      if (requestedId && e.id === requestedId) return true;
      if (e.id === preferredId) return true;
      if (String(e.officialEventId || "").trim() === officialEventId) return true;
      // Legacy rows used the bare official id.
      if (e.id === officialEventId) return true;
      return (
        normalizeEventDate(e.date) === date &&
        normalizeMacroTitle(e.title) === normalizeMacroTitle(title)
      );
    });
    const id = idx >= 0 ? kept[idx].id : preferredId;
    const row = {
      id,
      officialEventId,
      date,
      title,
      directions,
      mentorEmail,
      createdAt: idx >= 0 ? kept[idx].createdAt || Date.now() : Date.now(),
      updatedAt: Date.now(),
    };
    saved = row;
    if (idx >= 0) {
      kept[idx] = row;
      return kept;
    }
    return [row, ...kept];
  }, `chore: upsert economic event ${date} · ${mentorEmail}`);

  return publicEvent(saved);
}

export async function deleteEvent(id, mentorEmail = "") {
  const key = String(id || "").trim();
  const email = normalizeEmail(mentorEmail);
  if (!key) {
    const err = new Error("Event id is required");
    err.status = 400;
    throw err;
  }

  let removed = null;
  await mutateStore((events) => {
    const idx = events.findIndex((e) => {
      if (e.id !== key) return false;
      if (email && e.mentorEmail !== email) return false;
      return true;
    });
    if (idx < 0) {
      const err = new Error("Event not found");
      err.status = 404;
      throw err;
    }
    removed = events[idx];
    events.splice(idx, 1);
    return events;
  }, `chore: delete economic event ${key}`);

  return publicEvent(removed);
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

// silence unused in some bundlers
void requireToken;
