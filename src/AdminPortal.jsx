import { useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl } from "./apiOrigin.js";
import AdminAuth from "./AdminAuth.jsx";
import {
  COMMISSION_PERCENT,
  COMMISSION_USD,
  COMMISSION_ZAR,
  DEFAULT_MENTOR_LICENSE_KEYS,
  fetchMentors,
  SUPER_ADMIN_EMAIL,
  updateMentorBanking,
  updateMentorLicenseKeys,
  updateMentorProfile,
  updateMentorStatus,
  WITHDRAW_MIN_KEYS,
} from "./mentorsApi.js";
import {
  formatLicenseDuration,
  formatLicenseExpiry,
  isLicenseExpired,
  LICENSE_DURATIONS,
  resolveLicenseExpiry,
} from "./licensesApi.js";
import {
  fetchEconomicEvents,
  formatEventDay,
  removeEconomicEvent,
  saveEconomicEvent,
} from "./economicCalendarApi.js";
import {
  filterActiveMentorDirections,
  findOfficialEvent,
  formatSignalLockLabel,
  getMentorSignalForEvent,
  getNextOfficialEvent,
  isSignalDirectionEditable,
  listUpcomingOfficialEvents,
} from "./economicCalendarSchedule.js";
import {
  executeMentorSelfHostTrade,
  listMentorHostedAccounts,
} from "./mt5AccountsApi.js";
import { STRATEGY_LABELS, useApp } from "./store.jsx";
import { APP_COLOR_PRESETS, DEFAULT_APP_COLOR } from "./theme.js";

const ADMIN_SESSION_KEY = "apexea-admin-session";
const PORTAL_THEME_KEY = "apexea-portal-theme";
const SELF_HOST_RECENT_KEY = "apexea-self-host-recent-v1";

function readPortalTheme() {
  try {
    const theme = localStorage.getItem(PORTAL_THEME_KEY);
    if (theme === "light" || theme === "dark") return theme;
  } catch {
    // ignore
  }
  return "dark";
}

function writePortalTheme(theme) {
  try {
    localStorage.setItem(PORTAL_THEME_KEY, theme);
  } catch {
    // ignore
  }
}

function loadSelfHostRecent(mentorEmail) {
  try {
    const key = normalizeAdminEmail(mentorEmail);
    if (!key) return [];
    const raw = JSON.parse(localStorage.getItem(SELF_HOST_RECENT_KEY) || "{}");
    const list = Array.isArray(raw?.[key]) ? raw[key] : [];
    return list.slice(0, 12);
  } catch {
    return [];
  }
}

function saveSelfHostRecent(mentorEmail, entry) {
  try {
    const key = normalizeAdminEmail(mentorEmail);
    if (!key || !entry) return [];
    const raw = JSON.parse(localStorage.getItem(SELF_HOST_RECENT_KEY) || "{}");
    const prev = Array.isArray(raw?.[key]) ? raw[key] : [];
    const next = [entry, ...prev].slice(0, 12);
    localStorage.setItem(SELF_HOST_RECENT_KEY, JSON.stringify({ ...raw, [key]: next }));
    return next;
  } catch {
    return [];
  }
}

function isUploadedProfilePhoto(value) {
  const photo = String(value || "").trim();
  if (!photo) return false;
  if (photo === "/logo.png") return false;
  // Data URLs (just picked), synced API paths, or remote URLs.
  return (
    photo.startsWith("data:image/") ||
    photo.startsWith("/api/licenses/photo") ||
    /^https?:\/\//i.test(photo)
  );
}

function normalizeAdminEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isSuperAdminSession(session) {
  const role = String(session?.role || "").toLowerCase();
  const email = normalizeAdminEmail(session?.email);
  return role === "superadmin" || email === normalizeAdminEmail(SUPER_ADMIN_EMAIL);
}

