import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatEventDay, formatSignalPostedAt } from "./economicCalendarApi.js";
import {
  formatSignalExecuteHint,
  findMentorSignalEvent,
  getNextOfficialEvent,
  isSignalExecuteOpen,
  parseSignalTrade,
  SA_TIMEZONE,
} from "./economicCalendarSchedule.js";
import { buildBotTradeComment, placeTrade } from "./metaApi.js";
import { recordTrade } from "./dailyTradeHistory.js";
import { useApp } from "./store.jsx";

function todaySaDateKey(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: SA_TIMEZONE,
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

function normalizeMentorEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/**
 * Collect every mentor email tied to this phone/account.
 * Filtering the calendar by a single (often missing) email was hiding
 * directions mentors already posted on the portal.
 */
function collectMentorEmails({ activeBot, coverEmail, eas, licenseKeys }) {
  const emails = [];
  const seen = new Set();
  const add = (value) => {
    const email = normalizeMentorEmail(value);
    if (!email.includes("@") || seen.has(email)) return;
    seen.add(email);
    emails.push(email);
  };

  const account = normalizeMentorEmail(coverEmail);
  const botId = String(activeBot?.id || "").trim();
  const keys = Array.isArray(licenseKeys) ? licenseKeys : [];
  const eaList = Array.isArray(eas) ? eas : [];

  const forBot = botId
    ? keys
        .filter(
          (row) =>
            String(row.botId || "").trim() === botId ||
            String(row.bot?.id || "").trim() === botId
        )
        .sort(
          (a, b) =>
            Number(b.usedAt || b.updatedAt || 0) - Number(a.usedAt || a.updatedAt || 0)
        )
    : [];

  if (forBot.length) {
    add(forBot.find((row) => row?.used)?.mentorEmail);
    add(forBot[0]?.mentorEmail);
  }

  if (botId) {
    const ea = eaList.find((item) => String(item.id || "").trim() === botId);
    add(ea?.ownerEmail || ea?.mentorEmail);
  }

  if (account) {
    const used = keys
      .filter((row) => row?.used && normalizeMentorEmail(row.clientEmail) === account)
      .sort(
        (a, b) =>
          Number(b.usedAt || b.updatedAt || 0) - Number(a.usedAt || a.updatedAt || 0)
      );
    add(used[0]?.mentorEmail);

    const bound = keys
      .filter((row) => normalizeMentorEmail(row.clientEmail) === account)
      .sort(
        (a, b) =>
          Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)
      );
    add(bound[0]?.mentorEmail);
  }

  for (const ea of eaList) {
    add(ea?.ownerEmail || ea?.mentorEmail);
  }

  // Last resort: any mentor stamped on a license on this device.
  for (const row of keys) {
    add(row?.mentorEmail);
  }

  return emails;
}

function clampLot(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0.01;
  return Number(Math.min(1000, n).toFixed(4));
}

