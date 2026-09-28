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
  // Always scope to one mentor — never pull the full cross-mentor feed.
  if (!key.includes("@")) return [];
  const today = todayDateKey();
  const local = readLocalEvents()
    .filter((e) => e.mentorEmail === key)
    .filter((e) => e.date >= today);
  try {
    const data = await apiFetch(`?mentorEmail=${encodeURIComponent(key)}`);
    const remote = (Array.isArray(data?.events) ? data.events : []).filter(
      (e) => normalizeEmail(e?.mentorEmail) === key
    );
    const merged = mergeEvents(local, remote).filter((e) => e.date >= today);
    // Keep other mentors' cached rows, but only refresh this mentor's slice.
    const others = readLocalEvents().filter(
      (e) => e.mentorEmail !== key && e.date >= today
    );
    writeLocalEvents([...others, ...merged]);
    return merged.filter((e) => e.mentorEmail === key);
  } catch {
    return local;
  }
}

/**
 * Load directions for the mentor(s) that own this client's EA.
 * Never returns other mentors' rows — a missing owner email means no signal,
 * not "show whoever posted NFP first".
 */
export async function fetchEconomicEventsForMentors(mentorEmails = []) {
  const keys = [
    ...new Set(
      (Array.isArray(mentorEmails) ? mentorEmails : [mentorEmails])
        .map((email) => normalizeEmail(email))
        .filter((email) => email.includes("@"))
    ),
  ];
  if (!keys.length) return [];
  // Fetch per-mentor so local cache merge cannot smear in another mentor's row.
  const lists = await Promise.all(keys.map((email) => fetchEconomicEvents(email)));
  const map = new Map();
  for (const list of lists) {
    for (const event of list || []) {
      if (!keys.includes(normalizeEmail(event?.mentorEmail))) continue;
      const prev = map.get(event.id);
      if (!prev || Number(event.updatedAt || 0) >= Number(prev.updatedAt || 0)) {
        map.set(event.id, event);
      }
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => String(a.date).localeCompare(String(b.date)) || a.createdAt - b.createdAt
  );
}

export async function saveEconomicEvent(payload = {}) {
  const mentorEmail = normalizeEmail(payload.mentorEmail);
  const officialEventId = String(
    payload.officialEventId || payload.id || ""
  ).trim();
  const scopedId =
    mentorEmail && officialEventId
      ? `${mentorEmail}__${officialEventId}`
      : payload.id || `local-${Date.now()}`;
  const event = publicEvent({
    ...payload,
    id: scopedId,
    officialEventId: officialEventId || scopedId,
    mentorEmail,
    updatedAt: Date.now(),
  });
  if (!event) throw new Error("Enter a valid event date and mentor email");
  const signalWriteToken = String(payload.signalWriteToken || "").trim();
  if (!signalWriteToken) {
    throw new Error("Sign in again to save signal directions");
  }

  try {
    const data = await apiFetch("", {
      method: "POST",
      body: {
        action: "upsert",
        ...event,
        signalWriteToken,
      },
    });
    const saved = publicEvent(data?.event || event);
    writeLocalEvents(mergeEvents(readLocalEvents(), [saved]));
    return saved;
  } catch (error) {
    // Auth / validation failures must not silently succeed via local cache.
    if (error.status === 401 || error.status === 403 || error.status === 400) {
      throw error;
    }
    if (error.status && error.status < 500) {
      throw error;
    }
    writeLocalEvents(mergeEvents(readLocalEvents(), [event]));
    return event;
  }
}

export async function removeEconomicEvent(
  id,
  mentorEmail = "",
  signalWriteToken = ""
) {
  const key = String(id || "").trim();
  if (!key) throw new Error("Event id is required");
  const token = String(signalWriteToken || "").trim();
  if (!token) {
    throw new Error("Sign in again to save signal directions");
  }
  try {
    await apiFetch("", {
      method: "POST",
      body: {
        action: "delete",
        id: key,
        mentorEmail,
        signalWriteToken: token,
      },
    });
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.status === 400) {
      throw error;
    }
    if (error.status && error.status < 500) {
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