function readAdminSession() {
  try {
    const raw = sessionStorage.getItem(ADMIN_SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed?.email) return null;
    if (isSuperAdminSession(parsed) && parsed.role !== "superadmin") {
      return { ...parsed, role: "superadmin", status: "approved" };
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeAdminSession(mentor) {
  if (!mentor) {
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    return;
  }
  const email = normalizeAdminEmail(mentor.email);
  const role = isSuperAdminSession(mentor) ? "superadmin" : mentor.role || "mentor";
  sessionStorage.setItem(
    ADMIN_SESSION_KEY,
    JSON.stringify({
      id: mentor.id,
      email,
      username: mentor.username,
      role,
      status: role === "superadmin" ? "approved" : mentor.status,
    })
  );
}

export default function AdminPortal() {
  const {
    adminOpen,
    adminPage,
    setAdminPage,
    signups,
    setSignupStatus,
    bypassAppAccess,
    bypassPremiumScanner,
    refreshSignups,
    eas,
    upsertEa,
    deleteEa,
    editingEaId,
    setEditingEaId,
    bots,
    licenseKeys,
    generateLicense,
    generateLicensesBulk,
    deactivateLicense,
    deleteLicense,
    refreshLicenses,
    catalog,
    ensureCatalog,
    normalizeSymbol,
    showToast,
    appColor,
    setAppColor,
  } = useApp();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [portalTheme, setPortalTheme] = useState(() => readPortalTheme());
  const [adminSession, setAdminSession] = useState(() => readAdminSession());
  const [mentors, setMentors] = useState([]);
  const [photo, setPhoto] = useState("/logo.png");
  const [photoUploaded, setPhotoUploaded] = useState(false);
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState("scalper");
  const [draftSymbols, setDraftSymbols] = useState([]);
  const [customSymbol, setCustomSymbol] = useState("");
  const [licenseBotId, setLicenseBotId] = useState("");
  const [licenseClientName, setLicenseClientName] = useState("");
  const [licenseClientEmail, setLicenseClientEmail] = useState("");
  const [licenseDuration, setLicenseDuration] = useState("1m");
  const [licenseSearch, setLicenseSearch] = useState("");
  const [licenseBulkBusy, setLicenseBulkBusy] = useState(false);
  const [licenseBulkSummary, setLicenseBulkSummary] = useState(null);
  const [inviteLinkPreview, setInviteLinkPreview] = useState("");
  const [commissionSearch, setCommissionSearch] = useState("");
  const [mentorMgmtSearch, setMentorMgmtSearch] = useState("");
  const [mentorBulkBusy, setMentorBulkBusy] = useState(false);
  const [clientMgmtSearch, setClientMgmtSearch] = useState("");
  const [clientBulkBusy, setClientBulkBusy] = useState(false);
  const [mentorKeySearch, setMentorKeySearch] = useState("");
  const [mentorKeyDrafts, setMentorKeyDrafts] = useState({});
  const [mentorKeyBusy, setMentorKeyBusy] = useState("");
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarDate, setCalendarDate] = useState("");
  const [calendarTitle, setCalendarTitle] = useState("");
  const [calendarDirections, setCalendarDirections] = useState("");
  const [calendarBusy, setCalendarBusy] = useState(false);
  const [calendarEditingId, setCalendarEditingId] = useState("");
  /** Prevents auto-prefill from putting saved text back after the mentor clears/edits it. */
  const signalDirectionsTouchedRef = useRef(false);
  const signalPrefillEventIdRef = useRef("");
  const [latestKey, setLatestKey] = useState("");
  const [latestLicenseMeta, setLatestLicenseMeta] = useState(null);
  const [licenseSheetOpen, setLicenseSheetOpen] = useState(false);
  const [bypassOpen, setBypassOpen] = useState(false);
  const [bypassEmail, setBypassEmail] = useState("");
  const [bypassBusy, setBypassBusy] = useState(false);
  const [bankingForm, setBankingForm] = useState({
    accountName: "",
    bankName: "",
    accountNumber: "",
    branchCode: "",
    accountType: "",
  });
  const [bankingBusy, setBankingBusy] = useState(false);
  const [hostSymbol, setHostSymbol] = useState("XAUUSD");
  const [hostSide, setHostSide] = useState("BUY");
  const [hostVolume, setHostVolume] = useState("0.01");
  const [hostSl, setHostSl] = useState("");
  const [hostTp, setHostTp] = useState("");
  const [hostAccounts, setHostAccounts] = useState([]);
  const [hostLoading, setHostLoading] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostConfirmOpen, setHostConfirmOpen] = useState(false);
  const [hostResult, setHostResult] = useState(null);
  const [hostDetailsOpen, setHostDetailsOpen] = useState(false);
  const [hostRecent, setHostRecent] = useState([]);
  const [profileUsername, setProfileUsername] = useState("");
  const [profileContact, setProfileContact] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  async function copyLicenseKey(key) {
    const value = String(key || "").trim();
    if (!value) {
      showToast("No license key to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      showToast("License key copied");
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        showToast("License key copied");
      } catch {
        showToast("Could not copy — select the key manually");
      }
    }
  }

  function parseClientCsv(text) {
    const lines = String(text || "")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return [];

    const splitRow = (line) => {
      const cells = [];
      let cur = "";
      let inQuotes = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuotes = !inQuotes;
          }
          continue;
        }
        if ((ch === "," || ch === ";" || ch === "\t") && !inQuotes) {
          cells.push(cur.trim());
          cur = "";
          continue;
        }
        cur += ch;
      }
      cells.push(cur.trim());
      return cells.map((c) => c.replace(/^"|"$/g, "").trim());
    };

    const rows = lines.map(splitRow);
    const header = rows[0].map((c) => c.toLowerCase());
    const looksHeader =
      header.some((h) => h.includes("email")) ||
      header.some((h) => h.includes("name"));
    const dataRows = looksHeader ? rows.slice(1) : rows;
    let nameIdx = header.findIndex((h) => h === "name" || h === "clientname" || h === "client_name" || h === "client name");
    let emailIdx = header.findIndex((h) => h === "email" || h === "clientemail" || h === "client_email" || h === "client email");
    if (!looksHeader) {
      nameIdx = 0;
      emailIdx = 1;
    } else {
      if (nameIdx < 0) nameIdx = 0;
      if (emailIdx < 0) emailIdx = header.length > 1 ? 1 : 0;
    }

    return dataRows
      .map((cols) => ({
        clientName: String(cols[nameIdx] || "").trim(),
        clientEmail: String(cols[emailIdx] || "").trim().toLowerCase(),
      }))
      .filter((row) => row.clientName && row.clientEmail.includes("@"));
  }

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function downloadBulkLicenseCsv(result) {
    const rows = [
      ["clientName", "clientEmail", "licenseKey", "status"],
      ...(result?.created || []).map((row) => [
        row.clientName || "",
        row.clientEmail || "",
        row.key || "",
        "created",
      ]),
      ...(result?.skipped || []).map((row) => [
        row.clientName || "",
        row.clientEmail || "",
        row.key || "",
        row.reason || "skipped",
      ]),
    ];
    const csv = rows
      .map((cols) =>
        cols
          .map((value) => {
            const raw = String(value ?? "");
            return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
          })
          .join(",")
      )
      .join("\n");
    downloadTextFile(`apexea-bulk-licenses-${Date.now()}.csv`, csv);
  }

  function mentorInviteCodeFor(mentorOrSession) {
    const fromField = String(mentorOrSession?.inviteCode || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (fromField) return fromField;
    const id = String(mentorOrSession?.id || "")
      .replace(/-/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    return id.slice(0, 8);
  }

  function buildMentorInviteLink() {
    const ownerEmail = String(adminSession.email || "")
      .trim()
      .toLowerCase();
    const ownerMentor =
      mentors.find(
        (m) =>
          String(m.email || "")
            .trim()
            .toLowerCase() === ownerEmail
      ) || adminSession;
    const code = mentorInviteCodeFor(ownerMentor);
    if (!code) {
      showToast("Could not build invite code — re-login to mentor portal");
      return "";
    }
    if (!licenseBotId) {
      showToast("Select a bot first");
      return "";
    }
    const ea = myEas.find((b) => b.id === licenseBotId);
    const params = new URLSearchParams({
      invite: code,
      bot: licenseBotId,
      botName: ea?.name || "Bot",
      duration: licenseDuration || "lifetime",
      // Old clients from another platform skip the $35.60 access fee.
      migrate: "1",
    });
    // Query + hash so WhatsApp/iMessage and in-app browsers keep the invite.
    const q = params.toString();
    return `https://apex-ea.com/?${q}#${q}`;
  }

  async function copyMentorInviteLink() {
    const link = buildMentorInviteLink();
    if (!link) return;
    setInviteLinkPreview(link);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        throw new Error("clipboard unavailable");
      }
      showToast("Invite link copied — send it to your clients");
    } catch {
      try {
        const input = document.createElement("textarea");
        input.value = link;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.left = "-9999px";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
        showToast("Invite link copied — send it to your clients");
      } catch {
        window.prompt("Copy this invite link:", link);
      }
    }
  }

  async function runBulkLicenseImport(file) {
    if (!file) return;
    if (!licenseBotId) {
      showToast("Select a bot first");
      return;
    }
    if (licenseBulkBusy) return;
    setLicenseBulkBusy(true);
    setLicenseBulkSummary(null);
    try {
      const text = await file.text();
      const clients = parseClientCsv(text);
      if (!clients.length) {
        showToast("CSV needs columns like name,email (one client per row)");
        return;
      }
      const ea = myEas.find((b) => b.id === licenseBotId);
      const ownerEmail =
        String(ea?.ownerEmail || "").trim().toLowerCase() ||
        String(adminSession.email || "").trim().toLowerCase();
      const ownerMentor = mentors.find(
        (m) =>
          String(m.email || "")
            .trim()
            .toLowerCase() === ownerEmail
      );
      const mentorName =
        String(ownerMentor?.username || "").trim() ||
        String(adminSession.username || "").trim();
      const mentorId =
        String(ownerMentor?.id || ea?.ownerId || adminSession.id || "").trim();
      const result = await generateLicensesBulk(licenseBotId, clients, {
        duration: licenseDuration,
        mentorEmail: ownerEmail,
        mentorId,
        mentorName,
      });
      if (result) {
        setLicenseBulkSummary(result);
        await refreshLicenses?.();
      }
    } catch (error) {
      showToast(error.message || "Could not read CSV");
    } finally {
      setLicenseBulkBusy(false);
    }
  }

  async function onDeactivateLicense(key) {
    if (!isSuperAdmin) {
      showToast("Only super admin can activate used license keys");
      return;
    }
    const result = await deactivateLicense?.(key, {
      adminEmail: adminSession?.email || "",
    });
    if (result) {
      await refreshLicenses?.();
      if (latestKey === key) setLicenseSheetOpen(true);
    }
  }

  async function onDeleteLicense(key) {
    const label = String(key || "").trim();
    if (!label) return;
    const ok = window.confirm(`Delete license ${label}? This cannot be undone.`);
    if (!ok) return;
    const deleted = await deleteLicense?.(key);
    if (deleted && latestKey === key) {
      setLatestKey("");
      setLatestLicenseMeta(null);
      setLicenseSheetOpen(false);
    }
  }

  function openLicenseDetail(entry) {
    if (!entry?.key) return;
    setLatestKey(entry.key);
    setLatestLicenseMeta({
      name: entry.clientName || entry.mainText || "",
      email: entry.clientEmail || "",
      botName: entry.botName || "",
      status: entry.used ? "Used" : "Available",
      duration: formatLicenseDuration(entry),
      expiry: formatLicenseExpiry(entry),
      createdAt: entry.createdAt || null,
      usedAt: entry.usedAt || null,
      mentorName: entry.mentorName || "",
      mentorEmail: entry.mentorEmail || "",
      expired: isLicenseExpired(entry),
    });
    setLicenseSheetOpen(true);
  }


  const pending = useMemo(
    () => signups.filter((s) => s.status === "pending").sort((a, b) => b.createdAt - a.createdAt),
    [signups]
  );
  const approved = useMemo(
    () => signups.filter((s) => s.status === "approved").sort((a, b) => b.createdAt - a.createdAt),
    [signups]
  );
  const declined = useMemo(
    () => signups.filter((s) => s.status === "declined").sort((a, b) => b.createdAt - a.createdAt),
    [signups]
  );
  const pendingMentors = useMemo(
    () =>
      mentors
        .filter((m) => String(m.status || "").toLowerCase() === "pending")
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [mentors]
  );
  const approvedMentors = useMemo(
    () =>
      mentors
        .filter((m) => {
          const status = String(m.status || "").toLowerCase();
          const role = String(m.role || "").toLowerCase();
          return status === "approved" || role === "superadmin";
        })
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [mentors]
  );
  const declinedMentors = useMemo(
    () =>
      mentors
        .filter((m) => String(m.status || "").toLowerCase() === "declined")
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [mentors]
  );

  const mentorMgmtQuery = String(mentorMgmtSearch || "")
    .trim()
    .toLowerCase();

  const clientMgmtQuery = String(clientMgmtSearch || "")
    .trim()
    .toLowerCase();

  const filteredClients = useMemo(() => {
    const list = [...(signups || [])].sort(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0)
    );
    if (!clientMgmtQuery) return list;
    return list.filter((s) =>
      String(s?.email || "")
        .toLowerCase()
        .includes(clientMgmtQuery)
    );
  }, [signups, clientMgmtQuery]);

  const filteredPendingClients = useMemo(
    () =>
      filteredClients.filter(
        (s) => String(s?.status || "").toLowerCase() === "pending"
      ),
    [filteredClients]
  );

  const filteredPendingMentors = useMemo(() => {
    if (!mentorMgmtQuery) return pendingMentors;
    return pendingMentors.filter((mentor) => {
      const hay = [mentor?.username, mentor?.email, mentor?.contact]
        .map((part) => String(part || "").toLowerCase())
        .join(" ");
      return hay.includes(mentorMgmtQuery);
    });
  }, [pendingMentors, mentorMgmtQuery]);

  const filteredApprovedMentors = useMemo(() => {
    if (!mentorMgmtQuery) return approvedMentors;
    return approvedMentors.filter((mentor) => {
      const hay = [mentor?.username, mentor?.email, mentor?.contact]
        .map((part) => String(part || "").toLowerCase())
        .join(" ");
      return hay.includes(mentorMgmtQuery);
    });
  }, [approvedMentors, mentorMgmtQuery]);

  const filteredDeclinedMentors = useMemo(() => {
    if (!mentorMgmtQuery) return declinedMentors;
    return declinedMentors.filter((mentor) => {
      const hay = [mentor?.username, mentor?.email, mentor?.contact]
        .map((part) => String(part || "").toLowerCase())
        .join(" ");
      return hay.includes(mentorMgmtQuery);
    });
  }, [declinedMentors, mentorMgmtQuery]);

  // Form fields are seeded in startEdit — do not rebind on `eas` poll updates
  // or a newly picked profile picture gets wiped before save.

  useEffect(() => {
    if (!licenseBotId && eas[0]) setLicenseBotId(eas[0].id);
  }, [eas, licenseBotId]);

  useEffect(() => {
    if (!adminOpen) return undefined;
    refreshSignups?.();
    const timer = setInterval(() => {
      refreshSignups?.();
    }, 8000);
    return () => clearInterval(timer);
  }, [adminOpen, adminPage, refreshSignups]);

  useEffect(() => {
    if (!adminOpen || !adminSession) return undefined;
    let cancelled = false;
    async function loadMentors() {
      try {
        const list = await fetchMentors();
        if (cancelled) return;
        setMentors((prev) => {
          const map = new Map(
            (Array.isArray(list) ? list : []).map((m) => [
              normalizeAdminEmail(m.email),
              m,
            ])
          );
          for (const m of prev) {
            const key = normalizeAdminEmail(m.email);
            const incoming = map.get(key);
            if (!incoming) {
              map.set(key, m);
              continue;
            }
            const keepBanking =
              m?.banking?.accountNumber && !incoming?.banking?.accountNumber
                ? m.banking
                : incoming.banking?.accountNumber
                  ? incoming.banking
                  : m.banking || incoming.banking;
            map.set(key, { ...incoming, banking: keepBanking });
          }
          return Array.from(map.values());
        });
      } catch {
        if (!cancelled) setMentors((prev) => prev);
      }
    }
    loadMentors();
    // Poll faster on Mentors page so new signups show in Pending quickly.
    const ms =
      adminPage === "mentors" ||
      adminPage === "commissions" ||
      adminPage === "commission" ||
      adminPage === "mentor-keys"
        ? 5000
        : 12000;
    const timer = setInterval(loadMentors, ms);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [adminOpen, adminSession, adminPage]);

  useEffect(() => {
    if (!adminOpen || !adminSession || isSuperAdminSession(adminSession)) return;
    if (adminPage !== "self-hosting") return;
    setHostRecent(loadSelfHostRecent(adminSession.email));
    let cancelled = false;
    async function loadHosted() {
      setHostLoading(true);
      try {
        const accounts = await listMentorHostedAccounts(adminSession.email);
        if (cancelled) return;
        setHostAccounts(accounts);
      } catch (error) {
        if (!cancelled) {
          setHostAccounts([]);
          showToast(error.message || "Could not load connected robot clients");
        }
      } finally {
        if (!cancelled) setHostLoading(false);
      }
    }
    loadHosted();
    const timer = setInterval(loadHosted, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [adminOpen, adminSession, adminPage, showToast]);

  useEffect(() => {
    if (!adminOpen || !adminSession || isSuperAdminSession(adminSession)) return undefined;
    if (adminPage !== "signal-direction") return undefined;
    let cancelled = false;
    async function loadCalendar() {
      try {
        const list = await fetchEconomicEvents(adminSession.email);
        if (!cancelled) setCalendarEvents(Array.isArray(list) ? list : []);
      } catch (error) {
        if (!cancelled) {
          setCalendarEvents([]);
          showToast(error.message || "Could not load signal directions");
        }
      }
    }
    loadCalendar();
    return () => {
      cancelled = true;
    };
  }, [adminOpen, adminSession, adminPage, showToast]);

  // Prefill once per selected event. Do not re-fill after the mentor clears or edits.
  useEffect(() => {
    if (!adminOpen || !adminSession) return;
    if (adminPage !== "signal-direction") return;
    const official =
      findOfficialEvent({
        id: calendarEditingId,
        date: calendarDate,
        title: calendarTitle,
      }) || getNextOfficialEvent();
    if (!official) return;

    if (signalPrefillEventIdRef.current !== official.id) {
      signalPrefillEventIdRef.current = official.id;
      signalDirectionsTouchedRef.current = false;
      setCalendarEditingId(official.id);
      setCalendarDate(official.date);
      setCalendarTitle(official.title);
      setCalendarDirections(getMentorSignalForEvent(official, calendarEvents) || "");
      return;
    }

    if (signalDirectionsTouchedRef.current) return;
    const saved = getMentorSignalForEvent(official, calendarEvents);
    if (saved && !String(calendarDirections || "").trim()) {
      setCalendarDirections(saved);
    }
  }, [
    adminOpen,
    adminSession,
    adminPage,
    calendarEvents,
    calendarEditingId,
    calendarDate,
    calendarTitle,
    calendarDirections,
  ]);

  useEffect(() => {
    if (!adminSession?.email) return;
    const mine = mentors.find(
      (m) => normalizeAdminEmail(m.email) === normalizeAdminEmail(adminSession.email)
    );
    const banking = mine?.banking;
    // Never clobber in-progress / saved form fields with empty remote banking.
    // Polls used to wipe the banking form right after typing or saving.
    if (!banking?.accountNumber && !banking?.accountName) return;
    setBankingForm((prev) => {
      const incomingEmpty =
        !String(banking.accountName || "").trim() &&
        !String(banking.accountNumber || "").trim();
      if (incomingEmpty) return prev;
      const same =
        prev.accountName === (banking.accountName || "") &&
        prev.bankName === (banking.bankName || "") &&
        prev.accountNumber === (banking.accountNumber || "") &&
        prev.branchCode === (banking.branchCode || "") &&
        prev.accountType === (banking.accountType || "");
      if (same) return prev;
      // If the user already typed more complete details, keep them.
      if (
        prev.accountNumber &&
        !banking.accountNumber
      ) {
        return prev;
      }
      return {
        accountName: banking.accountName || prev.accountName || "",
        bankName: banking.bankName || prev.bankName || "",
        accountNumber: banking.accountNumber || prev.accountNumber || "",
        branchCode: banking.branchCode || prev.branchCode || "",
        accountType: banking.accountType || prev.accountType || "",
      };
    });
  }, [mentors, adminSession?.email]);

  useEffect(() => {
    if (!adminSession?.email) return;
    const mine = mentors.find(
      (m) => normalizeAdminEmail(m.email) === normalizeAdminEmail(adminSession.email)
    );
    setProfileUsername(String(mine?.username || adminSession.username || "").trim());
    setProfileContact(String(mine?.contact || "").trim());
  }, [mentors, adminSession?.email, adminSession?.username]);

  async function refreshMentorsList() {
    try {
      const list = await fetchMentors();
      setMentors((prev) => {
        // Preserve any richer banking details already in memory.
        const map = new Map(
          (Array.isArray(list) ? list : []).map((m) => [normalizeAdminEmail(m.email), m])
        );
        for (const m of prev) {
          const key = normalizeAdminEmail(m.email);
          const incoming = map.get(key);
          if (!incoming) {
            map.set(key, m);
            continue;
          }
          const keepBanking =
            m?.banking?.accountNumber && !incoming?.banking?.accountNumber
              ? m.banking
              : incoming.banking || m.banking;
          map.set(key, { ...incoming, banking: keepBanking });
        }
        return Array.from(map.values());
      });
      showToast("Mentors refreshed");
    } catch (error) {
      showToast(error.message || "Could not refresh mentors");
    }
  }

  async function saveMentorBanking() {
    if (!adminSession?.email) return;
    setBankingBusy(true);
    const snapshot = { ...bankingForm };
    try {
      const updated = await updateMentorBanking(adminSession.email, snapshot);
      const banking = {
        accountName: updated?.banking?.accountName || snapshot.accountName || "",
        bankName: updated?.banking?.bankName || snapshot.bankName || "",
        accountNumber: updated?.banking?.accountNumber || snapshot.accountNumber || "",
        branchCode: updated?.banking?.branchCode || snapshot.branchCode || "",
        accountType: updated?.banking?.accountType || snapshot.accountType || "",
      };
      setBankingForm(banking);
      setMentors((prev) => {
        const email = normalizeAdminEmail(adminSession.email);
        const next = prev.map((m) =>
          normalizeAdminEmail(m.email) === email
            ? { ...m, ...(updated || {}), banking }
            : m
        );
        if (!next.some((m) => normalizeAdminEmail(m.email) === email)) {
          next.unshift({
            ...(updated || {
              email: adminSession.email,
              username: adminSession.username,
              role: "mentor",
              status: "approved",
            }),
            banking,
          });
        }
        return next;
      });
      showToast("Banking details saved");
    } catch (error) {
      // Keep what the mentor typed even if sync fails.
      setBankingForm(snapshot);
      showToast(error.message || "Could not save banking details");
    } finally {
      setBankingBusy(false);
    }
  }

  useEffect(() => {
    if (!adminSession) return;
    // Upgrade stale sessions that belong to the reserved super-admin email.
    if (isSuperAdminSession(adminSession) && adminSession.role !== "superadmin") {
      const upgraded = { ...adminSession, role: "superadmin", status: "approved" };
      writeAdminSession(upgraded);
      setAdminSession(upgraded);
      return;
    }
    const isSuper = isSuperAdminSession(adminSession);
    const mentorPages = new Set([
      "dashboard",
      "manage-ea",
      "licenses",
      "profile",
      "settings",
      "commission",
      "self-hosting",
      "signal-direction",
    ]);
    if (!isSuper && (adminPage === "calendar" || !mentorPages.has(adminPage))) {
      setAdminPage(adminPage === "calendar" ? "signal-direction" : "dashboard");
    }
  }, [adminSession, adminPage, setAdminPage]);

  if (!adminOpen) return null;

  function togglePortalTheme() {
    setPortalTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      writePortalTheme(next);
      return next;
    });
  }

  const themeToggle = (
    <button
      className="admin-icon-btn admin-theme-toggle"
      type="button"
      aria-label={portalTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={portalTheme === "dark" ? "Light mode" : "Dark mode"}
      onClick={togglePortalTheme}
    >
      {portalTheme === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 2.5v2.2M12 19.3v2.2M4.7 4.7l1.6 1.6M17.7 17.7l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.7 19.3l1.6-1.6M17.7 6.3l1.6-1.6"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M19.5 13.2A7.5 7.5 0 1 1 10.8 4.5 6.2 6.2 0 0 0 19.5 13.2Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  function onAuthenticated(mentor) {
    writeAdminSession(mentor);
    setAdminSession(mentor);
    setAdminPage("dashboard");
  }

  function logoutAdmin() {
    writeAdminSession(null);
    setAdminSession(null);
    setDrawerOpen(false);
    setAdminPage("dashboard");
    // Stay on /admin so the mentor sign-in/register screen shows — do not close admin.
    if (typeof window !== "undefined" && !window.location.pathname.includes("/admin")) {
      window.history.pushState({ apexAdmin: true }, "", "/admin");
    }
    showToast("Signed out");
  }

  async function changeMentorStatus(email, status, { silent = false } = {}) {
    try {
      const updated = await updateMentorStatus(email, status);
      setMentors((prev) => {
        const next = prev.map((m) => (m.email === updated.email ? updated : m));
        if (!next.some((m) => m.email === updated.email)) next.unshift(updated);
        return next;
      });
      if (!silent) showToast(`Mentor ${status}`);
      return true;
    } catch (error) {
      if (!silent) showToast(error.message || "Could not update mentor");
      return false;
    }
  }

  async function bulkApprovePendingMentors() {
    const list = filteredPendingMentors;
    if (!list.length) {
      showToast(
        mentorMgmtQuery
          ? "No pending mentors match your search"
          : "No pending mentors to approve"
      );
      return;
    }
    if (mentorBulkBusy) return;
    setMentorBulkBusy(true);
    let ok = 0;
    try {
      for (const mentor of list) {
        const success = await changeMentorStatus(mentor.email, "approved", {
          silent: true,
        });
        if (success) ok += 1;
      }
      showToast(
        ok === list.length
          ? `Approved ${ok} mentor${ok === 1 ? "" : "s"}`
          : `Approved ${ok} of ${list.length} mentors`
      );
    } finally {
      setMentorBulkBusy(false);
    }
  }

  async function bulkApprovePendingClients() {
    const list = filteredPendingClients;
    if (!list.length) {
      showToast(
        clientMgmtQuery
          ? "No pending clients match your search"
          : "No pending clients to approve"
      );
      return;
    }
    if (clientBulkBusy) return;
    setClientBulkBusy(true);
    let ok = 0;
    try {
      for (const client of list) {
        const success = await setSignupStatus(client.email, "approved", {
          silent: true,
        });
        if (success !== false) ok += 1;
      }
      showToast(
        ok === list.length
          ? `Approved ${ok} client${ok === 1 ? "" : "s"}`
          : `Approved ${ok} of ${list.length} clients`
      );
    } finally {
      setClientBulkBusy(false);
    }
  }

  if (!adminSession) {
    return (
      <div className="admin-portal admin-portal-auth" data-theme={portalTheme}>
        <header className="admin-topbar admin-topbar-auth">
          <span className="admin-topbar-spacer" aria-hidden="true" />
          <span className="admin-topbar-title">Mentor Access</span>
          {themeToggle}
        </header>
        <AdminAuth onAuthenticated={onAuthenticated} showToast={showToast} />
      </div>
    );
  }

  function resetForm() {
    setEditingEaId(null);
    setName("");
    setStrategy("scalper");
    setPhoto("/logo.png");
    setPhotoUploaded(false);
    setDraftSymbols([]);
    setCustomSymbol("");
  }

  function startEdit(ea) {
    setEditingEaId(ea.id);
    setName(ea.name || "");
    setStrategy(ea.strategy || "scalper");
    setPhoto(ea.photo || "/logo.png");
    setPhotoUploaded(isUploadedProfilePhoto(ea.photo));
    setDraftSymbols(Array.isArray(ea.symbols) ? [...ea.symbols] : []);
    setCustomSymbol("");
    setAdminPage("manage-ea");
    showToast(`Editing ${ea.name}`);
  }

  function addCustomSymbol() {
    const symbol = normalizeSymbol(customSymbol);
    if (!symbol) {
      showToast("Enter a symbol");
      return;
    }
    ensureCatalog(symbol);
    setDraftSymbols((prev) => (prev.includes(symbol) ? prev : [...prev, symbol]));
    setCustomSymbol("");
    showToast("Symbol added");
  }

  function toggleDraftSymbol(symbol) {
    setDraftSymbols((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]
    );
  }

  function onPhotoChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Please upload an image");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const img = new Image();
      img.onload = () => {
        // Cap longest edge high enough for full-bleed / retina heroes.
        // App state stores short /api/licenses/photo paths (not this data URL),
        // so localStorage quota stays safe while Home stays sharp on Android.
        const maxEdge = 1600;
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height, 1));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          if (!dataUrl.startsWith("data:image/")) {
            setPhotoUploaded(false);
            showToast("Could not read image");
            return;
          }
          setPhoto(dataUrl);
          setPhotoUploaded(true);
          showToast("Picture ready");
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, width, height);
        let quality = 0.88;
        let nextPhoto = canvas.toDataURL("image/jpeg", quality);
        while (nextPhoto.length > 900_000 && quality > 0.72) {
          quality -= 0.06;
          nextPhoto = canvas.toDataURL("image/jpeg", quality);
        }
        setPhoto(nextPhoto);
        setPhotoUploaded(true);
        showToast("Picture ready");
      };
      img.onerror = () => {
        setPhoto("/logo.png");
        setPhotoUploaded(false);
        showToast("Could not read image");
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  async function submitEa(event) {
    event.preventDefault();
    let symbols = [...draftSymbols];
    if (customSymbol.trim()) {
      const symbol = normalizeSymbol(customSymbol);
      if (symbol) {
        ensureCatalog(symbol);
        if (!symbols.includes(symbol)) symbols.push(symbol);
      }
    }
    if (!name.trim()) {
      showToast("Enter a robot name");
      return;
    }
    const hasPhoto = photoUploaded || isUploadedProfilePhoto(photo);
    if (!hasPhoto) {
      showToast("Upload a profile picture before creating the bot");
      return;
    }
    if (symbols.length === 0) {
      showToast("Add at least one symbol");
      return;
    }
    const ok = await upsertEa({
      id: editingEaId || undefined,
      name: name.trim(),
      strategy,
      photo,
      symbols,
      ownerEmail: adminSession?.email || "",
      ownerId: adminSession?.id || "",
    });
    if (!ok) return;
    resetForm();
    setAdminPage("manage-ea");
  }

  const isSuperAdmin = isSuperAdminSession(adminSession);
  const mentorEmail = String(adminSession?.email || "")
    .trim()
    .toLowerCase();
  const mentorId = String(adminSession?.id || "").trim();

  const myEas = isSuperAdmin
    ? eas
    : eas.filter((ea) => {
        const owner = String(ea.ownerEmail || "").toLowerCase();
        const ownerId = String(ea.ownerId || "");
        return owner === mentorEmail || (mentorId && ownerId === mentorId);
      });

  const eaIds = new Set(myEas.map((ea) => ea.id));
  const myLicenses = isSuperAdmin
    ? licenseKeys
    : licenseKeys.filter((row) => {
        const owner = String(row.mentorEmail || "").toLowerCase();
        const ownerId = String(row.mentorId || "");
        if (owner === mentorEmail || (mentorId && ownerId === mentorId)) return true;
        return eaIds.has(row.botId);
      });

  const sessionMentor = mentors.find(
    (m) => normalizeAdminEmail(m.email) === normalizeAdminEmail(mentorEmail)
  );
  const mentorKeyAllowance = isSuperAdmin
    ? null
    : sessionMentor?.licenseKeysAllowed != null
      ? Number(sessionMentor.licenseKeysAllowed)
      : DEFAULT_MENTOR_LICENSE_KEYS;
  const mentorKeysGenerated = myLicenses.length;
  const mentorKeysRemaining =
    mentorKeyAllowance == null
      ? null
      : Math.max(0, mentorKeyAllowance - mentorKeysGenerated);

  const mentorKeyQuery = String(mentorKeySearch || "")
    .trim()
    .toLowerCase();
  const mentorKeyRows = mentors
    .filter((m) => String(m.role || "").toLowerCase() !== "superadmin")
    .map((m) => {
      const email = normalizeAdminEmail(m.email);
      const allowed =
        m.licenseKeysAllowed != null
          ? Number(m.licenseKeysAllowed)
          : DEFAULT_MENTOR_LICENSE_KEYS;
      const used = licenseKeys.filter(
        (row) => normalizeAdminEmail(row.mentorEmail) === email
      ).length;
      const total = Number.isFinite(allowed) ? allowed : DEFAULT_MENTOR_LICENSE_KEYS;
      return {
        mentor: m,
        email,
        allowed: total,
        used,
        remaining: Math.max(0, total - used),
      };
    })
    .filter(({ mentor, email }) => {
      if (!mentorKeyQuery) return true;
      return (
        String(mentor.username || "")
          .toLowerCase()
          .includes(mentorKeyQuery) || email.includes(mentorKeyQuery)
      );
    })
    .sort((a, b) =>
      String(a.mentor.username || a.email).localeCompare(
        String(b.mentor.username || b.email)
      )
    );

  function mentorKeyDraft(email) {
    const key = normalizeAdminEmail(email);
    return mentorKeyDrafts[key] || { set: "", add: "" };
  }

  function patchMentorKeyDraft(email, patch) {
    const key = normalizeAdminEmail(email);
    setMentorKeyDrafts((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] || { set: "", add: "" }),
        ...patch,
      },
    }));
  }

  async function saveMentorKeyTotal(email) {
    const draft = mentorKeyDraft(email);
    const value = draft.set;
    if (value === "" || value == null) {
      showToast("Enter a total key allotment");
      return;
    }
    setMentorKeyBusy(`${normalizeAdminEmail(email)}:set`);
    try {
      const mentor = await updateMentorLicenseKeys(email, { set: value });
      if (mentor) {
        setMentors((prev) => {
          const key = normalizeAdminEmail(email);
          const idx = prev.findIndex((m) => normalizeAdminEmail(m.email) === key);
          if (idx < 0) return [...prev, mentor];
          const next = [...prev];
          next[idx] = { ...next[idx], ...mentor };
          return next;
        });
        patchMentorKeyDraft(email, { set: "" });
        showToast(
          `Set ${mentor.username || email} to ${mentor.licenseKeysAllowed} keys`
        );
      }
    } catch (error) {
      showToast(error.message || "Could not update key allotment");
    } finally {
      setMentorKeyBusy("");
    }
  }

  async function addMentorKeys(email) {
    const draft = mentorKeyDraft(email);
    const value = draft.add;
    if (value === "" || value == null) {
      showToast("Enter how many keys to add");
      return;
    }
    setMentorKeyBusy(`${normalizeAdminEmail(email)}:add`);
    try {
      const mentor = await updateMentorLicenseKeys(email, { add: value });
      if (mentor) {
        setMentors((prev) => {
          const key = normalizeAdminEmail(email);
          const idx = prev.findIndex((m) => normalizeAdminEmail(m.email) === key);
          if (idx < 0) return [...prev, mentor];
          const next = [...prev];
          next[idx] = { ...next[idx], ...mentor };
          return next;
        });
        patchMentorKeyDraft(email, { add: "" });
        showToast(
          `Added keys for ${mentor.username || email} · now ${mentor.licenseKeysAllowed}`
        );
      }
    } catch (error) {
      showToast(error.message || "Could not add keys");
    } finally {
      setMentorKeyBusy("");
    }
  }

  function resetCalendarForm() {
    const next = getNextOfficialEvent();
    signalPrefillEventIdRef.current = next?.id || "";
    signalDirectionsTouchedRef.current = false;
    setCalendarEditingId(next?.id || "");
    setCalendarDate(next?.date || "");
    setCalendarTitle(next?.title || "NFP");
    setCalendarDirections("");
  }

  function selectOfficialSignalEvent(official, directions = "") {
    if (!official) return;
    signalPrefillEventIdRef.current = official.id;
    signalDirectionsTouchedRef.current = false;
    setCalendarEditingId(official.id);
    setCalendarDate(official.date);
    setCalendarTitle(official.title);
    setCalendarDirections(directions || "");
  }

  function onSignalDirectionsChange(value) {
    signalDirectionsTouchedRef.current = true;
    setCalendarDirections(value);
  }

  function clearSignalDirections() {
    signalDirectionsTouchedRef.current = true;
    setCalendarDirections("");
  }

  async function saveCalendarEvent(event) {
    event.preventDefault();
    if (!adminSession?.email) {
      showToast("Sign in as a mentor first");
      return;
    }
    const official =
      findOfficialEvent({
        id: calendarEditingId,
        date: calendarDate,
        title: calendarTitle,
      }) || getNextOfficialEvent();
    if (!official) {
      showToast("Pick an NFP, PPI, CPI, or FOMC event");
      return;
    }
    if (!isSignalDirectionEditable(official)) {
      showToast(
        `Editing locked — ${official.title} already started (${official.timeSa || official.timeEt} SAST)`
      );
      return;
    }
    if (!String(calendarDirections || "").trim()) {
      showToast("Enter a signal direction");
      return;
    }
    setCalendarBusy(true);
    try {
      const saved = await saveEconomicEvent({
        id: official.id,
        officialEventId: official.id,
        mentorEmail: adminSession.email,
        date: official.date,
        title: official.title,
        directions: calendarDirections,
      });
      setCalendarEvents((prev) => {
        const rest = filterActiveMentorDirections(prev).filter(
          (row) => row.id !== saved.id && row.officialEventId !== official.id
        );
        return filterActiveMentorDirections([...rest, saved]).sort((a, b) =>
          String(a.date).localeCompare(String(b.date))
        );
      });
      showToast(`Signal direction saved for ${official.title}`);
    } catch (error) {
      showToast(error.message || "Could not save signal direction");
    } finally {
      setCalendarBusy(false);
    }
  }

  async function onDeleteCalendarEvent(id) {
    if (!id) return;
    setCalendarBusy(true);
    try {
      await removeEconomicEvent(id, adminSession?.email || "");
      setCalendarEvents((prev) => prev.filter((row) => row.id !== id));
      if (calendarEditingId === id) resetCalendarForm();
      showToast("Event removed");
    } catch (error) {
      showToast(error.message || "Could not remove event");
    } finally {
      setCalendarBusy(false);
    }
  }

  const licenseQuery = String(licenseSearch || "")
    .trim()
    .toLowerCase();
  const filteredLicenses = !licenseQuery
    ? myLicenses
    : myLicenses.filter((row) => {
        const name = String(row.clientName || row.mainText || "").toLowerCase();
        const email = String(row.clientEmail || "").toLowerCase();
        const key = String(row.key || "").toLowerCase();
        const bot = String(row.botName || "").toLowerCase();
        return (
          name.includes(licenseQuery) ||
          email.includes(licenseQuery) ||
          key.includes(licenseQuery) ||
          bot.includes(licenseQuery)
        );
      });

  const usedKeys = myLicenses.filter((k) => k.used);
  const availableKeys = myLicenses.filter((k) => !k.used);
  const activeBotIds = new Set(bots.filter((b) => b.active).map((b) => b.id));
  const activeKeys = myLicenses.filter((k) => k.used && activeBotIds.has(k.botId));
  const deactivatedKeys = myLicenses.filter(
    (k) => k.used && !activeBotIds.has(k.botId)
  );
  const recentKeys = [...myLicenses]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 8);

  function countSoldKeysForMentor(mentor) {
    const email = normalizeAdminEmail(mentor?.email);
    const id = String(mentor?.id || "");
    return licenseKeys.filter((row) => {
      const owner = normalizeAdminEmail(row.mentorEmail);
      const ownerId = String(row.mentorId || "");
      const owns =
        (email && owner === email) || (id && ownerId === id);
      // Commission only when the key unlocked a paid app subscription for the
      // first time — not merely from generating a key or reusing existing access.
      return owns && Boolean(row.used) && Boolean(row.commissionEligible);
    }).length;
  }

  const soldKeysCount = countSoldKeysForMentor(adminSession);
  const commissionUsd = Number((soldKeysCount * COMMISSION_USD).toFixed(2));
  const commissionZar = soldKeysCount * COMMISSION_ZAR;
  const canWithdraw = soldKeysCount >= WITHDRAW_MIN_KEYS;
  const keysUntilWithdraw = Math.max(0, WITHDRAW_MIN_KEYS - soldKeysCount);

  const commissionRows = mentors
    .filter((m) => {
      const role = String(m.role || "").toLowerCase();
      const status = String(m.status || "").toLowerCase();
      return role !== "superadmin" && status === "approved";
    })
    .map((mentor) => {
      const sold = countSoldKeysForMentor(mentor);
      return {
        mentor,
        sold,
        usd: Number((sold * COMMISSION_USD).toFixed(2)),
        zar: sold * COMMISSION_ZAR,
        withdrawable: sold >= WITHDRAW_MIN_KEYS,
        banking: mentor.banking || {},
      };
    })
    .sort(
      (a, b) =>
        b.sold - a.sold ||
        String(a.mentor.username || "").localeCompare(String(b.mentor.username || ""))
    );

  const commissionQuery = String(commissionSearch || "")
    .trim()
    .toLowerCase();
  const filteredCommissionRows = !commissionQuery
    ? commissionRows
    : commissionRows.filter(({ mentor, banking }) => {
        const username = String(mentor.username || "").toLowerCase();
        const email = String(mentor.email || "").toLowerCase();
        const contact = String(mentor.contact || "").toLowerCase();
        const accountName = String(banking?.accountName || "").toLowerCase();
        const bankName = String(banking?.bankName || "").toLowerCase();
        const accountNumber = String(banking?.accountNumber || "").toLowerCase();
        return (
          username.includes(commissionQuery) ||
          email.includes(commissionQuery) ||
          contact.includes(commissionQuery) ||
          accountName.includes(commissionQuery) ||
          bankName.includes(commissionQuery) ||
          accountNumber.includes(commissionQuery)
        );
      });

  const nav = isSuperAdmin
    ? [
        ["dashboard", "Dashboard"],
        ["mentors", "Mentors"],
        ["commissions", "Commissions"],
        ["clients", "Clients"],
        ["top-mentors", "Top Mentors"],
        ["activate", "Activate Accounts"],
        ["emails", "Send Emails"],
        ["manage-ea", "Manage EAs"],
        ["licenses", "License Keys"],
        ["settings", "Settings"],
        ["mentor-keys", "Mentor Keys"],
      ]
    : [
        ["dashboard", "Dashboard"],
        ["manage-ea", "Manage EAs"],
        ["licenses", "License Keys"],
        ["profile", "Profile"],
        ["settings", "Settings"],
        ["commission", "Mentor Commission"],
        ["self-hosting", "Self Hosting"],
        ["signal-direction", "Add Signal Direction"],
      ];

  return (
    <div className="admin-portal" data-theme={portalTheme}>
      <header className="admin-topbar">
        <button
          className="admin-icon-btn"
          type="button"
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
        >
          ☰
        </button>
        <h1 className="admin-topbar-title">{isSuperAdmin ? "Admin Portal" : "Mentor Portal"}</h1>
        {themeToggle}
      </header>

      {!drawerOpen ? null : (
        <div className="admin-drawer-backdrop" onClick={() => setDrawerOpen(false)} />
      )}
      <aside className={`admin-drawer${drawerOpen ? " is-open" : ""}`} aria-hidden={!drawerOpen}>
        <div className="admin-drawer-header">
          <div className="admin-drawer-user">
            <img src="/logo.png" alt="" width="36" height="36" />
            <span>{adminSession.username || "Admin"}</span>
          </div>
          <button className="admin-icon-btn" type="button" onClick={() => setDrawerOpen(false)}>
            ✕
          </button>
        </div>
        <nav className="admin-nav">
          {nav.map(([id, label]) => (
            <button
              key={id}
              className={`admin-nav-item${adminPage === id ? " is-active" : ""}`}
              type="button"
              onClick={() => {
                setAdminPage(id);
                setDrawerOpen(false);
              }}
            >
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="admin-drawer-footer">
          <button className="admin-nav-item admin-logout" type="button" onClick={logoutAdmin}>
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <div className="admin-content">
        {adminPage === "dashboard" && (
          <section className="admin-page is-active">
            {isSuperAdmin ? (
              <>
                <h2 className="admin-h1">Admin Dashboard</h2>
                <p className="admin-sub">Manage mentors and system settings</p>
                <div className="admin-stat-stack">
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Total Mentors</p>
                    <p className="admin-stat-value">{mentors.length}</p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Pending Approval</p>
                    <p className="admin-stat-value is-warn">{pendingMentors.length}</p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Approved Mentors</p>
                    <p className="admin-stat-value is-ok">{approvedMentors.length}</p>
                  </article>
                </div>
              </>
            ) : (
              <>
                <h2 className="admin-h1">Dashboard</h2>
                <p className="admin-sub">
                  Your EAs, license keys, and live activations.
                </p>
                <div className="admin-stat-stack">
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Used license keys</p>
                    <p className="admin-stat-value">{usedKeys.length}</p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Available</p>
                    <p className="admin-stat-value is-ok">
                      {mentorKeysRemaining == null ? "∞" : mentorKeysRemaining}
                    </p>
                    <p className="admin-card-meta">
                      {mentorKeysRemaining == null
                        ? "Unlimited generation"
                        : `${mentorKeysRemaining} of ${mentorKeyAllowance} keys left to generate`}
                      {availableKeys.length
                        ? ` · ${availableKeys.length} unused generated`
                        : ""}
                    </p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Active</p>
                    <p className="admin-stat-value is-ok">{activeKeys.length}</p>
                    <p className="admin-card-meta">Keys working on connected bots</p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Deactivated license keys</p>
                    <p className="admin-stat-value is-warn">{deactivatedKeys.length}</p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Total EAs</p>
                    <p className="admin-stat-value">{myEas.length}</p>
                  </article>
                </div>
                <div className="admin-card" style={{ marginTop: 14 }}>
                  <div className="admin-card-title-row">
                    <h3 className="admin-card-title">Recent keys</h3>
                    <span className="admin-badge">{recentKeys.length}</span>
                  </div>
                  {recentKeys.length === 0 ? (
                    <p className="admin-empty">No license keys yet</p>
                  ) : (
                    recentKeys.map((entry) => (
                      <div className="license-row" key={`${entry.key}-${entry.createdAt}`}>
                        <strong>{entry.key}</strong>
                        <span>
                          {entry.clientName ? `${entry.clientName} · ` : ""}
                          {entry.clientEmail || "no email"} · {entry.botName} ·{" "}
                          {entry.used ? "Used" : "Available"}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {isSuperAdmin && adminPage === "clients" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Client Management</h2>
            <p className="admin-sub">Manage client access and payment bypasses</p>

            <div className="admin-toolbar admin-client-mgmt-toolbar">
              <input
                className="admin-input"
                type="search"
                value={clientMgmtSearch}
                onChange={(e) => setClientMgmtSearch(e.target.value)}
                placeholder="Search clients by email"
                aria-label="Search clients by email"
              />
              <button
                className="admin-btn admin-btn-solid admin-btn-sm"
                type="button"
                disabled={clientBulkBusy || filteredPendingClients.length === 0}
                onClick={() => void bulkApprovePendingClients()}
              >
                {clientBulkBusy
                  ? "Approving…"
                  : `Bulk Approve${
                      filteredPendingClients.length
                        ? ` (${filteredPendingClients.length})`
                        : ""
                    }`}
              </button>
            </div>

            <div className="admin-card">
              <p className="admin-card-meta">
                {clientMgmtQuery
                  ? `Showing ${filteredClients.length} of ${signups.length} clients`
                  : `Total clients: ${signups.length}`}
                {filteredPendingClients.length
                  ? ` · ${filteredPendingClients.length} pending`
                  : ""}
              </p>
              <div className="admin-table-head admin-table-head-2">
                <span>Email</span>
                <span>Status</span>
              </div>
              {signups.length === 0 ? (
                <p className="admin-empty">No clients yet</p>
              ) : filteredClients.length === 0 ? (
                <p className="admin-empty">
                  No clients match “{clientMgmtSearch.trim()}”
                </p>
              ) : (
                filteredClients.map((s) => {
                  const status = String(s.status || "").toLowerCase();
                  const isPending = status === "pending";
                  return (
                    <div
                      className={`admin-table-row admin-table-row-2${
                        isPending ? " has-actions" : ""
                      }`}
                      key={s.email}
                    >
                      <span className="admin-name">{s.email}</span>
                      <div className="admin-client-status-cell">
                        <span
                          className={`admin-badge ${
                            status === "approved"
                              ? "is-approved"
                              : status === "declined"
                                ? "is-declined"
                                : "is-pending"
                          }`}
                        >
                          {status === "approved"
                            ? "Approved"
                            : status === "declined"
                              ? "Declined"
                              : "Pending"}
                        </span>
                        {isPending ? (
                          <div className="admin-row-actions">
                            <button
                              className="admin-btn admin-btn-solid admin-btn-sm"
                              type="button"
                              onClick={() =>
                                void setSignupStatus(s.email, "approved")
                              }
                            >
                              Approve
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        {isSuperAdmin && adminPage === "activate" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Activate Accounts</h2>
            <p className="admin-sub">
              Approve or decline pending signups. Only approved clients can use a license key.
            </p>
            <div className="admin-card">
              <div className="admin-card-title-row">
                <h3>Pending signups</h3>
                <span className="admin-badge">{pending.length}</span>
              </div>
              <button
                className="admin-btn admin-btn-sm"
                type="button"
                style={{ marginBottom: 10 }}
                onClick={() => refreshSignups?.().then(() => showToast("Pending list refreshed"))}
              >
                Refresh pending
              </button>
              <div className="admin-activate-list">
                {pending.length === 0 ? (
                  <p className="admin-empty">No pending accounts</p>
                ) : (
                  pending.map((s) => (
                    <div className="admin-table-row has-actions" key={s.email}>
                      <span className="admin-name">{s.email}</span>
                      <span className="admin-badge is-pending">Pending</span>
                      <div className="admin-row-actions">
                        <button
                          className="admin-btn admin-btn-solid admin-btn-sm"
                          type="button"
                          onClick={() => setSignupStatus(s.email, "approved")}
                        >
                          Approve
                        </button>
                        <button
                          className="admin-btn admin-btn-danger admin-btn-sm"
                          type="button"
                          onClick={() => setSignupStatus(s.email, "declined")}
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3>Approved accounts</h3>
                <span className="admin-badge">{approved.length}</span>
              </div>
              {approved.length === 0 ? (
                <p className="admin-empty">No approved accounts yet</p>
              ) : (
                approved.map((s) => (
                  <div className="admin-table-row is-status-only" key={s.email}>
                    <span className="admin-name">{s.email}</span>
                    <span className="admin-badge is-approved">Approved</span>
                  </div>
                ))
              )}
            </div>
            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3>Declined accounts</h3>
                <span className="admin-badge">{declined.length}</span>
              </div>
              {declined.length === 0 ? (
                <p className="admin-empty">No declined accounts</p>
              ) : (
                declined.map((s) => (
                  <div className="admin-table-row is-status-only" key={s.email}>
                    <span className="admin-name">{s.email}</span>
                    <span className="admin-badge is-declined">Declined</span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {adminPage === "manage-ea" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Manage EA</h2>
            <p className="admin-sub">Create and manage trading robot Expert Advisors.</p>
            <div className="admin-card ea-create-card">
              <div className="admin-card-title-row">
                <h3>{editingEaId ? "Edit Robot EA" : "Create Robot EA"}</h3>
              </div>
              <form className="ea-form" onSubmit={submitEa}>
                <div className={`ea-photo-field${photoUploaded || isUploadedProfilePhoto(photo) ? " has-photo" : " needs-photo"}`}>
                  <button
                    className="ea-photo-btn"
                    type="button"
                    onClick={() => document.getElementById("ea-photo-react")?.click()}
                  >
                    <img src={mediaUrl(photo)} alt="" />
                    <span>
                      {photoUploaded || isUploadedProfilePhoto(photo)
                        ? editingEaId
                          ? "Change picture"
                          : "Picture added"
                        : "Upload profile picture *"}
                    </span>
                  </button>
                  <input
                    id="ea-photo-react"
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={onPhotoChange}
                  />
                  {photoUploaded || isUploadedProfilePhoto(photo) ? null : (
                    <p className="ea-hint ea-photo-required">
                      Profile picture is required for the bot interface.
                    </p>
                  )}
                </div>
                <label className="ea-field">
                  <span>Robot name</span>
                  <input
                    className="admin-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. My Trading Bot"
                    required
                  />
                </label>
                <label className="ea-field">
                  <span>Strategy</span>
                  <select
                    className="admin-input"
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value)}
                  >
                    <option value="scalper">Scalper</option>
                    <option value="trend">Trend Follower</option>
                    <option value="grid">Grid</option>
                    <option value="news">News Trader</option>
                  </select>
                </label>
                <div className="ea-field">
                  <span>Symbols</span>
                  <p className="ea-hint">Pick from the list or type your own symbol below.</p>
                  <div className="ea-symbol-picker">
                    {catalog.map((symbol) => (
                      <button
                        key={symbol}
                        type="button"
                        className={`ea-pick-chip${draftSymbols.includes(symbol) ? " is-on" : ""}`}
                        onClick={() => toggleDraftSymbol(symbol)}
                      >
                        {symbol}
                      </button>
                    ))}
                  </div>
                  <div className="ea-manual-symbol">
                    <input
                      className="admin-input"
                      value={customSymbol}
                      onChange={(e) => setCustomSymbol(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCustomSymbol();
                        }
                      }}
                      placeholder="Write your own symbol (e.g. US500)"
                    />
                    <button
                      className="admin-btn admin-btn-outline"
                      type="button"
                      onClick={addCustomSymbol}
                    >
                      Add
                    </button>
                  </div>
                  <div className="ea-symbol-selected">
                    {draftSymbols.length === 0 ? (
                      <span className="ea-hint">No symbols chosen yet</span>
                    ) : (
                      draftSymbols.map((symbol) => (
                        <span className="ea-sym-chip" key={symbol}>
                          <span>{symbol}</span>
                          <button type="button" onClick={() => toggleDraftSymbol(symbol)}>
                            ×
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                </div>
                <button className="admin-btn admin-btn-solid admin-btn-block" type="submit">
                  {editingEaId ? "Save profile" : "Create EA"}
                </button>
                {editingEaId ? (
                  <button
                    className="admin-btn admin-btn-outline admin-btn-block"
                    type="button"
                    style={{ marginTop: 8 }}
                    onClick={resetForm}
                  >
                    Cancel edit
                  </button>
                ) : null}
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-title-row">
                <h3>Your EAs</h3>
                <span className="admin-badge">{myEas.length}</span>
              </div>
              <div className="ea-list">
                {myEas.length === 0 ? (
                  <p className="admin-empty">No EAs yet — create one above</p>
                ) : (
                  myEas.map((ea) => {
                    const bot = bots.find((b) => b.id === ea.id);
                    const isLive = Boolean(bot?.active);
                    return (
                    <div className="ea-item" key={ea.id}>
                      <span className="ea-avatar">
                        <img
                          src={mediaUrl(ea.photo || "/logo.png")}
                          alt=""
                          onError={(event) => {
                            if (event.currentTarget.src.endsWith("/logo.png")) return;
                            event.currentTarget.src = "/logo.png";
                          }}
                        />
                      </span>
                      <div className="ea-meta">
                        <strong>{ea.name}</strong>
                        <span>
                          {STRATEGY_LABELS[ea.strategy] || ea.strategy} · {ea.symbols.length}{" "}
                          symbols
                        </span>
                        <div className="ea-item-symbols">
                          {ea.symbols.map((s) => (
                            <span className="ea-sym-chip" key={s}>
                              <span>{s}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="ea-item-actions">
                        <span className={`admin-badge${isLive ? " is-approved" : ""}`}>
                          {isLive ? "Live" : "Inactive"}
                        </span>
                        <button className="ea-edit-btn" type="button" onClick={() => startEdit(ea)}>
                          Edit profile
                        </button>
                        <button
                          className="ea-delete-btn"
                          type="button"
                          onClick={() => deleteEa(ea.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        )}

        {adminPage === "licenses" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Generate License Key</h2>
            <p className="admin-sub">
              Client name is shown with the license. Your mentor username (from Profile) appears
              at the top of the client app. Enter the client name with their email and bot — the
              key syncs so they can activate on any phone after approval.
              {!isSuperAdmin && mentorKeyAllowance != null ? (
                <>
                  {" "}
                  You have <strong>{mentorKeysRemaining}</strong> of{" "}
                  <strong>{mentorKeyAllowance}</strong> keys remaining
                  ({mentorKeysGenerated} generated).
                </>
              ) : null}
            </p>
            <div className="admin-card">
              <form
                className="license-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const ea = myEas.find((b) => b.id === licenseBotId);
                  const ownerEmail =
                    String(ea?.ownerEmail || "").trim().toLowerCase() ||
                    String(adminSession.email || "").trim().toLowerCase();
                  const ownerMentor = mentors.find(
                    (m) =>
                      String(m.email || "")
                        .trim()
                        .toLowerCase() === ownerEmail
                  );
                  const mentorName =
                    String(ownerMentor?.username || "").trim() ||
                    String(adminSession.username || "").trim();
                  const mentorId =
                    String(ownerMentor?.id || ea?.ownerId || adminSession.id || "").trim();
                  const key = await generateLicense(licenseBotId, {
                    clientName: licenseClientName,
                    mainText: licenseClientName,
                    clientEmail: licenseClientEmail,
                    duration: licenseDuration,
                    mentorEmail: ownerEmail,
                    mentorId,
                    mentorName,
                  });
                  if (key) {
                    const timing = resolveLicenseExpiry(licenseDuration);
                    openLicenseDetail({
                      key,
                      clientName: licenseClientName.trim(),
                      clientEmail: String(licenseClientEmail || "")
                        .trim()
                        .toLowerCase(),
                      botName: ea?.name || "",
                      used: false,
                      duration: timing.duration,
                      expiresAt: timing.expiresAt,
                      createdAt: Date.now(),
                      mentorName,
                      mentorEmail: ownerEmail,
                    });
                  }
                  await refreshLicenses?.();
                }}
              >
                <label className="ea-field">
                  <span>Client name *</span>
                  <input
                    className="admin-input"
                    value={licenseClientName}
                    onChange={(e) => setLicenseClientName(e.target.value)}
                    placeholder="e.g. Sam smith"
                    required
                  />
                </label>
                <label className="ea-field">
                  <span>Client email *</span>
                  <input
                    className="admin-input"
                    type="email"
                    list="license-client-emails"
                    value={licenseClientEmail}
                    onChange={(e) => setLicenseClientEmail(e.target.value)}
                    placeholder="client@email.com"
                    required
                  />
                  <datalist id="license-client-emails">
                    {[...approved, ...pending].map((s) => (
                      <option key={s.email} value={s.email} />
                    ))}
                  </datalist>
                </label>
                <label className="ea-field">
                  <span>Bot</span>
                  <select
                    className="admin-input"
                    value={licenseBotId}
                    onChange={(e) => setLicenseBotId(e.target.value)}
                    required
                  >
                    {myEas.length === 0 ? (
                      <option value="" disabled>
                        No EAs yet
                      </option>
                    ) : (
                      myEas.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="ea-field">
                  <span>License duration *</span>
                  <select
                    className="admin-input"
                    value={licenseDuration}
                    onChange={(e) => setLicenseDuration(e.target.value)}
                    required
                  >
                    {LICENSE_DURATIONS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="admin-btn admin-btn-solid admin-btn-block" type="submit">
                  Generate License Key
                </button>
              </form>
              {latestKey ? (
                <div className="license-result">
                  <p>Latest key</p>
                  <code>{latestKey}</code>
                  {latestLicenseMeta ? (
                    <p className="ea-hint" style={{ marginTop: 8 }}>
                      Bound to {latestLicenseMeta.name} · {latestLicenseMeta.email}
                    </p>
                  ) : null}
                  <div className="license-row-actions" style={{ marginTop: 10 }}>
                    <button
                      className="admin-btn admin-btn-solid admin-btn-sm"
                      type="button"
                      onClick={() => setLicenseSheetOpen(true)}
                    >
                      Open copy panel
                    </button>
                    <button
                      className="admin-btn admin-btn-outline admin-btn-sm"
                      type="button"
                      onClick={() => copyLicenseKey(latestKey)}
                    >
                      Copy key
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3>Share invite link</h3>
                <span className="admin-badge">Free for old clients</span>
              </div>
              <p className="admin-card-meta">
                <strong>One link for both:</strong> email payment bypass (no
                $35.60) <em>and</em> license key claim. Send it to old clients
                from another platform. New clients without this link still pay.
              </p>
              <div className="admin-btn-row" style={{ marginTop: 8 }}>
                <button
                  className="admin-btn admin-btn-solid admin-btn-sm"
                  type="button"
                  disabled={myEas.length === 0 || !licenseBotId}
                  onClick={() => void copyMentorInviteLink()}
                >
                  Copy invite link
                </button>
              </div>
              {inviteLinkPreview ? (
                <p
                  className="ea-hint"
                  style={{
                    marginTop: 10,
                    wordBreak: "break-all",
                    fontSize: 12,
                    opacity: 0.9,
                  }}
                >
                  {inviteLinkPreview}
                </p>
              ) : (
                <p className="ea-hint" style={{ marginTop: 10 }}>
                  The link must include <strong>?invite=</strong> and{" "}
                  <strong>&bot=</strong> — not just apex-ea.com.
                </p>
              )}
            </div>

            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3>Bulk import (CSV)</h3>
                <span className="admin-badge">Migrate clients</span>
              </div>
              <p className="admin-card-meta">
                Already have a list of emails? Upload a CSV with{" "}
                <strong>name,email</strong> (up to 1000 rows). This generates all
                license keys at once, auto-approves those emails, and lets you
                download the keys to send out.
              </p>
              <label className="ea-field">
                <span>CSV file</span>
                <input
                  className="admin-input"
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  disabled={licenseBulkBusy || myEas.length === 0}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    void runBulkLicenseImport(file);
                  }}
                />
              </label>
              <div className="admin-btn-row" style={{ marginTop: 8 }}>
                <button
                  className="admin-btn admin-btn-outline admin-btn-sm"
                  type="button"
                  onClick={() =>
                    downloadTextFile(
                      "apexea-clients-template.csv",
                      "name,email\nSam Smith,sam@email.com\nAlex Lee,alex@email.com\n"
                    )
                  }
                >
                  Download CSV template
                </button>
                {licenseBulkSummary &&
                (licenseBulkSummary.createdCount ||
                  licenseBulkSummary.skippedCount) ? (
                  <button
                    className="admin-btn admin-btn-solid admin-btn-sm"
                    type="button"
                    onClick={() => downloadBulkLicenseCsv(licenseBulkSummary)}
                  >
                    Download keys CSV
                  </button>
                ) : null}
              </div>
              {licenseBulkBusy ? (
                <p className="ea-hint" style={{ marginTop: 10 }}>
                  Importing keys… keep this page open.
                </p>
              ) : null}
              {licenseBulkSummary ? (
                <p className="ea-hint" style={{ marginTop: 10 }}>
                  Created {licenseBulkSummary.createdCount}
                  {licenseBulkSummary.skippedCount
                    ? ` · skipped ${licenseBulkSummary.skippedCount} (already had a key)`
                    : ""}
                  {licenseBulkSummary.errorCount
                    ? ` · ${licenseBulkSummary.errorCount} bad row(s)`
                    : ""}
                  .
                </p>
              ) : null}
            </div>

            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3>Generated keys</h3>
                <span className="admin-badge">{filteredLicenses.length}</span>
              </div>
              <div className="admin-search-row" style={{ marginBottom: 12 }}>
                <input
                  className="admin-input"
                  type="search"
                  value={licenseSearch}
                  onChange={(e) => setLicenseSearch(e.target.value)}
                  placeholder="Search by name, email, or key"
                  aria-label="Search license keys"
                />
              </div>
              {myLicenses.length === 0 ? (
                <p className="admin-empty">No license keys yet</p>
              ) : filteredLicenses.length === 0 ? (
                <p className="admin-empty">No keys match “{licenseSearch.trim()}”</p>
              ) : (
                [...filteredLicenses].reverse().map((entry) => (
                  <div
                    className={`license-row${entry.used ? " is-used" : ""}${
                      isLicenseExpired(entry) ? " is-expired" : ""
                    }`}
                    key={`${entry.key}-${entry.createdAt}`}
                  >
                    <button
                      className="license-row-key"
                      type="button"
                      onClick={() => openLicenseDetail(entry)}
                    >
                      {entry.key}
                    </button>
                    <span>
                      {entry.clientName ? `${entry.clientName} · ` : ""}
                      {entry.clientEmail || "no email"} · {entry.botName} ·{" "}
                      {entry.used ? "Used" : "Available"} · {formatLicenseDuration(entry)} ·{" "}
                      {formatLicenseExpiry(entry)}
                    </span>
                    <div className="license-row-actions">
                      <button
                        className="admin-btn admin-btn-outline admin-btn-sm"
                        type="button"
                        onClick={() => openLicenseDetail(entry)}
                      >
                        View
                      </button>
                      <button
                        className="admin-btn admin-btn-outline admin-btn-sm"
                        type="button"
                        onClick={() => copyLicenseKey(entry.key)}
                      >
                        Copy
                      </button>
                      {isSuperAdmin ? (
                        <button
                          className="admin-btn admin-btn-ghost admin-btn-sm"
                          type="button"
                          onClick={() => void onDeactivateLicense(entry.key)}
                        >
                          {entry.used ? "Deactivate" : "Reset"}
                        </button>
                      ) : null}
                      <button
                        className="admin-btn admin-btn-outline admin-btn-sm"
                        type="button"
                        onClick={() => void onDeleteLicense(entry.key)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        
        {adminPage === "profile" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Profile</h2>
            <p className="admin-sub">
              Edit your mentor details. Your username appears at the top of your clients&apos;
              app.
            </p>
            <div className="admin-card">
              <div className="admin-card-title-row">
                <h3>Account</h3>
                <span className="admin-badge is-approved">{adminSession.status || "approved"}</span>
              </div>
              {!isSuperAdmin ? (
                <form
                  className="license-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (profileBusy) return;
                    const username = String(profileUsername || "").trim();
                    const contact = String(profileContact || "").trim();
                    if (!username) {
                      showToast("Enter a username");
                      return;
                    }
                    setProfileBusy(true);
                    try {
                      const updated = await updateMentorProfile(adminSession.email, {
                        username,
                        contact,
                      });
                      const nextSession = {
                        ...adminSession,
                        username: updated?.username || username,
                      };
                      writeAdminSession(nextSession);
                      setAdminSession(nextSession);
                      setMentors((prev) => {
                        const key = normalizeAdminEmail(adminSession.email);
                        const mapped = prev.map((m) =>
                          normalizeAdminEmail(m.email) === key
                            ? {
                                ...m,
                                username: updated?.username || username,
                                contact: updated?.contact ?? contact,
                              }
                            : m
                        );
                        if (!mapped.some((m) => normalizeAdminEmail(m.email) === key)) {
                          mapped.unshift(updated || { ...adminSession, username, contact });
                        }
                        return mapped;
                      });
                      await refreshLicenses?.();
                      showToast("Profile saved — clients will see your username");
                    } catch (error) {
                      showToast(error.message || "Could not save profile");
                    } finally {
                      setProfileBusy(false);
                    }
                  }}
                >
                  <label className="ea-field">
                    <span>Username</span>
                    <input
                      className="admin-input"
                      value={profileUsername}
                      onChange={(e) => setProfileUsername(e.target.value)}
                      placeholder="Shown on client app header"
                      required
                    />
                  </label>
                  <label className="ea-field">
                    <span>Contact number</span>
                    <input
                      className="admin-input"
                      type="tel"
                      value={profileContact}
                      onChange={(e) => setProfileContact(e.target.value)}
                      placeholder="Phone / WhatsApp"
                    />
                  </label>
                  <label className="ea-field">
                    <span>Email</span>
                    <input className="admin-input" value={adminSession.email || ""} disabled />
                  </label>
                  <p className="admin-card-meta">
                    Role: Mentor · EAs: {myEas.length} · License keys: {myLicenses.length}
                  </p>
                  <button
                    className="admin-btn admin-btn-solid admin-btn-block"
                    type="submit"
                    disabled={profileBusy}
                  >
                    {profileBusy ? "Saving…" : "Save profile"}
                  </button>
                </form>
              ) : (
                <>
                  <p className="admin-card-meta">
                    <strong>Username:</strong> {adminSession.username || "—"}
                  </p>
                  <p className="admin-card-meta">
                    <strong>Email:</strong> {adminSession.email}
                  </p>
                  <p className="admin-card-meta">
                    <strong>Role:</strong> Super admin
                  </p>
                </>
              )}
            </div>
          </section>
        )}

        {adminPage === "settings" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Settings</h2>
            <p className="admin-sub">
              Change the app accent color. Buttons, highlights, and scanner accents update live.
            </p>
            <div className="admin-card">
              <div className="admin-card-title-row">
                <h3>App color</h3>
                <span className="admin-badge">{appColor || DEFAULT_APP_COLOR}</span>
              </div>
              <div className="app-color-preview" style={{ ["--preview-color"]: appColor }}>
                <div className="app-color-preview-orb" aria-hidden="true" />
                <div>
                  <strong>Live preview</strong>
                  <p className="ea-hint">This color drives the app theme on home, lock, and scanner.</p>
                </div>
              </div>
              <label className="ea-field" style={{ marginTop: 14 }}>
                <span>Custom color</span>
                <div className="app-color-picker-row">
                  <input
                    className="app-color-swatch"
                    type="color"
                    value={appColor || DEFAULT_APP_COLOR}
                    onChange={(e) => setAppColor(e.target.value)}
                    aria-label="Choose app color"
                  />
                  <input
                    className="admin-input"
                    type="text"
                    value={appColor || DEFAULT_APP_COLOR}
                    onChange={(e) => setAppColor(e.target.value)}
                    placeholder="#ff2d7a"
                  />
                  <button
                    className="admin-btn admin-btn-outline"
                    type="button"
                    onClick={() => setAppColor(DEFAULT_APP_COLOR)}
                  >
                    Reset
                  </button>
                </div>
              </label>
              <div className="app-color-presets" role="list">
                {APP_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    role="listitem"
                    className={`app-color-preset${
                      String(appColor).toLowerCase() === preset.color ? " is-active" : ""
                    }`}
                    style={{ ["--swatch"]: preset.color }}
                    onClick={() => setAppColor(preset.color)}
                    title={preset.label}
                  >
                    <span className="app-color-preset-dot" aria-hidden="true" />
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="admin-card admin-logout-card">
              <div className="admin-card-title-row">
                <h3>Account</h3>
                <span className="admin-badge">{adminSession.email}</span>
              </div>
              <p className="ea-hint">
                Signed in as {adminSession.username || "mentor"}. Logout returns to the mentor
                sign-in page and keeps you on /admin.
              </p>
              <button
                className="admin-btn admin-btn-danger admin-btn-block admin-settings-logout"
                type="button"
                onClick={logoutAdmin}
              >
                Logout
              </button>
            </div>
          </section>
        )}

        {isSuperAdmin && adminPage === "mentor-keys" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Mentor Keys</h2>
            <p className="admin-sub">
              Edit or add license-key allotments for mentors. Every mentor starts with{" "}
              <strong>{DEFAULT_MENTOR_LICENSE_KEYS}</strong> keys.
            </p>
            <div className="admin-card">
              <div className="admin-search-row" style={{ marginBottom: 12 }}>
                <input
                  className="admin-input"
                  type="search"
                  value={mentorKeySearch}
                  onChange={(e) => setMentorKeySearch(e.target.value)}
                  placeholder="Search mentors by name or email"
                  aria-label="Search mentor keys"
                />
              </div>
              {mentorKeyRows.length === 0 ? (
                <p className="admin-empty">
                  {mentorKeyQuery ? `No mentors match “${mentorKeySearch.trim()}”` : "No mentors yet"}
                </p>
              ) : (
                mentorKeyRows.map(({ mentor, email, allowed, used, remaining }) => {
                  const draft = mentorKeyDraft(email);
                  const setBusy = mentorKeyBusy === `${email}:set`;
                  const addBusy = mentorKeyBusy === `${email}:add`;
                  return (
                    <article className="admin-card" key={email} style={{ marginBottom: 12 }}>
                      <div className="admin-card-title-row">
                        <div>
                          <h3 className="admin-card-title">{mentor.username || email}</h3>
                          <p className="admin-card-meta">{email}</p>
                        </div>
                        <span
                          className={`admin-badge${
                            mentor.status === "approved" ? " is-approved" : " is-pending"
                          }`}
                        >
                          {mentor.status || "pending"}
                        </span>
                      </div>
                      <div className="admin-stat-stack" style={{ marginTop: 10 }}>
                        <article className="admin-stat-card">
                          <p className="admin-stat-label">Allotted</p>
                          <p className="admin-stat-value">{allowed}</p>
                        </article>
                        <article className="admin-stat-card">
                          <p className="admin-stat-label">Generated</p>
                          <p className="admin-stat-value">{used}</p>
                        </article>
                        <article className="admin-stat-card">
                          <p className="admin-stat-label">Remaining</p>
                          <p className="admin-stat-value is-ok">{remaining}</p>
                        </article>
                      </div>
                      <div className="admin-search-row" style={{ marginTop: 12, gap: 8 }}>
                        <label className="ea-field" style={{ flex: 1, margin: 0 }}>
                          <span>Edit total keys</span>
                          <input
                            className="admin-input"
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            placeholder={String(allowed)}
                            value={draft.set}
                            onChange={(e) =>
                              patchMentorKeyDraft(email, { set: e.target.value })
                            }
                          />
                        </label>
                        <button
                          className="admin-btn admin-btn-solid"
                          type="button"
                          style={{ alignSelf: "flex-end" }}
                          disabled={setBusy || addBusy}
                          onClick={() => void saveMentorKeyTotal(email)}
                        >
                          {setBusy ? "Saving…" : "Save total"}
                        </button>
                      </div>
                      <div className="admin-search-row" style={{ marginTop: 10, gap: 8 }}>
                        <label className="ea-field" style={{ flex: 1, margin: 0 }}>
                          <span>Add keys</span>
                          <input
                            className="admin-input"
                            type="number"
                            step="1"
                            inputMode="numeric"
                            placeholder="e.g. 100"
                            value={draft.add}
                            onChange={(e) =>
                              patchMentorKeyDraft(email, { add: e.target.value })
                            }
                          />
                        </label>
                        <button
                          className="admin-btn admin-btn-outline"
                          type="button"
                          style={{ alignSelf: "flex-end" }}
                          disabled={setBusy || addBusy}
                          onClick={() => void addMentorKeys(email)}
                        >
                          {addBusy ? "Adding…" : "Add keys"}
                        </button>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        )}

        {!isSuperAdmin && adminPage === "commission" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Mentor Commission</h2>
            <p className="admin-sub">
              Earn <strong>{COMMISSION_PERCENT}%</strong> when your license key unlocks a paid app
              subscription for the first time. Withdrawals open after {WITHDRAW_MIN_KEYS} qualifying
              unlocks.
            </p>

            <div className="admin-stat-stack">
              <article className="admin-stat-card">
                <p className="admin-stat-label">Paid unlocks</p>
                <p className="admin-stat-value">{soldKeysCount}</p>
              </article>
              <article className="admin-stat-card">
                <p className="admin-stat-label">Commission earned</p>
                <p className="admin-stat-value">${commissionUsd.toFixed(2)}</p>
                <p className="admin-card-meta">R{commissionZar}</p>
              </article>
              <article className="admin-stat-card">
                <p className="admin-stat-label">Withdrawal status</p>
                <p className="admin-stat-value">{canWithdraw ? "Ready" : "Locked"}</p>
                <p className="admin-card-meta">
                  {canWithdraw
                    ? "You can withdraw your commission"
                    : `${keysUntilWithdraw} more unlock${keysUntilWithdraw === 1 ? "" : "s"} to unlock`}
                </p>
              </article>
            </div>

            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3>How it works</h3>
                <span className={`admin-badge${canWithdraw ? " is-approved" : " is-pending"}`}>
                  {canWithdraw ? "Withdrawable" : "Building"}
                </span>
              </div>
              <p className="admin-card-meta">
                As a mentor you get <strong>{COMMISSION_PERCENT}%</strong> for every license key that
                unlocks a <strong>paid</strong> app subscription.
              </p>
              <p className="admin-card-meta">
                Generating a key alone does not pay commission. The client must pay for app access,
                then activate your key on mobile for a robot that is getting access for the{" "}
                <strong>first time</strong>. Keys used on accounts that already had access do not
                count.
              </p>
              <p className="admin-card-meta">
                Commission becomes withdrawable after <strong>{WITHDRAW_MIN_KEYS}</strong> qualifying
                unlocks.
              </p>
            </div>

            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3>Banking details</h3>
                <span className="admin-badge">Payout</span>
              </div>
              <p className="ea-hint">
                Add your banking details so commissions can be paid to you.
              </p>
              <label className="ea-field">
                <span>Account name</span>
                <input
                  className="admin-input"
                  type="text"
                  value={bankingForm.accountName}
                  onChange={(e) =>
                    setBankingForm((prev) => ({ ...prev, accountName: e.target.value }))
                  }
                  placeholder="Full name on the account"
                />
              </label>
              <label className="ea-field">
                <span>Bank name</span>
                <input
                  className="admin-input"
                  type="text"
                  value={bankingForm.bankName}
                  onChange={(e) =>
                    setBankingForm((prev) => ({ ...prev, bankName: e.target.value }))
                  }
                  placeholder="e.g. FNB, Capitec, Standard Bank"
                />
              </label>
              <label className="ea-field">
                <span>Account number</span>
                <input
                  className="admin-input"
                  type="text"
                  inputMode="numeric"
                  value={bankingForm.accountNumber}
                  onChange={(e) =>
                    setBankingForm((prev) => ({ ...prev, accountNumber: e.target.value }))
                  }
                  placeholder="Account number"
                />
              </label>
              <label className="ea-field">
                <span>Branch code</span>
                <input
                  className="admin-input"
                  type="text"
                  value={bankingForm.branchCode}
                  onChange={(e) =>
                    setBankingForm((prev) => ({ ...prev, branchCode: e.target.value }))
                  }
                  placeholder="Optional"
                />
              </label>
              <label className="ea-field">
                <span>Account type</span>
                <input
                  className="admin-input"
                  type="text"
                  value={bankingForm.accountType}
                  onChange={(e) =>
                    setBankingForm((prev) => ({ ...prev, accountType: e.target.value }))
                  }
                  placeholder="Cheque / Savings"
                />
              </label>
              <button
                className="admin-btn admin-btn-solid admin-btn-block"
                type="button"
                disabled={bankingBusy}
                onClick={saveMentorBanking}
                style={{ marginTop: 12 }}
              >
                {bankingBusy ? "Saving…" : "Save banking details"}
              </button>
            </div>
          </section>
        )}

        {!isSuperAdmin && adminPage === "signal-direction" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Add Signal Direction</h2>
            <p className="admin-sub">
              Post a signal direction for the next NFP, PPI, CPI, or FOMC. Clients see it on the
              event day. You can clear, rewrite, or delete the whole message until the event starts
              — then it locks. The direction removes itself the day after.
            </p>
            {(() => {
              const upcomingOfficial = listUpcomingOfficialEvents(new Date(), 10);
              const nextOfficial = getNextOfficialEvent();
              const selectedId = calendarEditingId || nextOfficial?.id || "";
              const selected =
                findOfficialEvent({ id: selectedId }) || nextOfficial || upcomingOfficial[0];
              const locked = selected ? !isSignalDirectionEditable(selected) : true;
              const activeDirections = filterActiveMentorDirections(calendarEvents);
              return (
                <>
                  <div className="admin-card">
                    <div className="admin-card-title-row">
                      <h3>Next client event</h3>
                      <span className="admin-badge is-approved">
                        {nextOfficial ? nextOfficial.title : "None"}
                      </span>
                    </div>
                    {nextOfficial ? (
                      <p className="admin-card-meta">
                        {nextOfficial.title} · {formatEventDay(nextOfficial.date)} ·{" "}
                        {nextOfficial.timeSa || nextOfficial.timeEt} SAST
                      </p>
                    ) : (
                      <p className="admin-empty">No upcoming official events</p>
                    )}
                  </div>

                  <div className="admin-card" style={{ marginTop: 14 }}>
                    <form className="license-form" onSubmit={saveCalendarEvent}>
                      <label className="ea-field">
                        <span>Event *</span>
                        <select
                          className="admin-input"
                          value={selected?.id || ""}
                          onChange={(e) => {
                            const official = findOfficialEvent({ id: e.target.value });
                            if (!official) return;
                            selectOfficialSignalEvent(
                              official,
                              getMentorSignalForEvent(official, calendarEvents) ||
                                activeDirections.find(
                                  (row) =>
                                    row.id === official.id ||
                                    row.officialEventId === official.id
                                )?.directions ||
                                ""
                            );
                          }}
                          required
                        >
                          {upcomingOfficial.map((event) => (
                            <option key={event.id} value={event.id}>
                              {event.title} — {formatEventDay(event.date)} ·{" "}
                              {event.timeSa || event.timeEt} SAST
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="ea-field">
                        <span>Signal direction *</span>
                        <textarea
                          className="admin-input"
                          rows={5}
                          value={calendarDirections}
                          onChange={(e) => onSignalDirectionsChange(e.target.value)}
                          placeholder="Write your own signal — clear any old text and type a new one…"
                          readOnly={locked}
                          aria-readonly={locked}
                          inputMode="text"
                          enterKeyHint="done"
                          autoComplete="off"
                          required
                        />
                      </label>
                      <div className="license-row-actions" style={{ marginTop: 8 }}>
                        <button
                          className="admin-btn admin-btn-outline admin-btn-sm"
                          type="button"
                          disabled={locked || calendarBusy || !String(calendarDirections || "").trim()}
                          onClick={clearSignalDirections}
                        >
                          Clear text
                        </button>
                      </div>
                      <p className="ea-hint">
                        {selected ? formatSignalLockLabel(selected) : ""} Clear or rewrite the full
                        message anytime before the event. Directions auto-remove the day after.
                      </p>
                      <button
                        className="admin-btn admin-btn-solid admin-btn-block"
                        type="submit"
                        disabled={calendarBusy || !selected || locked}
                      >
                        {calendarBusy
                          ? "Saving…"
                          : locked
                            ? "Editing locked (event started)"
                            : calendarDirections.trim()
                              ? "Save signal direction"
                              : "Add signal direction"}
                      </button>
                    </form>
                  </div>

                  <div className="admin-card" style={{ marginTop: 14 }}>
                    <div className="admin-card-title-row">
                      <h3>Active signal directions</h3>
                      <span className="admin-badge">{activeDirections.length}</span>
                    </div>
                    {activeDirections.length === 0 ? (
                      <p className="admin-empty">No active signal directions</p>
                    ) : (
                      activeDirections
                        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
                        .map((event) => {
                          const official =
                            findOfficialEvent({
                              id: event.officialEventId || event.id,
                              date: event.date,
                              title: event.title,
                            }) || event;
                          return (
                            <div className="license-row" key={event.id}>
                              <strong>
                                {event.title} · {formatEventDay(event.date)}
                              </strong>
                              <span>{event.directions?.slice(0, 140) || "No direction"}</span>
                              <div className="license-row-actions">
                                <button
                                  className="admin-btn admin-btn-outline admin-btn-sm"
                                  type="button"
                                  disabled={!isSignalDirectionEditable(official)}
                                  onClick={() => {
                                    selectOfficialSignalEvent(
                                      {
                                        id: official.id || event.id,
                                        date: official.date || event.date,
                                        title: official.title || event.title,
                                      },
                                      event.directions || ""
                                    );
                                  }}
                                >
                                  {isSignalDirectionEditable(official) ? "Edit" : "Locked"}
                                </button>
                                <button
                                  className="admin-btn admin-btn-ghost admin-btn-sm"
                                  type="button"
                                  disabled={
                                    calendarBusy || !isSignalDirectionEditable(official)
                                  }
                                  onClick={() => void onDeleteCalendarEvent(event.id)}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          );
                        })
                    )}
                  </div>
                </>
              );
            })()}
          </section>
        )}

        {!isSuperAdmin && adminPage === "self-hosting" && (
          <section className="admin-page is-active">
            <div className="admin-card self-host-card">
              <h2 className="admin-h1 self-host-title">SELF HOSTING</h2>
              <p className="admin-sub">
                Place a trade and automatically send it to your connected robot clients.
                Stop loss and take profit are optional.
              </p>

              <form
                className="license-form self-host-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (hostBusy) return;
                  const symbol = String(hostSymbol || "").trim().toUpperCase();
                  const volume = Number(hostVolume);
                  if (!symbol) {
                    showToast("Enter a symbol");
                    return;
                  }
                  if (!Number.isFinite(volume) || volume <= 0) {
                    showToast("Enter a valid lot size");
                    return;
                  }
                  if (!hostAccounts.length) {
                    showToast("No connected robot clients yet");
                    return;
                  }
                  setHostResult(null);
                  setHostDetailsOpen(false);
                  setHostConfirmOpen(true);
                }}
              >
                <label className="ea-field">
                  <span>Symbol</span>
                  <input
                    className="admin-input"
                    value={hostSymbol}
                    onChange={(e) => setHostSymbol(e.target.value.toUpperCase())}
                    placeholder="XAUUSD"
                    required
                  />
                </label>

                <div className="ea-field">
                  <span>Direction</span>
                  <div className="self-host-side-row" role="group" aria-label="Direction">
                    <button
                      type="button"
                      className={`self-host-side-btn${hostSide === "BUY" ? " is-active is-buy" : ""}`}
                      onClick={() => setHostSide("BUY")}
                    >
                      BUY
                    </button>
                    <button
                      type="button"
                      className={`self-host-side-btn${hostSide === "SELL" ? " is-active is-sell" : ""}`}
                      onClick={() => setHostSide("SELL")}
                    >
                      SELL
                    </button>
                  </div>
                </div>

                <label className="ea-field">
                  <span>Lot Size</span>
                  <input
                    className="admin-input"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={hostVolume}
                    onChange={(e) => setHostVolume(e.target.value)}
                    placeholder="0.01"
                    required
                  />
                </label>

                <label className="ea-field">
                  <span>Stop Loss (optional)</span>
                  <input
                    className="admin-input"
                    type="number"
                    step="any"
                    value={hostSl}
                    onChange={(e) => setHostSl(e.target.value)}
                    placeholder="SL price"
                  />
                </label>

                <label className="ea-field">
                  <span>Take Profit (optional)</span>
                  <input
                    className="admin-input"
                    type="number"
                    step="any"
                    value={hostTp}
                    onChange={(e) => setHostTp(e.target.value)}
                    placeholder="TP price"
                  />
                </label>

                <div className="self-host-status">
                  <p className="self-host-status-label">CONNECTED ROBOT CLIENTS</p>
                  <p className="self-host-status-value">
                    <span className={`self-host-dot${hostAccounts.length ? " is-on" : ""}`} />
                    {hostLoading && !hostAccounts.length
                      ? "Checking connections…"
                      : `${hostAccounts.length} client${hostAccounts.length === 1 ? "" : "s"} connected`}
                  </p>
                </div>

                <button
                  className="admin-btn admin-btn-solid admin-btn-block self-host-execute"
                  type="submit"
                  disabled={hostBusy || !hostAccounts.length}
                >
                  EXECUTE TRADE
                </button>
              </form>
            </div>

            {hostResult ? (
              <div className="admin-card self-host-result-card">
                <p className="self-host-result-eyebrow">TRADE EXECUTED</p>
                <p className="self-host-result-headline">
                  {hostResult.side || hostSide} {hostResult.symbol || hostSymbol}
                </p>
                <p className="self-host-result-lot">
                  {Number(hostResult.volume || hostVolume || 0).toFixed(2)} LOT
                </p>
                <div className="self-host-result-stats">
                  <p>
                    <strong>{Number(hostResult.targeted || hostResult.connected || 0)}</strong>{" "}
                    clients targeted
                  </p>
                  <p>
                    <strong>{Number(hostResult.placed || 0)}</strong> trades executed
                  </p>
                  <p>
                    <strong>{Number(hostResult.offline || hostResult.failed || 0)}</strong> client
                    offline
                  </p>
                </div>
                {Array.isArray(hostResult.results) && hostResult.results.length ? (
                  <button
                    type="button"
                    className="admin-btn admin-btn-outline admin-btn-sm"
                    onClick={() => setHostDetailsOpen((v) => !v)}
                  >
                    {hostDetailsOpen ? "Hide details" : "View details"}
                  </button>
                ) : null}
                {hostDetailsOpen ? (
                  <ul className="self-host-detail-list">
                    {hostResult.results.map((row, idx) => (
                      <li key={`${row.accountId || row.email || "row"}-${idx}`}>
                        <strong>{row.email || "client"}</strong>
                        <span>
                          {row.ok
                            ? `Executed · ${row.side || hostResult.side} ${row.symbol || hostResult.symbol}`
                            : row.error || "Offline"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <div className="admin-card self-host-recent-card">
              <h3 className="self-host-recent-title">Recent Trades</h3>
              {hostRecent.length === 0 ? (
                <p className="admin-card-meta">No recent self-hosted trades yet.</p>
              ) : (
                <ul className="self-host-recent-list">
                  {hostRecent.map((row) => (
                    <li key={row.id}>
                      <p className="self-host-recent-main">
                        {row.side} {row.symbol}
                      </p>
                      <p className="self-host-recent-meta">
                        {Number(row.volume || 0).toFixed(2)} LOT
                      </p>
                      <p className="self-host-recent-meta">
                        {row.targeted} clients
                        <br />
                        {row.placed} executed
                        {row.offline ? ` · ${row.offline} offline` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {hostConfirmOpen ? (
              <div className="self-host-modal-backdrop" role="presentation">
                <div
                  className="admin-card self-host-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Confirm trade"
                >
                  <p className="self-host-modal-question">
                    Execute this trade for all connected clients?
                  </p>
                  <p className="self-host-modal-trade">
                    {hostSide} {String(hostSymbol || "").trim().toUpperCase()}
                  </p>
                  <p className="self-host-modal-meta">Lot: {hostVolume}</p>
                  <p className="self-host-modal-meta">
                    SL: {String(hostSl || "").trim() || "None"}
                  </p>
                  <p className="self-host-modal-meta">
                    TP: {String(hostTp || "").trim() || "None"}
                  </p>
                  <p className="self-host-modal-meta">
                    {hostAccounts.length} connected client
                    {hostAccounts.length === 1 ? "" : "s"}
                  </p>
                  <div className="self-host-modal-actions">
                    <button
                      type="button"
                      className="admin-btn admin-btn-outline"
                      disabled={hostBusy}
                      onClick={() => setHostConfirmOpen(false)}
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      className="admin-btn admin-btn-solid"
                      disabled={hostBusy}
                      onClick={async () => {
                        if (hostBusy) return;
                        const symbol = String(hostSymbol || "").trim().toUpperCase();
                        const rawSl = Number(hostSl);
                        const rawTp = Number(hostTp);
                        const stopLoss =
                          Number.isFinite(rawSl) && rawSl > 0 ? rawSl : null;
                        const takeProfit =
                          Number.isFinite(rawTp) && rawTp > 0 ? rawTp : null;
                        const volume = Number(hostVolume);
                        setHostBusy(true);
                        try {
                          const result = await executeMentorSelfHostTrade({
                            mentorEmail: adminSession.email,
                            symbol,
                            side: hostSide,
                            volume: Number.isFinite(volume) && volume > 0 ? volume : 0.01,
                            stopLoss,
                            takeProfit,
                            comment: "mentor~APEXEA",
                          });
                          setHostResult(result);
                          setHostConfirmOpen(false);
                          const entry = {
                            id: `${Date.now()}-${symbol}-${hostSide}`,
                            at: Date.now(),
                            symbol: result.symbol || symbol,
                            side: result.side || hostSide,
                            volume: result.volume || volume,
                            stopLoss,
                            takeProfit,
                            targeted: Number(result.targeted || result.connected || 0),
                            placed: Number(result.placed || 0),
                            offline: Number(result.offline || result.failed || 0),
                          };
                          setHostRecent(saveSelfHostRecent(adminSession.email, entry));
                          const placed = Number(result?.placed || 0);
                          if (placed > 0) {
                            showToast(
                              `Executed ${placed} trade${placed === 1 ? "" : "s"} for connected clients`
                            );
                          } else {
                            showToast(result?.error || "No trades were placed");
                          }
                        } catch (error) {
                          showToast(error.message || "Could not execute trade");
                          setHostResult(error.data || { error: error.message });
                          setHostConfirmOpen(false);
                        } finally {
                          setHostBusy(false);
                        }
                      }}
                    >
                      {hostBusy ? "EXECUTING…" : "EXECUTE TRADE"}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        )}

        {isSuperAdmin && adminPage === "commissions" && (
          <section className="admin-page is-active">
            <div className="admin-title-row">
              <h2 className="admin-h1">Mentor Commissions</h2>
            </div>
            <p className="admin-sub">
              Track paid first-time unlocks ({COMMISSION_PERCENT}% each), and banking details so you
              can pay commissions. Generated-only keys and reuse on already-unlocked accounts do not
              count.
            </p>
            <div className="admin-search-row" style={{ marginBottom: 12 }}>
              <input
                className="admin-input"
                type="search"
                value={commissionSearch}
                onChange={(e) => setCommissionSearch(e.target.value)}
                placeholder="Search mentor by name, email, or phone"
                aria-label="Search mentors"
              />
            </div>
            {commissionRows.length === 0 ? (
              <div className="admin-card">
                <p className="admin-empty">No approved mentors yet</p>
              </div>
            ) : filteredCommissionRows.length === 0 ? (
              <div className="admin-card">
                <p className="admin-empty">
                  No mentors match “{commissionSearch.trim()}”
                </p>
              </div>
            ) : (
              filteredCommissionRows.map(({ mentor, sold, usd, zar, withdrawable, banking }) => {
                const hasBanking = Boolean(
                  banking?.accountName && banking?.bankName && banking?.accountNumber
                );
                return (
                  <div className="admin-card" style={{ marginTop: 14 }} key={mentor.id || mentor.email}>
                    <div className="admin-card-title-row">
                      <h3>{mentor.username || "Mentor"}</h3>
                      <span className={`admin-badge${withdrawable ? " is-approved" : " is-pending"}`}>
                        {withdrawable ? "Payable" : "Building"}
                      </span>
                    </div>
                    <p className="admin-card-meta">{mentor.email}</p>
                    <p className="admin-card-meta">{mentor.contact || "No contact number"}</p>
                    <p className="admin-card-meta">
                      <strong>Paid unlocks:</strong> {sold}
                    </p>
                    <p className="admin-card-meta">
                      <strong>Commission:</strong> ${usd.toFixed(2)} (R{zar})
                    </p>
                    <p className="admin-card-meta">
                      <strong>Withdrawal:</strong>{" "}
                      {withdrawable
                        ? "Ready (5+ paid unlocks)"
                        : `${Math.max(0, WITHDRAW_MIN_KEYS - sold)} more needed`}
                    </p>
                    <div className="admin-commission-bank" style={{ marginTop: 10 }}>
                      <strong>Banking</strong>
                      {hasBanking ? (
                        <>
                          <p className="admin-card-meta">
                            <strong>Name:</strong> {banking.accountName}
                          </p>
                          <p className="admin-card-meta">
                            <strong>Bank:</strong> {banking.bankName}
                          </p>
                          <p className="admin-card-meta">
                            <strong>Account:</strong> {banking.accountNumber}
                          </p>
                          {banking.branchCode ? (
                            <p className="admin-card-meta">
                              <strong>Branch:</strong> {banking.branchCode}
                            </p>
                          ) : null}
                          {banking.accountType ? (
                            <p className="admin-card-meta">
                              <strong>Type:</strong> {banking.accountType}
                            </p>
                          ) : null}
                        </>
                      ) : (
                        <p className="admin-empty">Mentor has not added banking details yet</p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        )}

        {isSuperAdmin && adminPage === "mentors" && (
          <section className="admin-page is-active">
            <div className="admin-title-row">
              <h2 className="admin-h1">Mentor Management</h2>
              <button
                className="admin-btn admin-btn-outline admin-btn-sm"
                type="button"
                onClick={() => setBypassOpen((open) => !open)}
              >
                Bypass
              </button>
            </div>
            <p className="admin-sub">
              Mentor signups land in Pending here until you approve them.
            </p>

            <div className="admin-toolbar admin-mentor-mgmt-toolbar">
              <input
                className="admin-input"
                type="search"
                value={mentorMgmtSearch}
                onChange={(e) => setMentorMgmtSearch(e.target.value)}
                placeholder="Search mentors by name or email"
                aria-label="Search mentors by name or email"
              />
              <button
                className="admin-btn admin-btn-solid admin-btn-sm"
                type="button"
                disabled={mentorBulkBusy || filteredPendingMentors.length === 0}
                onClick={bulkApprovePendingMentors}
              >
                {mentorBulkBusy
                  ? "Approving…"
                  : `Bulk Approve${
                      filteredPendingMentors.length
                        ? ` (${filteredPendingMentors.length})`
                        : ""
                    }`}
              </button>
            </div>

            {bypassOpen ? (
              <div className="admin-card admin-bypass-card">
                <div className="admin-card-title-row">
                  <h3 className="admin-card-title">Payment bypass</h3>
                  <button
                    className="admin-btn admin-btn-ghost admin-btn-sm"
                    type="button"
                    onClick={() => setBypassOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <p className="admin-card-meta">
                  Enter a client email, then choose what to bypass without PayPal.
                </p>
                <label className="ea-field">
                  <span>Email</span>
                  <input
                    className="admin-input"
                    type="email"
                    value={bypassEmail}
                    onChange={(e) => setBypassEmail(e.target.value)}
                    placeholder="client@email.com"
                  />
                </label>
                <div className="admin-bypass-actions">
                  <button
                    className="admin-btn admin-btn-solid admin-btn-block"
                    type="button"
                    disabled={bypassBusy}
                    onClick={async () => {
                      setBypassBusy(true);
                      try {
                        await bypassAppAccess?.(bypassEmail);
                      } finally {
                        setBypassBusy(false);
                      }
                    }}
                  >
                    App access bypass
                  </button>
                  <button
                    className="admin-btn admin-btn-outline admin-btn-block"
                    type="button"
                    disabled={bypassBusy}
                    onClick={async () => {
                      setBypassBusy(true);
                      try {
                        await bypassPremiumScanner?.(bypassEmail);
                      } finally {
                        setBypassBusy(false);
                      }
                    }}
                  >
                    Premium scanner bypass
                  </button>
                </div>
              </div>
            ) : null}

            <div className="admin-card">
              <div className="admin-card-title-row">
                <h3 className="admin-card-title">Pending</h3>
                <span className="admin-badge is-pending">
                  {mentorMgmtQuery
                    ? `${filteredPendingMentors.length}/${pendingMentors.length}`
                    : pendingMentors.length}
                </span>
              </div>
              <button
                className="admin-btn admin-btn-sm"
                type="button"
                style={{ marginBottom: 10 }}
                onClick={refreshMentorsList}
              >
                Refresh pending
              </button>
              {pendingMentors.length === 0 ? (
                <p className="admin-empty">No pending mentors</p>
              ) : filteredPendingMentors.length === 0 ? (
                <p className="admin-empty">
                  No pending mentors match “{mentorMgmtSearch.trim()}”
                </p>
              ) : (
                filteredPendingMentors.map((mentor) => (
                  <div className="admin-table-row has-actions" key={mentor.id || mentor.email}>
                    <div>
                      <strong>{mentor.username}</strong>
                      <p className="admin-card-meta">{mentor.email}</p>
                      <p className="admin-card-meta">{mentor.contact || "—"}</p>
                    </div>
                    <div className="admin-row-actions">
                      <button
                        className="admin-btn admin-btn-solid admin-btn-sm"
                        type="button"
                        onClick={() => changeMentorStatus(mentor.email, "approved")}
                      >
                        Approve
                      </button>
                      <button
                        className="admin-btn admin-btn-danger admin-btn-sm"
                        type="button"
                        onClick={() => changeMentorStatus(mentor.email, "declined")}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3 className="admin-card-title">Approved</h3>
                <span className="admin-badge is-approved">
                  {mentorMgmtQuery
                    ? `${filteredApprovedMentors.length}/${approvedMentors.length}`
                    : approvedMentors.length}
                </span>
              </div>
              {approvedMentors.length === 0 ? (
                <p className="admin-empty">No approved mentors</p>
              ) : filteredApprovedMentors.length === 0 ? (
                <p className="admin-empty">
                  No approved mentors match “{mentorMgmtSearch.trim()}”
                </p>
              ) : (
                filteredApprovedMentors.map((mentor) => (
                  <div className="admin-table-row has-actions" key={mentor.id || mentor.email}>
                    <div>
                      <strong>{mentor.username}</strong>
                      <p className="admin-card-meta">{mentor.email}</p>
                      <p className="admin-card-meta">
                        {mentor.role === "superadmin" ? "Super admin" : mentor.contact || "—"}
                      </p>
                      {mentor.role !== "superadmin" ? (
                        <p className="admin-card-meta">
                          Paid unlocks: {countSoldKeysForMentor(mentor)} ·{" "}
                          {mentor.banking?.accountNumber
                            ? `${mentor.banking.bankName || "Bank"} · ${mentor.banking.accountNumber}`
                            : "No banking details"}
                        </p>
                      ) : null}
                    </div>
                    <div className="admin-row-actions">
                      {mentor.role === "superadmin" ? (
                        <span className="admin-badge is-approved">{mentor.status}</span>
                      ) : (
                        <>
                          <span className="admin-badge is-approved">{mentor.status}</span>
                          <button
                            className="admin-btn admin-btn-danger admin-btn-sm"
                            type="button"
                            onClick={() => changeMentorStatus(mentor.email, "declined")}
                          >
                            Decline
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="admin-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3 className="admin-card-title">Declined</h3>
                <span className="admin-badge is-declined">
                  {mentorMgmtQuery
                    ? `${filteredDeclinedMentors.length}/${declinedMentors.length}`
                    : declinedMentors.length}
                </span>
              </div>
              {declinedMentors.length === 0 ? (
                <p className="admin-empty">No declined mentors</p>
              ) : filteredDeclinedMentors.length === 0 ? (
                <p className="admin-empty">
                  No declined mentors match “{mentorMgmtSearch.trim()}”
                </p>
              ) : (
                filteredDeclinedMentors.map((mentor) => (
                  <div className="admin-table-row has-actions" key={mentor.id || mentor.email}>
                    <div>
                      <strong>{mentor.username}</strong>
                      <p className="admin-card-meta">{mentor.email}</p>
                      <p className="admin-card-meta">{mentor.contact || "—"}</p>
                    </div>
                    <div className="admin-row-actions">
                      <button
                        className="admin-btn admin-btn-solid admin-btn-sm"
                        type="button"
                        onClick={() => changeMentorStatus(mentor.email, "approved")}
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {isSuperAdmin && ["top-mentors", "emails"].includes(adminPage) && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">
              {adminPage === "top-mentors" ? "Top Mentors" : "Email Management"}
            </h2>
            <p className="admin-sub">Starts empty — new data appears as clients sign up.</p>
            <div className="admin-card">
              <p className="admin-empty">No records yet</p>
            </div>
          </section>
        )}
      </div>

      {licenseSheetOpen && latestKey ? (
        <div className="license-side-sheet" role="dialog" aria-modal="true" aria-label="License details">
          <button
            className="license-side-backdrop"
            type="button"
            aria-label="Close"
            onClick={() => setLicenseSheetOpen(false)}
          />
          <aside className="license-side-panel">
            <div className="license-side-header">
              <h2>License details</h2>
              <button
                className="license-side-close"
                type="button"
                aria-label="Close"
                onClick={() => setLicenseSheetOpen(false)}
              >
                ×
              </button>
            </div>
            <code className="license-side-key">{latestKey}</code>
            <div className="license-side-meta">
              <p>
                <span>Client</span>
                <strong>{latestLicenseMeta?.name || "—"}</strong>
              </p>
              <p>
                <span>Email</span>
                <strong>{latestLicenseMeta?.email || "—"}</strong>
              </p>
              <p>
                <span>Bot</span>
                <strong>{latestLicenseMeta?.botName || "—"}</strong>
              </p>
              <p>
                <span>Status</span>
                <strong>
                  {latestLicenseMeta?.expired
                    ? "Expired"
                    : latestLicenseMeta?.status || "—"}
                </strong>
              </p>
              <p>
                <span>Duration</span>
                <strong>{latestLicenseMeta?.duration || "—"}</strong>
              </p>
              <p>
                <span>Expiry</span>
                <strong>{latestLicenseMeta?.expiry || "—"}</strong>
              </p>
              <p>
                <span>Created</span>
                <strong>
                  {latestLicenseMeta?.createdAt
                    ? new Date(latestLicenseMeta.createdAt).toLocaleString()
                    : "—"}
                </strong>
              </p>
              <p>
                <span>Used at</span>
                <strong>
                  {latestLicenseMeta?.usedAt
                    ? new Date(latestLicenseMeta.usedAt).toLocaleString()
                    : "Not used yet"}
                </strong>
              </p>
              {(latestLicenseMeta?.mentorName || latestLicenseMeta?.mentorEmail) && (
                <p>
                  <span>Mentor</span>
                  <strong>
                    {[latestLicenseMeta?.mentorName, latestLicenseMeta?.mentorEmail]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </strong>
                </p>
              )}
            </div>
            <button
              className="admin-btn admin-btn-solid admin-btn-block"
              type="button"
              onClick={() => copyLicenseKey(latestKey)}
            >
              Copy license key
            </button>
            {isSuperAdmin ? (
              <button
                className="admin-btn admin-btn-outline admin-btn-block"
                type="button"
                onClick={() => void onDeactivateLicense(latestKey)}
              >
                {latestLicenseMeta?.status === "Used" ? "Deactivate key" : "Reset key"}
              </button>
            ) : null}
            <button
              className="admin-btn admin-btn-ghost admin-btn-block"
              type="button"
              onClick={() => void onDeleteLicense(latestKey)}
            >
              Delete key
            </button>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