export default function EconomicCalendarButton({ variant = "zeta" }) {
  const {
    activeBot,
    coverEmail,
    eas,
    licenseKeys,
    mt5Session,
    getSymbolMeta,
    showToast,
    setZetaView,
    setV2View,
    publishOrbTrade,
    clearOrbTrade,
  } = useApp();
  const [open, setOpen] = useState(false);
  const [mentorEvents, setMentorEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const mentorEmails = useMemo(
    () => collectMentorEmails({ activeBot, coverEmail, eas, licenseKeys }),
    [activeBot, coverEmail, eas, licenseKeys]
  );

  // Tick often while the panel is open so the Execute window unlocks on time.
  useEffect(() => {
    const ms = open ? 5_000 : 60_000;
    const timer = setInterval(() => setNowTick(Date.now()), ms);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { fetchEconomicEventsForMentors } = await import("./economicCalendarApi.js");
        const list = await fetchEconomicEventsForMentors(mentorEmails);
        if (!cancelled) setMentorEvents(list);
      } catch {
        if (!cancelled) setMentorEvents([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mentorEmails]);

  const now = useMemo(() => new Date(nowTick), [nowTick]);
  const today = todaySaDateKey(now);
  const nextEvent = useMemo(() => getNextOfficialEvent(now), [now]);
  const isToday = Boolean(nextEvent && nextEvent.date === today);
  // Show mentor signal for the current/next event until the day after (then it clears).
  const signalEvent = useMemo(
    () => findMentorSignalEvent(nextEvent, mentorEvents, now),
    [nextEvent, mentorEvents, now]
  );
  const signal = useMemo(
    () => String(signalEvent?.directions || "").trim(),
    [signalEvent]
  );
  const postedLabel = useMemo(
    () =>
      signal
        ? formatSignalPostedAt(
            signalEvent?.postedAt || signalEvent?.updatedAt || signalEvent?.createdAt,
            now
          )
        : "",
    [signal, signalEvent, now]
  );
  const parsed = useMemo(() => parseSignalTrade(signal), [signal]);
  const executeOpen = useMemo(
    () => Boolean(nextEvent && isSignalExecuteOpen(nextEvent, now)),
    [nextEvent, now]
  );
  const executeHint = useMemo(
    () => (nextEvent ? formatSignalExecuteHint(nextEvent, now) : ""),
    [nextEvent, now]
  );
  const connected = Boolean(mt5Session?.accountId);

  async function onExecute() {
    if (!parsed?.symbol || !parsed?.side) {
      showToast("No tradeable signal yet");
      return;
    }
    if (!nextEvent || !isSignalExecuteOpen(nextEvent, new Date())) {
      showToast(executeHint || "Execute only opens 20 min before the event");
      return;
    }
    if (!connected) {
      showToast("Connect MT5 first to execute");
      setZetaView?.("metatrader");
      setV2View?.("metatrader");
      setOpen(false);
      return;
    }

    const meta = getSymbolMeta?.(parsed.symbol) || {};
    const lot = clampLot(meta.lotSize);
    const comment = buildBotTradeComment(activeBot?.name || "news");

    setExecuting(true);
    publishOrbTrade?.({
      botName: activeBot?.name || "Bot",
      comment,
      symbol: parsed.symbol,
      lotSize: lot,
      action: parsed.side,
      side: parsed.side,
    });
    try {
      const fill = await placeTrade({
        accountId: mt5Session.accountId,
        symbol: parsed.symbol,
        volume: lot,
        side: parsed.side,
        region: mt5Session.region || "",
        comment: `${comment}|NEWS`.slice(0, 31),
        source: "chart-scanner",
      });
      const filledSymbol = String(fill?.symbol || parsed.symbol)
        .trim()
        .toUpperCase()
        .replace(/[-–—]+$/g, "");
      recordTrade({
        botName: activeBot?.name || "Bot",
        symbol: filledSymbol || parsed.symbol,
        lotSize: lot,
        action: parsed.side,
        side: parsed.side,
        comment: `${comment}|NEWS`.slice(0, 31),
      });
      showToast(
        `Executed ${fill?.side || parsed.side} ${filledSymbol || parsed.symbol} ${fill?.volume || lot}`
      );
      window.setTimeout(() => clearOrbTrade?.(), 8000);
    } catch (error) {
      clearOrbTrade?.();
      showToast(error.message || "Execute failed");
    } finally {
      setExecuting(false);
    }
  }

  return (
    <>
      <button
        className={`econ-cal-btn econ-cal-btn-${variant}`}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="econ-cal-btn-ring" aria-hidden="true" />
        <span className="econ-cal-btn-ring econ-cal-btn-ring--outer" aria-hidden="true" />
        <span className="econ-cal-btn-label">Economic calendar</span>
      </button>

      {!open
        ? null
        : createPortal(
            <div
              className="econ-cal-backdrop"
              role="presentation"
              onClick={() => setOpen(false)}
            >
              <div
                className="econ-cal-panel"
                role="dialog"
                aria-modal="true"
                aria-label="Economic calendar"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="econ-cal-panel-head">
                  <h2>Economic calendar</h2>
                  <button
                    className="econ-cal-close"
                    type="button"
                    aria-label="Close"
                    onClick={() => setOpen(false)}
                  >
                    ✕
                  </button>
                </div>

                {loading ? (
                  <p className="econ-cal-copy">Loading next event…</p>
                ) : !nextEvent ? (
                  <p className="econ-cal-copy">
                    No upcoming NFP, PPI, CPI, or FOMC events on the calendar.
                  </p>
                ) : (
                  <>
                    <p className="econ-cal-next-label">Next event</p>
                    <div className="econ-cal-next-title-row">
                      <p className="econ-cal-next-title">{nextEvent.title}</p>
                      {postedLabel ? (
                        <div className="econ-cal-posted" aria-label={`Time posted ${postedLabel}`}>
                          <span className="econ-cal-posted-label">Time posted</span>
                          <strong className="econ-cal-posted-time">{postedLabel}</strong>
                        </div>
                      ) : null}
                    </div>
                    <p className="econ-cal-next-day">{formatEventDay(nextEvent.date)}</p>
                    <p className="econ-cal-next-note">
                      {nextEvent.timeSa || nextEvent.timeEt} SAST
                      {nextEvent.note ? ` · ${nextEvent.note}` : ""}
                    </p>
                    <div className="econ-cal-directions">
                      <p className="econ-cal-directions-label">Signal direction</p>
                      {signal ? (
                        <div className="econ-cal-signal-row">
                          <p className="econ-cal-directions-body">{signal}</p>
                          <button
                            className={`econ-cal-execute${executeOpen ? " is-open" : ""}`}
                            type="button"
                            disabled={executing || !parsed || !executeOpen}
                            title={executeHint}
                            onClick={onExecute}
                          >
                            {executing ? "…" : "Execute"}
                          </button>
                        </div>
                      ) : (
                        <p className="econ-cal-directions-body is-empty">
                          {isToday
                            ? "No signal direction from your mentor yet."
                            : "No signal direction yet — your mentor will add it from their portal."}
                        </p>
                      )}
                      {signal ? (
                        <p className="econ-cal-execute-hint">
                          {parsed
                            ? executeHint
                            : "Signal needs a symbol and BUY/SELL to execute"}
                          {!connected && executeOpen
                            ? " · Connect MT5 to trade"
                            : ""}
                        </p>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </div>,
            document.body
          )}
    </>
  );
}
