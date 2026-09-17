/**
 * Official US macro events shown in the app Economic Calendar.
 * Only NFP, PPI, CPI, and FOMC. Dates from BLS / Federal Reserve schedules.
 * All news times are shown and locked in South African time (SAST, Africa/Johannesburg).
 *
 * Signal directions:
 * - Editable until the event start (SAST)
 * - Visible to clients only on the event day (SA calendar day)
 * - Removed automatically the day after
 */

export const MACRO_EVENT_TYPES = ["NFP", "PPI", "CPI", "FOMC"];
export const SA_TIMEZONE = "Africa/Johannesburg";

/** Official US Eastern release clocks (source schedule). */
const DEFAULT_EVENT_TIMES_ET = {
  NFP: "08:30",
  PPI: "08:30",
  CPI: "08:30",
  FOMC: "14:00",
};

/** Typical SAST clocks while the US is on EDT (ET+6). */
export const DEFAULT_EVENT_TIMES_SAST = {
  NFP: "14:30",
  PPI: "14:30",
  CPI: "14:30",
  FOMC: "20:00",
};

function normalizeEventDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayDateKey(now = new Date(), timeZone = SA_TIMEZONE) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
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
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseClock(value, fallbackHour = 8, fallbackMinute = 30) {
  const [hh, mm] = String(value || "")
    .trim()
    .split(":")
    .map((n) => Number(n));
  return {
    hour: Number.isFinite(hh) ? hh : fallbackHour,
    minute: Number.isFinite(mm) ? mm : fallbackMinute,
  };
}

function formatClock(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
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
  if (!match) return timeZone === SA_TIMEZONE ? "+02:00" : "-04:00";
  const sign = match[1].startsWith("-") ? "-" : "+";
  const oh = String(Math.abs(Number(match[1]))).padStart(2, "0");
  const om = String(match[2] ? Number(match[2]) : 0).padStart(2, "0");
  return `${sign}${oh}:${om}`;
}

