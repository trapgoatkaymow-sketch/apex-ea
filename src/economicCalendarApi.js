import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/calendar";
const LOCAL_KEY = "apexea-economic-calendar-v1";

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
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

export function todayDateKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatEventDay(dateKey) {
  const key = normalizeEventDate(dateKey);
  if (!key) return "TBD";
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** When the mentor posted/updated the signal direction (SAST clock). */
export function formatSignalPostedAt(value, now = new Date()) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Johannesburg",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
    const day = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Johannesburg",
      day: "numeric",
      month: "short",
    }).format(date);
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Johannesburg",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    const postedKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Johannesburg",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    if (todayKey === postedKey) return `${time} SAST`;
    return `${time} · ${day}`;
  } catch {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}

function publicEvent(row = {}) {
  const id = String(row.id || "").trim();
  const date = normalizeEventDate(row.date || row.eventDate);
  const mentorEmail = normalizeEmail(row.mentorEmail);
  if (!id || !date || !mentorEmail) return null;
  const createdAt = Number(row.createdAt) || Date.now();
  const updatedAt = Number(row.updatedAt) || createdAt;
  const postedAt =
    Number(row.postedAt) ||
    (String(row.directions || "").trim() ? updatedAt || createdAt : 0) ||
    0;
  return {
    id,
    officialEventId: String(row.officialEventId || id || "").trim(),
    date,
    title: String(row.title || "").trim() || "Economic event",
    directions: String(row.directions || "").trim(),
    mentorEmail,
    createdAt,
    updatedAt,
    postedAt: postedAt || null,
  };
}

function readLocalEvents() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed?.events)
      ? parsed.events.map(publicEvent).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function writeLocalEvents(events) {
  localStorage.setItem(
    LOCAL_KEY,
    JSON.stringify({ events: events.map(publicEvent).filter(Boolean) })
  );
}

function mergeEvents(localList = [], remoteList = []) {
  const map = new Map();
  for (const item of [...localList, ...remoteList]) {
    const event = publicEvent(item);
    if (!event) continue;
    const prev = map.get(event.id);
    if (!prev || Number(event.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
      map.set(event.id, event);
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => String(a.date).localeCompare(String(b.date)) || a.createdAt - b.createdAt
  );
}

async function apiFetch(path = "", { method = "GET", body } = {}) {
  const response = await fetch(`${apiUrl(API_PATH)}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
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
      (data && (data.error || data.message)) ||
      (typeof data === "string" ? data : `Calendar sync failed (${response.status})`);
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

export async function fetchEconomicEvents(mentorEmail = "") {
  const key = normalizeEmail(mentorEmail);
  const today = todayDateKey();
  const local = readLocalEvents()
    .filter((e) => !key || e.mentorEmail === key)
    .filter((e) => e.date >= today);
  try {
    const query = key ? `?mentorEmail=${encodeURIComponent(key)}` : "";
    const data = await apiFetch(query);
    const remote = Array.isArray(data?.events) ? data.events : [];
    const merged = mergeEvents(local, remote).filter((e) => e.date >= today);
    writeLocalEvents(mergeEvents(readLocalEvents(), remote).filter((e) => e.date >= today));
    return key ? merged.filter((e) => e.mentorEmail === key) : merged;
  } catch {
    return local;
  }
}

/**
 * Load directions for one or more mentors linked to this device.
 * Fetches the shared calendar once, then keeps rows for any candidate mentor.
 * If no mentor emails are known yet, returns all upcoming rows so a posted
 * direction still appears instead of a false "nothing yet" empty state.
 */
export async function fetchEconomicEventsForMentors(mentorEmails = []) {
  const keys = [
    ...new Set(
      (Array.isArray(mentorEmails) ? mentorEmails : [mentorEmails])
        .map((email) => normalizeEmail(email))
        .filter((email) => email.includes("@"))
    ),
  ];
  const all = await fetchEconomicEvents("");
  if (!keys.length) return all;
  const mine = all.filter((event) => keys.includes(event.mentorEmail));
  // If linked mentors have no row yet, don't hide a direction that was saved
  // under the official event id (legacy single-id store).
  if (mine.length) return mine;
  return all;
}

export async function saveEconomicEvent(payload = {}) {
  const event = publicEvent({
    ...payload,
    id: payload.id || `local-${Date.now()}`,
    updatedAt: Date.now(),
  });
  if (!event) throw new Error("Enter a valid event date and mentor email");

  try {
    const data = await apiFetch("", {
      method: "POST",
      body: { action: "upsert", ...event },
    });
    const saved = publicEvent(data?.event || event);
    writeLocalEvents(mergeEvents(readLocalEvents(), [saved]));
    return saved;
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 401 && error.status !== 403) {
      throw error;
    }
    writeLocalEvents(mergeEvents(readLocalEvents(), [event]));
    return event;
  }
}

export async function removeEconomicEvent(id, mentorEmail = "") {
  const key = String(id || "").trim();
  if (!key) throw new Error("Event id is required");
  try {
    await apiFetch("", {
      method: "POST",
      body: { action: "delete", id: key, mentorEmail },
    });
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 401 && error.status !== 403) {
      throw error;
    }
  }
  writeLocalEvents(readLocalEvents().filter((e) => e.id !== key));
  return true;
}

export function getNextEvent(events = [], now = new Date()) {
  const today = todayDateKey(now);
  const upcoming = (Array.isArray(events) ? events : [])
    .map(publicEvent)
    .filter(Boolean)
    .filter((e) => e.date >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return upcoming[0] || null;
}

export function getEventsOnDate(events = [], dateKey = todayDateKey()) {
  const key = normalizeEventDate(dateKey);
  return (Array.isArray(events) ? events : [])
    .map(publicEvent)
    .filter(Boolean)
    .filter((e) => e.date === key);
}