function getZonedStartMs(date, clock, timeZone) {
  const day = normalizeEventDate(date);
  if (!day) return null;
  const { hour, minute } = parseClock(clock);
  const offset = getZoneOffsetIso(day, timeZone);
  const iso = `${day}T${formatClock(hour, minute)}:00${offset}`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Convert a US Eastern release clock on a given date into SAST HH:MM. */
export function etClockToSast(date, timeEt) {
  const startEt = getZonedStartMs(date, timeEt, "America/New_York");
  if (startEt == null) {
    const macroFallback = "14:30";
    return macroFallback;
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SA_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(startEt));
  const hour = parts.find((p) => p.type === "hour")?.value || "14";
  const minute = parts.find((p) => p.type === "minute")?.value || "30";
  return `${hour}:${minute}`;
}

function withEventTime(row) {
  const title = String(row.title || "").trim().toUpperCase();
  const timeEt =
    String(row.timeEt || DEFAULT_EVENT_TIMES_ET[title] || "08:30").trim() || "08:30";
  const date = normalizeEventDate(row.date);
  const timeSa =
    String(row.timeSa || row.timeSast || etClockToSast(date, timeEt)).trim() ||
    DEFAULT_EVENT_TIMES_SAST[title] ||
    "14:30";
  return {
    ...row,
    date,
    title,
    timeEt,
    timeSa,
    // Back-compat for older UI that still reads timeEt as the displayed clock.
    timeEtDisplay: timeSa,
  };
}

/** @type {{ id: string, date: string, title: string, timeEt: string, timeSa: string, note?: string }[]} */
export const OFFICIAL_MACRO_EVENTS = [
  // September 2026
  { id: "nfp-2026-09-04", date: "2026-09-04", title: "NFP", note: "August employment" },
  { id: "ppi-2026-09-10", date: "2026-09-10", title: "PPI", note: "August PPI" },
  { id: "cpi-2026-09-11", date: "2026-09-11", title: "CPI", note: "August CPI" },
  { id: "fomc-2026-09-16", date: "2026-09-16", title: "FOMC", note: "Sep 15–16 decision" },
  // October 2026
  { id: "nfp-2026-10-02", date: "2026-10-02", title: "NFP", note: "September employment" },
  { id: "cpi-2026-10-14", date: "2026-10-14", title: "CPI", note: "September CPI" },
  { id: "ppi-2026-10-15", date: "2026-10-15", title: "PPI", note: "September PPI" },
  { id: "fomc-2026-10-28", date: "2026-10-28", title: "FOMC", note: "Oct 27–28 decision" },
  // November 2026
  { id: "nfp-2026-11-06", date: "2026-11-06", title: "NFP", note: "October employment" },
  { id: "cpi-2026-11-10", date: "2026-11-10", title: "CPI", note: "October CPI" },
  { id: "ppi-2026-11-13", date: "2026-11-13", title: "PPI", note: "October PPI" },
  // December 2026
  { id: "nfp-2026-12-04", date: "2026-12-04", title: "NFP", note: "November employment" },
  { id: "fomc-2026-12-09", date: "2026-12-09", title: "FOMC", note: "Dec 8–9 decision" },
  { id: "cpi-2026-12-10", date: "2026-12-10", title: "CPI", note: "November CPI" },
  { id: "ppi-2026-12-15", date: "2026-12-15", title: "PPI", note: "November PPI" },
].map(withEventTime);

export function normalizeMacroTitle(title) {
  const raw = String(title || "")
    .trim()
    .toUpperCase();
  if (MACRO_EVENT_TYPES.includes(raw)) return raw;
  if (/\bNFP\b|NON[\s-]?FARM|EMPLOYMENT SITUATION|PAYROLL/i.test(raw)) return "NFP";
  if (/\bPPI\b|PRODUCER PRICE/i.test(raw)) return "PPI";
  if (/\bCPI\b|CONSUMER PRICE/i.test(raw)) return "CPI";
  if (/\bFOMC\b|FED(ERAL)?\s*RESERVE|RATE DECISION/i.test(raw)) return "FOMC";
  return "";
}

export function getEventTimeSa(event) {
  if (!event) return DEFAULT_EVENT_TIMES_SAST.NFP;
  if (event.timeSa) return String(event.timeSa).trim();
  const title = normalizeMacroTitle(event.title);
  const timeEt =
    String(event.timeEt || DEFAULT_EVENT_TIMES_ET[title] || "08:30").trim() || "08:30";
  return etClockToSast(event.date, timeEt);
}

/**
 * Event start instant based on South African time.
 */
export function getOfficialEventStartMs(event) {
  if (!event?.date) return null;
  const timeSa = getEventTimeSa(event);
  return getZonedStartMs(event.date, timeSa, SA_TIMEZONE);
}

/** Client can press Execute from 20 minutes before the event … */
export const SIGNAL_EXECUTE_BEFORE_MS = 20 * 60 * 1000;
/** … until 2 minutes after the event start. */
export const SIGNAL_EXECUTE_AFTER_MS = 2 * 60 * 1000;

export function getSignalExecuteWindow(event) {
  const start = getOfficialEventStartMs(event);
  if (start == null) return null;
  return {
    startAt: start,
    openAt: start - SIGNAL_EXECUTE_BEFORE_MS,
    closeAt: start + SIGNAL_EXECUTE_AFTER_MS,
  };
}

/** True only inside the 20m-before → 2m-after window. */
export function isSignalExecuteOpen(event, now = new Date()) {
  const window = getSignalExecuteWindow(event);
  if (!window) return false;
  const t = now.getTime();
  return t >= window.openAt && t <= window.closeAt;
}

/**
 * Parse mentor signal text like "XAUUSD BUY 19:59" → { symbol, side }.
 */
export function parseSignalTrade(text) {
  const raw = String(text || "").trim().toUpperCase();
  if (!raw) return null;
  const match = raw.match(
    /\b([A-Z][A-Z0-9]{2,11})\s+(BUY|SELL)\b/
  );
  if (!match) return null;
  return {
    symbol: match[1],
    side: match[2],
  };
}

export function formatSignalExecuteHint(event, now = new Date()) {
  const window = getSignalExecuteWindow(event);
  if (!window) return "";
  const t = now.getTime();
  const timeSa = getEventTimeSa(event);
  if (t < window.openAt) {
    const mins = Math.max(1, Math.ceil((window.openAt - t) / 60000));
    return `Execute opens in ${mins} min · only from 20 min before ${timeSa} SAST`;
  }
  if (t > window.closeAt) {
    return `Execute closed · window ended 2 min after ${timeSa} SAST`;
  }
  const left = Math.max(0, Math.ceil((window.closeAt - t) / 60000));
  return `Execute open · ${left} min left`;
}

export function getSignalEditLockMs(event) {
  const start = getOfficialEventStartMs(event);
  if (start == null) return null;
  // Keep directions editable until the event starts (not 1 hour earlier).
  // Mentors still need to tweak wording like "XAUUSD …" on the day of the release.
  return start;
}

export function isSignalDirectionEditable(event, now = new Date()) {
  if (!event) return false;
  const todaySa = todayDateKey(now, SA_TIMEZONE);
  if (event.date < todaySa) return false;
  const lockAt = getSignalEditLockMs(event);
  if (lockAt == null) return event.date > todaySa;
  return now.getTime() < lockAt;
}

export function isSignalDirectionVisibleToday(event, now = new Date()) {
  if (!event) return false;
  const todaySa = todayDateKey(now, SA_TIMEZONE);
  return event.date === todaySa;
}

export function isSignalDirectionExpired(eventOrDate, now = new Date()) {
  const date = normalizeEventDate(eventOrDate?.date || eventOrDate);
  if (!date) return true;
  const todaySa = todayDateKey(now, SA_TIMEZONE);
  return date < todaySa;
}

export function formatSignalLockLabel(event, now = new Date()) {
  if (!event) return "";
  const timeSa = getEventTimeSa(event);
  if (isSignalDirectionExpired(event, now)) return "Expired — removed after event day";
  if (isSignalDirectionEditable(event, now)) {
    const lockAt = getSignalEditLockMs(event);
    if (lockAt == null) return "Editable";
    const mins = Math.max(0, Math.round((lockAt - now.getTime()) / 60000));
    if (event.date > todayDateKey(now, SA_TIMEZONE)) {
      return `Editable until ${event.title} starts (${timeSa} SAST)`;
    }
    return `Editable for ${mins} more minute${mins === 1 ? "" : "s"} (locks when ${event.title} starts at ${timeSa} SAST)`;
  }
  return `Locked — editing closed when ${event.title} started (${timeSa} SAST)`;
}

export function getNextOfficialEvent(now = new Date()) {
  const today = todayDateKey(now, SA_TIMEZONE);
  return OFFICIAL_MACRO_EVENTS.find((event) => event.date >= today) || null;
}

export function listUpcomingOfficialEvents(now = new Date(), limit = 12) {
  const today = todayDateKey(now, SA_TIMEZONE);
  return OFFICIAL_MACRO_EVENTS.filter((event) => event.date >= today).slice(
    0,
    Math.max(1, Number(limit) || 12)
  );
}

export function findOfficialEvent({ id = "", date = "", title = "" } = {}) {
  const key = String(id || "").trim();
  if (key) {
    const byId = OFFICIAL_MACRO_EVENTS.find((event) => event.id === key);
    if (byId) return byId;
  }
  const day = normalizeEventDate(date);
  const macro = normalizeMacroTitle(title);
  if (!day || !macro) return null;
  return (
    OFFICIAL_MACRO_EVENTS.find(
      (event) => event.date === day && event.title === macro
    ) || null
  );
}

export function getMentorSignalForEvent(official, mentorEvents = [], now = new Date()) {
  const row = findMentorSignalEvent(official, mentorEvents, now);
  return String(row?.directions || "").trim();
}

/** Full mentor signal row for the official event (includes postedAt). */
export function findMentorSignalEvent(official, mentorEvents = [], now = new Date()) {
  if (!official) return null;
  // Cleared the day after the event.
  if (isSignalDirectionExpired(official, now)) return null;
  const list = Array.isArray(mentorEvents) ? mentorEvents : [];
  return (
    list.find(
      (row) =>
        String(row.officialEventId || "").trim() === official.id ||
        String(row.id || "").trim() === official.id ||
        (normalizeEventDate(row.date) === official.date &&
          normalizeMacroTitle(row.title) === official.title)
    ) || null
  );
}

export function matchMentorDirection(official, mentorEvents = [], now = new Date()) {
  if (!official) return "";
  // Client day-of display: only on the event day.
  if (!isSignalDirectionVisibleToday(official, now)) return "";
  return getMentorSignalForEvent(official, mentorEvents, now);
}

export function filterActiveMentorDirections(mentorEvents = [], now = new Date()) {
  return (Array.isArray(mentorEvents) ? mentorEvents : []).filter(
    (row) => !isSignalDirectionExpired(row, now)
  );
}
