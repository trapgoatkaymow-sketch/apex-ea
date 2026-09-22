import { useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl } from "./apiOrigin.js";
import AdminAuth from "./AdminAuth.jsx";
import {
  COMMISSION_PERCENT,
  COMMISSION_USD,
  COMMISSION_ZAR,
  DEFAULT_MENTOR_LICENSE_KEYS,
  fetchMentorActivityRemote,
  fetchMentors,
  setMentorAccountPassword,
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
  normalizeLicenseKey,
  reconcileCommissionRemote,
  resolveLicenseExpiry,
  resendLicenseEmailRemote,
} from "./licensesApi.js";
import { sendBroadcastEmailsRemote, requestCommissionWithdrawalRemote, sendMentorPayoutDoneRemote, fetchWithdrawQuotaRemote, WITHDRAWAL_REQUEST_EMAIL, WITHDRAW_MAX_PER_WEEK } from "./emailsApi.js";
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
import { APP_COLOR_PRESETS, DEFAULT_APP_COLOR, normalizeHexColor } from "./theme.js";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";

const ADMIN_SESSION_KEY = "apexea-admin-session";
const PORTAL_THEME_KEY = "apexea-portal-theme";
const SELF_HOST_RECENT_KEY = "apexea-self-host-recent-v1";

/** Small spinner + label for portal action buttons. */
function AdminBusyLabel({ busy, children, busyText }) {
  return (
    <>
      {busy ? <span className="admin-btn-spinner" aria-hidden="true" /> : null}
      <span>{busy ? busyText || children : children}</span>
    </>
  );
}

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

function formatGraceCountdown(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
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
    clearAppAccessBypass,
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
    deactivateLicense,
    resetClientScans,
    deleteLicense,
    refreshLicenses,
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
  const [licenseGenBusy, setLicenseGenBusy] = useState(false);
  const [licenseActionBusy, setLicenseActionBusy] = useState("");
  const [eaBusy, setEaBusy] = useState(false);
  const [eaDeleteBusy, setEaDeleteBusy] = useState("");
  const [eaDeleteConfirm, setEaDeleteConfirm] = useState(null);
  const [eaDeleteEmail, setEaDeleteEmail] = useState("");
  const [signupActionBusy, setSignupActionBusy] = useState("");
  const [mentorActionBusy, setMentorActionBusy] = useState("");
  const [refreshBusy, setRefreshBusy] = useState("");
  const [commissionSearch, setCommissionSearch] = useState("");
  const [mentorMgmtSearch, setMentorMgmtSearch] = useState("");
  const [mentorBulkBusy, setMentorBulkBusy] = useState(false);
  const [clientMgmtSearch, setClientMgmtSearch] = useState("");
  const [clientBulkBusy, setClientBulkBusy] = useState(false);
  const [emailSearch, setEmailSearch] = useState("");
  const [emailSelected, setEmailSelected] = useState({});
  const [emailSubject, setEmailSubject] = useState("");
  const [emailMessage, setEmailMessage] = useState("");
  const [emailMode, setEmailMode] = useState("message");
  const [emailSendBusy, setEmailSendBusy] = useState(false);
  const [mentorKeySearch, setMentorKeySearch] = useState("");
  const [mentorKeyDrafts, setMentorKeyDrafts] = useState({});
  const [mentorKeyBusy, setMentorKeyBusy] = useState("");
  const [draftAppColor, setDraftAppColor] = useState(() =>
    normalizeHexColor(DEFAULT_APP_COLOR)
  );
  const [appColorSaveBusy, setAppColorSaveBusy] = useState(false);
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
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [reactivateKey, setReactivateKey] = useState("");
  const [reactivateBusy, setReactivateBusy] = useState(false);
  const [bypassOpen, setBypassOpen] = useState(false);
  const [bypassEmail, setBypassEmail] = useState("");
  const [bypassBusy, setBypassBusy] = useState(false);
  const [topMentorEmailsOpen, setTopMentorEmailsOpen] = useState("");
  const [bankingForm, setBankingForm] = useState({
    accountName: "",
    bankName: "",
    accountNumber: "",
    branchCode: "",
    accountType: "",
  });
  const [bankingBusy, setBankingBusy] = useState(false);
  const [withdrawRequestBusy, setWithdrawRequestBusy] = useState(false);
  const [withdrawQuota, setWithdrawQuota] = useState(null);
  const [payoutEmailBusy, setPayoutEmailBusy] = useState("");
  const [mentorActivity, setMentorActivity] = useState(null);
  const [activityTick, setActivityTick] = useState(0);
  const [hostSymbol, setHostSymbol] = useState("XAUUSD");
  const [hostSide, setHostSide] = useState("BUY");
  const [hostTradesCount, setHostTradesCount] = useState("1");
  const [hostVolume, setHostVolume] = useState("0.01");
  const [hostSl, setHostSl] = useState("");
  const [hostTp, setHostTp] = useState("");
  const [hostAccounts, setHostAccounts] = useState([]);
  const [hostLoading, setHostLoading] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostConfirmOpen, setHostConfirmOpen] = useState(false);
  const [hostDelaySec, setHostDelaySec] = useState(0);
  const [hostScheduled, setHostScheduled] = useState(null);
  const [hostScheduleTick, setHostScheduleTick] = useState(0);
  const hostScheduleTimerRef = useRef(null);
  const [hostResult, setHostResult] = useState(null);
  const [hostDetailsOpen, setHostDetailsOpen] = useState(false);
  const [hostRecent, setHostRecent] = useState([]);
  const [profileUsername, setProfileUsername] = useState("");
  const [profileContact, setProfileContact] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [mentorPasswordDrafts, setMentorPasswordDrafts] = useState({});
  const [mentorPasswordBusy, setMentorPasswordBusy] = useState("");

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

  async function onDeactivateLicense(key, extras = {}) {
    if (!isSuperAdmin) {
      showToast("Only super admin can activate used license keys");
      return;
    }
    const actionKey = `deactivate:${key}`;
    if (licenseActionBusy) return;
    setLicenseActionBusy(actionKey);
    try {
      const result = await deactivateLicense?.(key, {
        adminEmail: adminSession?.email || "",
        clientEmail: extras.clientEmail || "",
        clientName: extras.clientName || "",
        botId: extras.botId || licenseBotId || "",
        botName:
          extras.botName ||
          myEas.find((b) => b.id === (extras.botId || licenseBotId))?.name ||
          "",
      });
      if (result) {
        await refreshLicenses?.();
        if (latestKey === key) setLicenseSheetOpen(true);
      }
      return result;
    } finally {
      setLicenseActionBusy("");
    }
  }

  async function onResetClientScans(key) {
    if (!isSuperAdmin) {
      showToast("Only super admin can reset client daily charts");
      return;
    }
    const actionKey = `reset-scans:${key}`;
    if (licenseActionBusy) return;
    setLicenseActionBusy(actionKey);
    try {
      const result = await resetClientScans?.(key, {
        adminEmail: adminSession?.email || "",
      });
      if (result) await refreshLicenses?.();
      return result;
    } finally {
      setLicenseActionBusy("");
    }
  }

  async function onReactivateLicenseSubmit(event) {
    event.preventDefault();
    if (!isSuperAdmin) {
      showToast("Only super admin can reactivate license keys");
      return;
    }
    const key = String(reactivateKey || "").trim();
    if (!key) {
      showToast("Enter a license key to reactivate");
      return;
    }
    if (reactivateBusy || licenseActionBusy) return;
    setReactivateBusy(true);
    try {
      const result = await onDeactivateLicense(key, {
        botId: licenseBotId,
      });
      if (result) {
        setReactivateKey("");
        setReactivateOpen(false);
        openLicenseDetail(result);
      }
    } finally {
      setReactivateBusy(false);
    }
  }

  async function onDeleteLicense(key) {
    const label = String(key || "").trim();
    if (!label) return;
    const ok = window.confirm(`Delete license ${label}? This cannot be undone.`);
    if (!ok) return;
    const actionKey = `delete:${key}`;
    if (licenseActionBusy) return;
    setLicenseActionBusy(actionKey);
    try {
      const deleted = await deleteLicense?.(key);
      if (deleted && latestKey === key) {
        setLatestKey("");
        setLatestLicenseMeta(null);
        setLicenseSheetOpen(false);
      }
    } finally {
      setLicenseActionBusy("");
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
    // Client Management only lists paid or payment-bypassed accounts.
    const list = [...(signups || [])]
      .filter((s) => Boolean(s?.accessPaid) || Boolean(s?.accessBypassed))
      .sort((a, b) => {
        const aAt =
          Number(a.accessBypassedAt) ||
          Number(a.accessPaidAt) ||
          Number(a.createdAt) ||
          0;
        const bAt =
          Number(b.accessBypassedAt) ||
          Number(b.accessPaidAt) ||
          Number(b.createdAt) ||
          0;
        return bAt - aAt;
      });
    if (!clientMgmtQuery) return list;
    return list.filter((s) =>
      String(s?.email || "")
        .toLowerCase()
        .includes(clientMgmtQuery)
    );
  }, [signups, clientMgmtQuery]);

  const filteredPaidClients = useMemo(
    () =>
      filteredClients.filter(
        (s) => Boolean(s?.accessPaid) && !Boolean(s?.accessBypassed)
      ),
    [filteredClients]
  );

  const filteredBypassClients = useMemo(
    () => filteredClients.filter((s) => Boolean(s?.accessBypassed)),
    [filteredClients]
  );

  /** Full totals for Admin Dashboard (ignore Client Management search). */
  const paidRealClientsTotal = useMemo(
    () =>
      (signups || []).filter(
        (s) => Boolean(s?.accessPaid) && !Boolean(s?.accessBypassed)
      ).length,
    [signups]
  );

  const filteredPendingClients = useMemo(
    () =>
      (signups || []).filter(
        (s) => String(s?.status || "").toLowerCase() === "pending"
      ),
    [signups]
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

  // Union of Cover Lock signups + mentor license clients (unique by email).
  const emailClients = useMemo(() => {
    const map = new Map();

    for (const row of licenseKeys || []) {
      const email = normalizeAdminEmail(row?.clientEmail);
      if (!email || !email.includes("@")) continue;
      const prev = map.get(email) || {
        email,
        name: "",
        mentors: [],
        mentorEmails: [],
        keys: 0,
        latestKey: "",
        latestLicense: null,
        signupStatus: "",
        fromLicense: false,
        fromSignup: false,
      };
      const name = String(row?.clientName || "").trim();
      if (name && !prev.name) prev.name = name;
      prev.keys += 1;
      prev.fromLicense = true;
      const mentorName = String(row?.mentorName || "").trim();
      const mentorEmail = normalizeAdminEmail(row?.mentorEmail);
      if (mentorName && !prev.mentors.includes(mentorName)) {
        prev.mentors.push(mentorName);
      }
      if (mentorEmail && !prev.mentorEmails.includes(mentorEmail)) {
        prev.mentorEmails.push(mentorEmail);
      }
      const createdAt = Number(row?.createdAt) || 0;
      const prevCreated = Number(prev.latestLicense?.createdAt) || 0;
      if (!prev.latestKey || createdAt >= prevCreated) {
        prev.latestKey = String(row?.key || "").trim();
        prev.latestLicense = row;
      }
      map.set(email, prev);
    }

    for (const s of signups || []) {
      const email = normalizeAdminEmail(s?.email);
      if (!email || !email.includes("@")) continue;
      const prev = map.get(email) || {
        email,
        name: "",
        mentors: [],
        mentorEmails: [],
        keys: 0,
        latestKey: "",
        latestLicense: null,
        signupStatus: "",
        fromLicense: false,
        fromSignup: false,
      };
      prev.fromSignup = true;
      prev.signupStatus = String(s?.status || "").toLowerCase();
      map.set(email, prev);
    }

    return Array.from(map.values()).sort((a, b) =>
      a.email.localeCompare(b.email)
    );
  }, [licenseKeys, signups]);

  const emailQuery = String(emailSearch || "")
    .trim()
    .toLowerCase();

  const filteredEmailClients = useMemo(() => {
    if (!emailQuery) return emailClients;
    return emailClients.filter((row) => {
      const hay = [
        row.email,
        row.name,
        ...(row.mentors || []),
        ...(row.mentorEmails || []),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(emailQuery);
    });
  }, [emailClients, emailQuery]);

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
    }, 15000);
    return () => clearInterval(timer);
  }, [adminOpen, adminPage, refreshSignups]);

  useEffect(() => {
    if (!adminOpen || adminPage !== "emails") return;
    refreshSignups?.();
    refreshLicenses?.();
  }, [adminOpen, adminPage, refreshSignups, refreshLicenses]);

  useEffect(() => {
    if (!adminOpen || !adminSession?.email) return;
    if (isSuperAdminSession(adminSession)) return;
    if (adminPage !== "commission") return;
    let cancelled = false;
    (async () => {
      try {
        const quota = await fetchWithdrawQuotaRemote(adminSession.email);
        if (!cancelled) setWithdrawQuota(quota);
      } catch {
        if (!cancelled) setWithdrawQuota(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adminOpen, adminSession, adminPage]);

  useEffect(() => {
    if (!adminOpen || !adminSession?.email) return undefined;
    if (isSuperAdminSession(adminSession)) {
      setMentorActivity(null);
      return undefined;
    }
    let cancelled = false;
    async function loadActivity() {
      try {
        const activity = await fetchMentorActivityRemote(adminSession.email);
        if (!cancelled) setMentorActivity(activity);
        if (activity?.deactivated) {
          showToast(
            activity.message ||
              "Portal deactivated — no key used for a new app access in over a week"
          );
          writeAdminSession(null);
          setAdminSession(null);
          setDrawerOpen(false);
          setAdminPage("dashboard");
        }
      } catch {
        if (!cancelled) setMentorActivity(null);
      }
    }
    loadActivity();
    const poll = setInterval(loadActivity, 30000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [adminOpen, adminSession, adminPage]);

  useEffect(() => {
    if (!mentorActivity?.graceEndsAt && !mentorActivity?.weekDeadlineAt) {
      return undefined;
    }
    const timer = setInterval(() => setActivityTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [mentorActivity?.graceEndsAt, mentorActivity?.weekDeadlineAt, mentorActivity?.inGrace]);

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
          // Preserve banking details already typed in this session, but do not
          // re-add mentors missing from the server (those cause "Mentor not found").
          for (const m of prev) {
            const key = normalizeAdminEmail(m.email);
            const incoming = map.get(key);
            if (!incoming) continue;
            const keepBanking =
              m?.banking?.accountNumber && !incoming?.banking?.accountNumber
                ? m.banking
                : incoming.banking?.accountNumber
                  ? incoming.banking
                  : m.banking || incoming.banking;
            const prevKeys = Number(m.licenseKeysAllowed);
            const nextKeys = Number(incoming.licenseKeysAllowed);
            const prevAt = Number(m.licenseKeysUpdatedAt) || 0;
            const nextAt = Number(incoming.licenseKeysUpdatedAt) || 0;
            let licenseKeysAllowed = incoming.licenseKeysAllowed;
            let licenseKeysUpdatedAt = incoming.licenseKeysUpdatedAt;
            if (Number.isFinite(prevKeys) && Number.isFinite(nextKeys)) {
              if (prevAt > nextAt) {
                licenseKeysAllowed = prevKeys;
                licenseKeysUpdatedAt = prevAt;
              } else if (nextAt > prevAt) {
                licenseKeysAllowed = nextKeys;
                licenseKeysUpdatedAt = nextAt;
              } else {
                licenseKeysAllowed = Math.max(prevKeys, nextKeys);
                licenseKeysUpdatedAt = Math.max(prevAt, nextAt) || Date.now();
              }
            } else if (Number.isFinite(prevKeys) && !Number.isFinite(nextKeys)) {
              licenseKeysAllowed = prevKeys;
              licenseKeysUpdatedAt = prevAt || Date.now();
            }
            map.set(key, {
              ...incoming,
              banking: keepBanking,
              licenseKeysAllowed,
              licenseKeysUpdatedAt,
            });
          }
          return Array.from(map.values());
        });
      } catch {
        if (!cancelled) setMentors((prev) => prev);
      }
    }
    loadMentors();
    // Poll mentors only on pages that need live approval / commission updates.
    // License Keys + Dashboard reuse the shared license store — avoid hammering.
    const ms =
      adminPage === "mentors" ||
      adminPage === "commissions" ||
      adminPage === "commission" ||
      adminPage === "mentor-keys" ||
      adminPage === "top-mentors" ||
      adminPage === "dashboard" ||
      adminPage === "licenses"
        ? 8000
        : 25000;
    const timer = setInterval(loadMentors, ms);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [adminOpen, adminSession, adminPage]);

  useEffect(() => {
    if (!adminOpen || !adminSession || isSuperAdminSession(adminSession)) return;
    // Keep robot registry warm on Dashboard + Self Hosting so Connected
    // matches live MT sessions (not only when the Self Hosting tab is open).
    if (adminPage !== "self-hosting" && adminPage !== "dashboard") return;
    setHostRecent(loadSelfHostRecent(adminSession.email));
    let cancelled = false;
    async function loadHosted() {
      setHostLoading(true);
      try {
        const accounts = await listMentorHostedAccounts(adminSession.email);
        if (cancelled) return;
        // Also surface robot sessions stamped on local license rows — durable
        // across refreshes even when /api/mt5-accounts /tmp is empty on this hit.
        const fromLicenses = (Array.isArray(licenseKeys) ? licenseKeys : [])
          .filter((row) => {
            const mentor = normalizeAdminEmail(row.mentorEmail);
            const mine = normalizeAdminEmail(adminSession.email);
            return mentor && mine && mentor === mine && String(row.robotAccountId || "").trim();
          })
          .map((row) => ({
            email: String(row.clientEmail || "").trim().toLowerCase(),
            accountId: String(row.robotAccountId || "").trim(),
            login: String(row.robotLogin || "").trim(),
            server: String(row.robotServer || "").trim(),
            company: String(row.robotCompany || "").trim(),
            platform: String(row.robotPlatform || "MT5").trim() || "MT5",
            connectedAt: Number(row.robotConnectedAt) || Date.now(),
            updatedAt: Number(row.updatedAt || row.robotConnectedAt) || Date.now(),
            source: "license-local",
          }))
          .filter((row) => row.email && row.accountId);
        const byEmail = new Map();
        for (const row of [...fromLicenses, ...(accounts || [])]) {
          const email = String(row.email || "").trim().toLowerCase();
          if (!email) continue;
          const prev = byEmail.get(email);
          if (!prev || (row.updatedAt || 0) >= (prev.updatedAt || 0)) {
            byEmail.set(email, row);
          }
        }
        setHostAccounts(Array.from(byEmail.values()));
      } catch (error) {
        if (!cancelled) {
          setHostAccounts([]);
          if (adminPage === "self-hosting") {
            showToast(error.message || "Could not load connected robot clients");
          }
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
  }, [adminOpen, adminSession, adminPage, showToast, licenseKeys]);

  useEffect(() => {
    if (!hostScheduled?.runAt) return undefined;
    const timer = setInterval(() => setHostScheduleTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hostScheduled?.runAt]);

  useEffect(() => {
    return () => {
      if (hostScheduleTimerRef.current) {
        clearTimeout(hostScheduleTimerRef.current);
        hostScheduleTimerRef.current = null;
      }
    };
  }, []);

  // Pay-after-activate: stamp commissionEligible for paid clients when mentor
  // opens the commission page (repairs unlocks that stayed at not_paid).
  useEffect(() => {
    if (!adminOpen || !adminSession || isSuperAdminSession(adminSession)) {
      return undefined;
    }
    if (adminPage !== "commission") return undefined;
    let cancelled = false;
    async function backfillCommission() {
      const email = normalizeAdminEmail(adminSession.email);
      const id = String(adminSession.id || "");
      const owned = (licenseKeys || []).filter((row) => {
        const owner = normalizeAdminEmail(row.mentorEmail);
        const ownerId = String(row.mentorId || "");
        return (
          ((email && owner === email) || (id && ownerId === id)) &&
          Boolean(row.used) &&
          !row.commissionEligible
        );
      });
      const clients = [
        ...new Set(
          owned
            .map((row) => normalizeAdminEmail(row.clientEmail))
            .filter((client) => client && client.includes("@"))
        ),
      ];
      if (!clients.length) return;
      let changed = false;
      for (const client of clients.slice(0, 25)) {
        if (cancelled) return;
        const signup = (signups || []).find(
          (s) => normalizeAdminEmail(s.email) === client
        );
        if (!signup?.accessPaid || signup?.accessBypassed) continue;
        try {
          const updated = await reconcileCommissionRemote(client);
          if (updated?.commissionEligible) changed = true;
        } catch {
          // Best-effort; live count still shows paid unlocks.
        }
      }
      if (!cancelled && changed) {
        try {
          await refreshLicenses?.();
        } catch {
          // ignore
        }
      }
    }
    void backfillCommission();
    return () => {
      cancelled = true;
    };
  }, [
    adminOpen,
    adminSession,
    adminPage,
    licenseKeys,
    signups,
    refreshLicenses,
  ]);

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

  // Seed draft color from the signed-in mentor's saved app color.
  // Never overwrite while the mentor is editing a draft (dirty).
  const appColorDirtyRef = useRef(false);
  useEffect(() => {
    if (!adminSession?.email) return;
    if (appColorDirtyRef.current) return;
    const sessionKey = normalizeAdminEmail(adminSession.email);
    const mine = mentors.find((m) => normalizeAdminEmail(m.email) === sessionKey);
    const saved = normalizeHexColor(
      mine?.appColor || appColor || DEFAULT_APP_COLOR,
      DEFAULT_APP_COLOR
    );
    setDraftAppColor(saved);
  }, [mentors, adminSession?.email, appColor]);

  const savedMentorAppColor = useMemo(() => {
    if (!adminSession?.email) return normalizeHexColor(appColor || DEFAULT_APP_COLOR);
    const sessionKey = normalizeAdminEmail(adminSession.email);
    const mine = mentors.find((m) => normalizeAdminEmail(m.email) === sessionKey);
    return normalizeHexColor(mine?.appColor || appColor || DEFAULT_APP_COLOR);
  }, [mentors, adminSession?.email, appColor]);

  const draftColorNorm = normalizeHexColor(draftAppColor || DEFAULT_APP_COLOR);
  const appColorDirty = draftColorNorm !== normalizeHexColor(savedMentorAppColor);

  const selectDraftAppColor = (next) => {
    appColorDirtyRef.current = true;
    setDraftAppColor(normalizeHexColor(next || DEFAULT_APP_COLOR));
  };

  const savePortalAppColor = async () => {
    const email = adminSession?.email || "";
    const next = normalizeHexColor(draftAppColor || DEFAULT_APP_COLOR);
    if (!email) {
      await setAppColor(next);
      appColorDirtyRef.current = false;
      return;
    }
    if (appColorSaveBusy) return;
    if (!appColorDirty) {
      showToast("App color already saved");
      return;
    }
    setAppColorSaveBusy(true);
    try {
      await setAppColor(next, { persistEmail: email });
      setMentors((prev) =>
        prev.map((m) =>
          normalizeAdminEmail(m.email) === normalizeAdminEmail(email)
            ? {
                ...m,
                appColor: next,
                appColorUpdatedAt: Date.now(),
              }
            : m
        )
      );
      setDraftAppColor(next);
      appColorDirtyRef.current = false;
    } catch (error) {
      showToast(error?.message || "Could not save app color");
    } finally {
      setAppColorSaveBusy(false);
    }
  };

  async function refreshMentorsList() {
    if (refreshBusy === "mentors") return;
    setRefreshBusy("mentors");
    try {
      const list = await fetchMentors();
      setMentors((prev) => {
        // Preserve richer banking details already in memory for known mentors.
        // Never keep local-only ghosts that are missing from the server list.
        const map = new Map(
          (Array.isArray(list) ? list : []).map((m) => [normalizeAdminEmail(m.email), m])
        );
        for (const m of prev) {
          const key = normalizeAdminEmail(m.email);
          const incoming = map.get(key);
          if (!incoming) continue;
          const keepBanking =
            m?.banking?.accountNumber && !incoming?.banking?.accountNumber
              ? m.banking
              : incoming.banking || m.banking;
          const prevKeys = Number(m.licenseKeysAllowed);
          const nextKeys = Number(incoming.licenseKeysAllowed);
          const prevAt = Number(m.licenseKeysUpdatedAt) || 0;
          const nextAt = Number(incoming.licenseKeysUpdatedAt) || 0;
          let licenseKeysAllowed = incoming.licenseKeysAllowed;
          let licenseKeysUpdatedAt = incoming.licenseKeysUpdatedAt;
          if (Number.isFinite(prevKeys) && Number.isFinite(nextKeys)) {
            if (prevAt > nextAt) {
              licenseKeysAllowed = prevKeys;
              licenseKeysUpdatedAt = prevAt;
            } else if (nextAt > prevAt) {
              licenseKeysAllowed = nextKeys;
              licenseKeysUpdatedAt = nextAt;
            } else {
              licenseKeysAllowed = Math.max(prevKeys, nextKeys);
              licenseKeysUpdatedAt = Math.max(prevAt, nextAt) || Date.now();
            }
          } else if (Number.isFinite(prevKeys) && !Number.isFinite(nextKeys)) {
            licenseKeysAllowed = prevKeys;
            licenseKeysUpdatedAt = prevAt || Date.now();
          }
          map.set(key, {
            ...incoming,
            banking: keepBanking,
            licenseKeysAllowed,
            licenseKeysUpdatedAt,
            // Keep a newer in-memory app color if refresh returned a stale store.
            ...(() => {
              const prevColor = normalizeHexColor(m?.appColor || "", "");
              const nextColor = normalizeHexColor(incoming?.appColor || "", "");
              const prevAt = Number(m?.appColorUpdatedAt) || 0;
              const nextAt = Number(incoming?.appColorUpdatedAt) || 0;
              if (prevColor && (!nextColor || prevAt > nextAt)) {
                return {
                  appColor: prevColor,
                  appColorUpdatedAt: prevAt || Date.now(),
                };
              }
              return {};
            })(),
          });
        }
        return Array.from(map.values());
      });
      showToast("Mentors refreshed");
    } catch (error) {
      showToast(error.message || "Could not refresh mentors");
    } finally {
      setRefreshBusy("");
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

  function toggleEmailSelect(email) {
    const key = normalizeAdminEmail(email);
    if (!key) return;
    setEmailSelected((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }

  function selectAllFilteredEmails() {
    setEmailSelected((prev) => {
      const next = { ...prev };
      for (const row of filteredEmailClients) {
        next[row.email] = true;
      }
      return next;
    });
  }

  function clearEmailSelection() {
    setEmailSelected({});
  }

  async function sendEmailsToClients({ all = false } = {}) {
    if (!isSuperAdminSession(adminSession)) {
      showToast("Only super admin can send emails");
      return;
    }
    if (emailSendBusy) return;

    const selected = all
      ? emailClients
      : emailClients.filter((row) => emailSelected[row.email]);

    if (!selected.length) {
      showToast(all ? "No client emails to send" : "Select at least one client");
      return;
    }

    setEmailSendBusy(true);
    try {
      if (emailMode === "license") {
        const withKeys = selected.filter((row) => row.latestKey);
        if (!withKeys.length) {
          showToast("None of the selected clients have a license key yet");
          return;
        }
        let ok = 0;
        let fail = 0;
        for (const row of withKeys) {
          try {
            const result = await resendLicenseEmailRemote(
              row.latestLicense || row.latestKey
            );
            if (result?.ok || result?.email?.ok) ok += 1;
            else fail += 1;
          } catch {
            fail += 1;
          }
        }
        showToast(
          fail
            ? `Sent ${ok} license email${ok === 1 ? "" : "s"} · ${fail} failed`
            : `Sent ${ok} license email${ok === 1 ? "" : "s"}`
        );
        return;
      }

      const subject = String(emailSubject || "").trim();
      const message = String(emailMessage || "").trim();
      if (!subject) {
        showToast("Enter a subject");
        return;
      }
      if (!message) {
        showToast("Enter a message");
        return;
      }

      const result = await sendBroadcastEmailsRemote({
        adminEmail: adminSession?.email || SUPER_ADMIN_EMAIL,
        subject,
        message,
        recipients: selected.map((row) => ({
          email: row.email,
          name: row.name || "",
        })),
      });
      const sent = Number(result?.sentCount) || 0;
      const failed = Number(result?.failedCount) || 0;
      const skipped = Number(result?.skippedCount) || 0;
      showToast(
        failed || skipped
          ? `Sent ${sent} · ${failed} failed${skipped ? ` · ${skipped} skipped` : ""}`
          : `Sent ${sent} email${sent === 1 ? "" : "s"}`
      );
    } catch (error) {
      showToast(error.message || "Could not send emails");
    } finally {
      setEmailSendBusy(false);
    }
  }

  async function runSignupStatus(email, status, { silent = false } = {}) {
    const actionKey = `${String(email || "").trim().toLowerCase()}:${status}`;
    if (!silent) {
      if (signupActionBusy) return false;
      setSignupActionBusy(actionKey);
    }
    try {
      const result = await setSignupStatus(email, status, { silent });
      return result;
    } finally {
      if (!silent) setSignupActionBusy("");
    }
  }

  async function changeMentorStatus(email, status, { silent = false } = {}) {
    const actionKey = `${normalizeAdminEmail(email)}:${status}`;
    if (!silent) {
      if (mentorActionBusy) return false;
      setMentorActionBusy(actionKey);
    }
    try {
      const updated = await updateMentorStatus(email, status);
      setMentors((prev) => {
        const next = prev.map((m) =>
          normalizeAdminEmail(m.email) === normalizeAdminEmail(updated.email)
            ? updated
            : m
        );
        if (
          !next.some(
            (m) =>
              normalizeAdminEmail(m.email) === normalizeAdminEmail(updated.email)
          )
        ) {
          next.unshift(updated);
        }
        return next;
      });
      if (!silent) {
        if (status === "approved" && updated?.approvalEmailSent) {
          showToast("Mentor approved — email sent");
        } else if (status === "approved") {
          showToast("Mentor approved");
        } else {
          showToast(`Mentor ${status}`);
        }
      }
      return true;
    } catch (error) {
      const missing =
        error?.status === 404 ||
        /mentor not found/i.test(String(error?.message || ""));
      if (missing) {
        const key = normalizeAdminEmail(email);
        setMentors((prev) =>
          prev.filter((m) => normalizeAdminEmail(m.email) !== key)
        );
        if (!silent) {
          showToast(
            "Mentor missing on server — Set password to restore, then approve"
          );
        }
        return false;
      }
      if (!silent) showToast(error.message || "Could not update mentor");
      return false;
    } finally {
      if (!silent) setMentorActionBusy("");
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
          ? `Approved ${ok} mentor${ok === 1 ? "" : "s"} — emails sent`
          : `Approved ${ok} of ${list.length} mentors`
      );
    } finally {
      setMentorBulkBusy(false);
    }
  }

  async function bulkApprovePendingClients() {
    const list = pending;
    if (!list.length) {
      showToast("No pending clients to approve");
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
    setDraftSymbols((prev) =>
      prev.some((s) => s.toLowerCase() === symbol.toLowerCase()) ? prev : [...prev, symbol]
    );
    setCustomSymbol("");
    showToast("Symbol added");
  }

  function removeDraftSymbol(symbol) {
    setDraftSymbols((prev) => prev.filter((s) => s !== symbol));
  }

  function openEaDeleteConfirm(ea) {
    if (eaBusy || eaDeleteBusy) return;
    setEaDeleteConfirm({
      id: ea.id,
      name: ea.name || "this EA",
    });
    setEaDeleteEmail("");
  }

  function closeEaDeleteConfirm() {
    if (eaDeleteBusy) return;
    setEaDeleteConfirm(null);
    setEaDeleteEmail("");
  }

  async function confirmEaDelete() {
    if (!eaDeleteConfirm?.id || eaDeleteBusy) return;
    const typed = normalizeAdminEmail(eaDeleteEmail);
    const sessionEmail = normalizeAdminEmail(adminSession?.email);
    if (!typed || !typed.includes("@")) {
      showToast("Type your email to confirm delete");
      return;
    }
    if (!sessionEmail || typed !== sessionEmail) {
      showToast("Email does not match your mentor account");
      return;
    }
    setEaDeleteBusy(eaDeleteConfirm.id);
    try {
      await deleteEa(eaDeleteConfirm.id);
      setEaDeleteConfirm(null);
      setEaDeleteEmail("");
    } finally {
      setEaDeleteBusy("");
    }
  }

  function cancelHostSchedule() {
    if (hostScheduleTimerRef.current) {
      clearTimeout(hostScheduleTimerRef.current);
      hostScheduleTimerRef.current = null;
    }
    setHostScheduled(null);
    setHostBusy(false);
    showToast("Scheduled trade cancelled");
  }

  async function runHostTrade(payload) {
    const {
      symbol,
      side,
      volume,
      tradesCount,
      stopLoss,
      takeProfit,
      clients,
    } = payload;
    setHostBusy(true);
    try {
      const result = await executeMentorSelfHostTrade({
        mentorEmail: adminSession.email,
        symbol,
        side,
        volume: Number.isFinite(volume) && volume > 0 ? volume : 0.01,
        tradesCount,
        stopLoss,
        takeProfit,
        comment: "mentor~APEXEA",
        clients,
      });
      setHostResult(result);
      setHostScheduled(null);
      const entry = {
        id: `${Date.now()}-${symbol}-${side}`,
        at: Date.now(),
        symbol: result.symbol || symbol,
        side: result.side || side,
        volume: result.volume || volume,
        tradesCount,
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
          `Opened ${placed} trade${placed === 1 ? "" : "s"} on connected clients`
        );
      } else {
        const detail =
          result?.error ||
          result?.results?.find((r) => !r.ok)?.error ||
          "No trades were placed";
        showToast(detail);
      }
      return result;
    } catch (error) {
      showToast(error.message || "Could not execute trade");
      setHostResult(error.data || { error: error.message });
      setHostScheduled(null);
      throw error;
    } finally {
      setHostBusy(false);
      hostScheduleTimerRef.current = null;
    }
  }

  function confirmHostTrade() {
    if (hostBusy || hostScheduled) return;
    const symbol = normalizeBrokerSymbol(hostSymbol || "");
    const rawSl = Number(hostSl);
    const rawTp = Number(hostTp);
    const stopLoss = Number.isFinite(rawSl) && rawSl > 0 ? rawSl : null;
    const takeProfit = Number.isFinite(rawTp) && rawTp > 0 ? rawTp : null;
    const volume = Number(hostVolume);
    const tradesCount = Math.max(
      1,
      Math.min(20, Math.floor(Number(hostTradesCount) || 1))
    );
    const clients = hostAccounts.map((row) => ({
      email: row.email,
      accountId: row.accountId,
      login: row.login,
      server: row.server,
      company: row.company,
      platform: row.platform,
      connectedAt: row.connectedAt,
      updatedAt: row.updatedAt,
    }));
    const payload = {
      symbol,
      side: hostSide,
      volume,
      tradesCount,
      stopLoss,
      takeProfit,
      clients,
    };
    const delaySec = Math.max(0, Number(hostDelaySec) || 0);
    setHostConfirmOpen(false);
    setHostDelaySec(0);

    if (delaySec <= 0) {
      void runHostTrade(payload);
      return;
    }

    const runAt = Date.now() + delaySec * 1000;
    const label =
      delaySec >= 60
        ? `${Math.round(delaySec / 60)} minute${Math.round(delaySec / 60) === 1 ? "" : "s"}`
        : `${delaySec}s`;
    setHostScheduled({
      runAt,
      delaySec,
      symbol,
      side: hostSide,
      volume,
      tradesCount,
    });
    setHostBusy(true);
    showToast(`Trade scheduled — executes in ${label}`);
    if (hostScheduleTimerRef.current) clearTimeout(hostScheduleTimerRef.current);
    hostScheduleTimerRef.current = setTimeout(() => {
      void runHostTrade(payload);
    }, delaySec * 1000);
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
    if (eaBusy) return;
    let symbols = [...draftSymbols];
    if (customSymbol.trim()) {
      const symbol = normalizeSymbol(customSymbol);
      if (symbol) {
        ensureCatalog(symbol);
        if (!symbols.some((s) => s.toLowerCase() === symbol.toLowerCase())) {
          symbols.push(symbol);
        }
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
    setEaBusy(true);
    try {
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
    } finally {
      setEaBusy(false);
    }
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

  const myLicenses = isSuperAdmin
    ? licenseKeys
    : licenseKeys.filter((row) => {
        const owner = String(row.mentorEmail || "").toLowerCase();
        const ownerId = String(row.mentorId || "");
        return owner === mentorEmail || (mentorId && ownerId === mentorId);
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

  async function setMentorPasswordFor(email) {
    if (!isSuperAdmin) {
      showToast("Only super admin can set mentor passwords");
      return;
    }
    const key = normalizeAdminEmail(email);
    const nextPass = String(mentorPasswordDrafts[key] || "").trim();
    if (nextPass.length < 6) {
      showToast("Password must be at least 6 characters");
      return;
    }
    const existing = mentors.find((m) => normalizeAdminEmail(m.email) === key);
    setMentorPasswordBusy(key);
    try {
      const updated = await setMentorAccountPassword({
        adminEmail: adminSession?.email || SUPER_ADMIN_EMAIL,
        email: key,
        password: nextPass,
        username: existing?.username || "",
        contact: existing?.contact || "",
        status: existing?.status || "approved",
      });
      if (updated) {
        setMentors((prev) => {
          const next = prev.map((m) =>
            normalizeAdminEmail(m.email) === key ? { ...m, ...updated } : m
          );
          if (!next.some((m) => normalizeAdminEmail(m.email) === key)) {
            next.unshift(updated);
          }
          return next;
        });
      }
      setMentorPasswordDrafts((prev) => ({ ...prev, [key]: "" }));
      showToast(`Password updated for ${key}`);
    } catch (error) {
      showToast(error.message || "Could not set password");
    } finally {
      setMentorPasswordBusy("");
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
  const licenseQueryKey = normalizeLicenseKey(licenseSearch)
    .toLowerCase()
    .replace(/-/g, "");
  const filteredLicenses = !licenseQuery
    ? myLicenses
    : myLicenses.filter((row) => {
        const name = String(row.clientName || row.mainText || "").toLowerCase();
        const email = String(row.clientEmail || "").toLowerCase();
        const key = String(row.key || "").toLowerCase();
        const keyCompact = normalizeLicenseKey(row.key)
          .toLowerCase()
          .replace(/-/g, "");
        const bot = String(row.botName || "").toLowerCase();
        return (
          name.includes(licenseQuery) ||
          email.includes(licenseQuery) ||
          key.includes(licenseQuery) ||
          (licenseQueryKey && keyCompact.includes(licenseQueryKey)) ||
          bot.includes(licenseQuery)
        );
      });

  const usedKeys = myLicenses.filter((k) => k.used);
  const unusedKeys = myLicenses.filter((k) => !k.used);
  // Connected = redeemed on a phone and/or live MT5 session stamped,
  // or currently listed in the Self Hosting robot registry.
  const hostEmailSet = new Set(
    (Array.isArray(hostAccounts) ? hostAccounts : [])
      .map((row) => String(row?.email || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const isKeyConnected = (k) => {
    if (!k?.used) return false;
    if (String(k?.deviceId || "").trim()) return true;
    if (String(k?.robotAccountId || "").trim()) return true;
    const email = String(k?.clientEmail || "").trim().toLowerCase();
    return Boolean(email && hostEmailSet.has(email));
  };
  const connectedKeys = myLicenses.filter((k) => isKeyConnected(k));
  const unconnectedKeys = myLicenses.filter(
    (k) => k.used && !isKeyConnected(k)
  );

  function licenseStatusLabel(entry) {
    if (!entry?.used) return "Unused";
    if (isKeyConnected(entry)) return "Connected";
    return "Used · not connected";
  }

  function countSoldKeysForMentor(mentor) {
    const email = normalizeAdminEmail(mentor?.email);
    const id = String(mentor?.id || "");
    const owned = licenseKeys.filter((row) => {
      const owner = normalizeAdminEmail(row.mentorEmail);
      const ownerId = String(row.mentorId || "");
      return (email && owner === email) || (id && ownerId === id);
    });

    // Stamped first-paid unlocks.
    const creditedClients = new Set();
    let count = 0;
    for (const row of owned) {
      if (!row?.used || !row?.commissionEligible) continue;
      count += 1;
      const client = normalizeAdminEmail(row.clientEmail);
      if (client) creditedClients.add(client);
    }

    // Live backfill: client paid after activating (stamp was not_paid).
    // Credit this mentor's earliest used key per client when signup is paid
    // and no key for that client is already commissionEligible.
    const candidates = new Map();
    for (const row of owned) {
      if (!row?.used || row?.commissionEligible) continue;
      const client = normalizeAdminEmail(row.clientEmail);
      if (!client || creditedClients.has(client)) continue;
      const reason = String(row.commissionReason || "");
      if (
        reason === "access_already_active" ||
        reason === "invite_migrate_bypass"
      ) {
        continue;
      }
      const signup = (signups || []).find(
        (s) => normalizeAdminEmail(s.email) === client
      );
      if (!signup?.accessPaid || signup?.accessBypassed) continue;
      const alreadyCredited = licenseKeys.some(
        (r) =>
          normalizeAdminEmail(r.clientEmail) === client &&
          Boolean(r.commissionEligible)
      );
      if (alreadyCredited) continue;
      const usedAt = Number(row.usedAt) || Number(row.createdAt) || 0;
      const prev = candidates.get(client);
      if (!prev || usedAt < prev.usedAt) {
        candidates.set(client, { usedAt });
      }
    }
    return count + candidates.size;
  }

  const soldKeysCount = countSoldKeysForMentor(adminSession);
  const commissionUsd = Number((soldKeysCount * COMMISSION_USD).toFixed(2));
  const commissionZar = soldKeysCount * COMMISSION_ZAR;
  const canWithdraw = soldKeysCount >= WITHDRAW_MIN_KEYS;
  const keysUntilWithdraw = Math.max(0, WITHDRAW_MIN_KEYS - soldKeysCount);
  const withdrawRemaining =
    withdrawQuota && Number.isFinite(Number(withdrawQuota.remaining))
      ? Number(withdrawQuota.remaining)
      : WITHDRAW_MAX_PER_WEEK;
  const withdrawLimitHit = withdrawRemaining <= 0;

  async function requestCommissionWithdrawal() {
    if (!adminSession?.email) return;
    if (withdrawRequestBusy) return;
    if (!canWithdraw) {
      showToast(
        `Need ${keysUntilWithdraw} more unlock${keysUntilWithdraw === 1 ? "" : "s"} before withdrawing`
      );
      return;
    }
    if (withdrawLimitHit) {
      showToast(
        `Withdrawal limit reached — max ${WITHDRAW_MAX_PER_WEEK} requests per week`
      );
      return;
    }
    const hasBanking =
      String(bankingForm.accountName || "").trim() &&
      String(bankingForm.bankName || "").trim() &&
      String(bankingForm.accountNumber || "").trim();
    if (!hasBanking) {
      showToast("Save your banking details below first");
      return;
    }

    setWithdrawRequestBusy(true);
    try {
      const result = await requestCommissionWithdrawalRemote({
        mentorEmail: adminSession.email,
        username: adminSession.username || sessionMentor?.username || "",
        contact: sessionMentor?.contact || profileContact || "",
        paidUnlocks: soldKeysCount,
        commissionUsd,
        commissionZar,
        banking: bankingForm,
      });
      if (result?.quota) setWithdrawQuota(result.quota);
      const left =
        result?.quota?.remaining != null
          ? Number(result.quota.remaining)
          : Math.max(0, withdrawRemaining - 1);
      showToast(
        left > 0
          ? `Request sent · ${left} left this week`
          : `Request sent · weekly limit reached`
      );
    } catch (error) {
      if (error?.quota) setWithdrawQuota(error.quota);
      showToast(error.message || "Could not send withdrawal request");
    } finally {
      setWithdrawRequestBusy(false);
    }
  }

  async function sendPayoutDoneEmail(row) {
    const email = normalizeAdminEmail(row?.mentor?.email);
    if (!email) {
      showToast("Mentor email missing");
      return;
    }
    if (payoutEmailBusy) return;
    setPayoutEmailBusy(email);
    try {
      await sendMentorPayoutDoneRemote({
        adminEmail: adminSession?.email || SUPER_ADMIN_EMAIL,
        mentorEmail: email,
        username: row?.mentor?.username || "",
        paidUnlocks: row?.sold || 0,
        commissionUsd: row?.usd || 0,
        commissionZar: row?.zar || 0,
        banking: row?.banking || {},
        paidAt: Date.now(),
      });
      showToast(`Payout email sent to ${email}`);
    } catch (error) {
      showToast(error.message || "Could not send payout email");
    } finally {
      setPayoutEmailBusy("");
    }
  }

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

  // Plain compute (not useMemo): must stay after auth early-returns without
  // changing hook order when session appears/disappears on sign-in / logout.
  const topMentorRows = (() => {
    const signupByEmail = new Map(
      (signups || []).map((s) => [normalizeAdminEmail(s.email), s])
    );
    const isBypassedClient = (clientEmail, licenseRow = null) => {
      const client = normalizeAdminEmail(clientEmail);
      if (!client) return false;
      const signup = signupByEmail.get(client);
      if (signup?.accessBypassed) return true;
      const reason = String(licenseRow?.commissionReason || "").toLowerCase();
      if (
        reason === "invite_migrate_bypass" ||
        reason === "access_already_active" ||
        reason.includes("bypass")
      ) {
        return true;
      }
      return false;
    };

    const rows = mentors
      .filter((m) => {
        const role = String(m.role || "").toLowerCase();
        const status = String(m.status || "").toLowerCase();
        return role !== "superadmin" && status === "approved";
      })
      .map((mentor) => {
        const email = normalizeAdminEmail(mentor.email);
        const id = String(mentor.id || "");
        const owned = (licenseKeys || []).filter((row) => {
          const owner = normalizeAdminEmail(row.mentorEmail);
          const ownerId = String(row.mentorId || "");
          return (email && owner === email) || (id && ownerId === id);
        });
        const clients = new Set();
        const clientEmails = [];
        const clientMeta = new Map();
        let used = 0;
        let keysCounted = 0;
        let bypassedClients = 0;
        const bypassedSeen = new Set();
        for (const row of owned) {
          const client = normalizeAdminEmail(row.clientEmail);
          const bypassed = isBypassedClient(client, row);
          if (bypassed) {
            if (client && !bypassedSeen.has(client)) {
              bypassedSeen.add(client);
              bypassedClients += 1;
            }
            continue;
          }
          keysCounted += 1;
          if (row?.used) used += 1;
          if (client && !clients.has(client)) {
            clients.add(client);
            clientEmails.push(client);
            clientMeta.set(client, {
              email: client,
              name: String(row.clientName || "").trim(),
              used: Boolean(row.used),
            });
          } else if (client && row?.used) {
            const prev = clientMeta.get(client);
            if (prev) clientMeta.set(client, { ...prev, used: true });
          }
        }
        clientEmails.sort((a, b) => a.localeCompare(b));
        const sold = countSoldKeysForMentor(mentor);
        return {
          mentor,
          email,
          status: "approved",
          keys: keysCounted,
          used,
          clients: clients.size,
          sold,
          bypassedClients,
          clientEmails,
          clientRows: clientEmails.map((c) => clientMeta.get(c)).filter(Boolean),
        };
      });
    rows.sort(
      (a, b) =>
        b.clients - a.clients ||
        b.used - a.used ||
        b.sold - a.sold ||
        b.keys - a.keys ||
        String(a.mentor.username || a.email).localeCompare(
          String(b.mentor.username || b.email)
        )
    );
    return rows;
  })();

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
                  <button
                    type="button"
                    className="admin-stat-card admin-stat-card-action admin-stat-card-btn"
                    onClick={() => {
                      setClientMgmtSearch("");
                      setAdminPage("clients");
                      setDrawerOpen(false);
                    }}
                  >
                    <p className="admin-stat-label">Paid clients</p>
                    <p className="admin-stat-value is-ok">{paidRealClientsTotal}</p>
                    <p className="admin-card-meta">Real PayPal · not bypassed</p>
                  </button>
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
                    <p className="admin-stat-label">Generated keys</p>
                    <p className="admin-stat-value">{mentorKeysGenerated}</p>
                    <p className="admin-card-meta">
                      {unusedKeys.length} unused · {usedKeys.length} used
                    </p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Quota left</p>
                    <p className="admin-stat-value is-ok">
                      {mentorKeysRemaining == null ? "∞" : mentorKeysRemaining}
                    </p>
                    <p className="admin-card-meta">
                      {mentorKeysRemaining == null
                        ? "Unlimited generation"
                        : `${mentorKeysRemaining} of ${mentorKeyAllowance} left to generate`}
                    </p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Connected</p>
                    <p className="admin-stat-value is-ok">{connectedKeys.length}</p>
                    <p className="admin-card-meta">
                      Used keys bound to a phone or MetaTrader
                    </p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Used · not connected</p>
                    <p className="admin-stat-value is-warn">{unconnectedKeys.length}</p>
                    <p className="admin-card-meta">
                      Redeemed but no phone/MT session yet
                    </p>
                  </article>
                  <article className="admin-stat-card">
                    <p className="admin-stat-label">Total EAs</p>
                    <p className="admin-stat-value">{myEas.length}</p>
                  </article>
                </div>
                <div
                  className={`admin-card mentor-activity-banner${
                    mentorActivity?.inGrace ? " is-warn" : ""
                  }`}
                  style={{ marginTop: 14 }}
                >
                  <h3 style={{ margin: "0 0 8px" }}>Weekly unlock rule</h3>
                  <p className="admin-card-meta" style={{ margin: 0 }}>
                    Generate at least <strong>1 key each week</strong> that a{" "}
                    <strong>new client uses to unlock the app</strong>. Keys that
                    are only generated (or reused on an already-unlocked account)
                    do not count. If you miss a week, you get a{" "}
                    <strong>2-hour countdown</strong> — when it ends your portal
                    deactivates automatically.
                  </p>
                  {mentorActivity?.inGrace ? (
                    <p
                      className="admin-card-meta"
                      style={{ marginTop: 10, color: "#ffb020", fontWeight: 700 }}
                    >
                      Deactivates in{" "}
                      {formatGraceCountdown(
                        Math.max(
                          0,
                          Number(mentorActivity.graceEndsAt || 0) - Date.now()
                        ) +
                          activityTick * 0
                      )}
                    </p>
                  ) : mentorActivity?.weekDeadlineAt ? (
                    <p className="admin-card-meta" style={{ marginTop: 10 }}>
                      Next weekly check in{" "}
                      {formatGraceCountdown(
                        Math.max(
                          0,
                          Number(mentorActivity.weekDeadlineAt || 0) - Date.now()
                        )
                      )}{" "}
                      unless a new-app unlock is recorded sooner.
                    </p>
                  ) : null}
                </div>
              </>
            )}
          </section>
        )}

        {isSuperAdmin && adminPage === "clients" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Client Management</h2>
            <p className="admin-sub">
              Paid and payment-bypassed clients only. Pending signups stay under Activate Accounts.
            </p>

            <div className="admin-toolbar admin-client-mgmt-toolbar">
              <input
                className="admin-input"
                type="search"
                value={clientMgmtSearch}
                onChange={(e) => setClientMgmtSearch(e.target.value)}
                placeholder="Search paid / bypass clients by email"
                aria-label="Search paid or bypass clients by email"
              />
              <button
                className="admin-btn admin-btn-outline admin-btn-sm"
                type="button"
                onClick={() => setBypassOpen((open) => !open)}
              >
                {bypassOpen ? "Hide bypass" : "Payment bypass"}
              </button>
            </div>

            {bypassOpen ? (
              <div className="admin-card admin-bypass-card" style={{ marginBottom: 12 }}>
                <div className="admin-card-head">
                  <h3 className="admin-card-title">Payment bypass</h3>
                </div>
                <p className="ea-hint">
                  Enter a client email, then choose what to bypass without PayPal.
                </p>
                <label className="ea-field">
                  <span>Client email</span>
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
                    className={`admin-btn admin-btn-solid admin-btn-block${bypassBusy ? " is-loading" : ""}`}
                    type="button"
                    disabled={bypassBusy}
                    onClick={async () => {
                      setBypassBusy(true);
                      try {
                        await bypassAppAccess?.(bypassEmail);
                        setBypassEmail("");
                      } finally {
                        setBypassBusy(false);
                      }
                    }}
                  >
                    <AdminBusyLabel busy={bypassBusy} busyText="Bypassing…">
                      App access bypass
                    </AdminBusyLabel>
                  </button>
                  <button
                    className={`admin-btn admin-btn-outline admin-btn-block${bypassBusy ? " is-loading" : ""}`}
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
                    <AdminBusyLabel busy={bypassBusy} busyText="Bypassing…">
                      Premium chart bypass
                    </AdminBusyLabel>
                  </button>
                </div>
              </div>
            ) : null}

            <div className="admin-card">
              <p className="admin-card-meta">
                {clientMgmtQuery
                  ? `Showing ${filteredClients.length} match${filteredClients.length === 1 ? "" : "es"}`
                  : `Paid / bypass clients: ${filteredClients.length}`}
                {` · ${filteredPaidClients.length} paid · ${filteredBypassClients.length} bypassed`}
                {filteredPendingClients.length
                  ? ` · ${filteredPendingClients.length} pending (on Activate)`
                  : ""}
              </p>
              <div className="admin-table-head admin-table-head-2">
                <span>Email</span>
                <span>Access</span>
              </div>
              {filteredClients.length === 0 ? (
                <p className="admin-empty">
                  {clientMgmtQuery
                    ? `No paid / bypass clients match “${clientMgmtSearch.trim()}”`
                    : "No paid or bypassed clients yet"}
                </p>
              ) : (
                filteredClients.map((s) => {
                  const bypassed = Boolean(s.accessBypassed);
                  const paid = Boolean(s.accessPaid) && !bypassed;
                  const label = bypassed ? "Bypassed" : paid ? "Paid" : "Access";
                  return (
                    <div
                      className="admin-table-row admin-table-row-2 has-actions"
                      key={s.email}
                    >
                      <span className="admin-name">{s.email}</span>
                      <div className="admin-client-status-cell">
                        <div className="admin-client-access-row">
                          <span
                            className={`admin-badge ${
                              bypassed ? "is-pending" : "is-approved"
                            }`}
                            title={
                              bypassed
                                ? "Payment bypassed — no PayPal"
                                : "Access paid"
                            }
                          >
                            {label}
                          </span>
                          {bypassed ? (
                            <button
                              type="button"
                              className="admin-btn admin-btn-outline admin-btn-sm admin-bypass-remove-btn"
                              title={`Remove bypass for ${s.email}`}
                              aria-label={`Remove bypass for ${s.email}`}
                              disabled={bypassBusy}
                              onClick={async () => {
                                setBypassBusy(true);
                                try {
                                  await clearAppAccessBypass?.(s.email);
                                } finally {
                                  setBypassBusy(false);
                                }
                              }}
                            >
                              Remove
                            </button>
                          ) : null}
                        </div>
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
              <div className="admin-toolbar" style={{ marginBottom: 10, gap: 8 }}>
                <button
                  className={`admin-btn admin-btn-sm${refreshBusy === "signups" ? " is-loading" : ""}`}
                  type="button"
                  disabled={refreshBusy === "signups"}
                  onClick={() => {
                    if (refreshBusy === "signups") return;
                    setRefreshBusy("signups");
                    Promise.resolve(refreshSignups?.())
                      .then(() => showToast("Pending list refreshed"))
                      .finally(() => setRefreshBusy(""));
                  }}
                >
                  <AdminBusyLabel busy={refreshBusy === "signups"} busyText="Refreshing…">
                    Refresh pending
                  </AdminBusyLabel>
                </button>
                <button
                  className={`admin-btn admin-btn-solid admin-btn-sm${clientBulkBusy ? " is-loading" : ""}`}
                  type="button"
                  disabled={clientBulkBusy || pending.length === 0}
                  onClick={() => void bulkApprovePendingClients()}
                >
                  <AdminBusyLabel busy={clientBulkBusy} busyText="Approving…">
                    {`Bulk Approve${pending.length ? ` (${pending.length})` : ""}`}
                  </AdminBusyLabel>
                </button>
              </div>
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
                          className={`admin-btn admin-btn-solid admin-btn-sm${
                            signupActionBusy ===
                            `${String(s.email || "").trim().toLowerCase()}:approved`
                              ? " is-loading"
                              : ""
                          }`}
                          type="button"
                          disabled={Boolean(signupActionBusy)}
                          onClick={() => void runSignupStatus(s.email, "approved")}
                        >
                          <AdminBusyLabel
                            busy={
                              signupActionBusy ===
                              `${String(s.email || "").trim().toLowerCase()}:approved`
                            }
                            busyText="Approving…"
                          >
                            Approve
                          </AdminBusyLabel>
                        </button>
                        <button
                          className={`admin-btn admin-btn-danger admin-btn-sm${
                            signupActionBusy ===
                            `${String(s.email || "").trim().toLowerCase()}:declined`
                              ? " is-loading"
                              : ""
                          }`}
                          type="button"
                          disabled={Boolean(signupActionBusy)}
                          onClick={() => void runSignupStatus(s.email, "declined")}
                        >
                          <AdminBusyLabel
                            busy={
                              signupActionBusy ===
                              `${String(s.email || "").trim().toLowerCase()}:declined`
                            }
                            busyText="Declining…"
                          >
                            Decline
                          </AdminBusyLabel>
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
                <div className="ea-field">
                  <span>Symbols</span>
                  <p className="ea-hint">Type a symbol and tap Add. Lowercase and uppercase are both fine.</p>
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
                      placeholder="e.g. eurusd or XAUUSD"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
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
                          <button type="button" onClick={() => removeDraftSymbol(symbol)}>
                            ×
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                </div>
                <button
                  className={`admin-btn admin-btn-solid admin-btn-block${eaBusy ? " is-loading" : ""}`}
                  type="submit"
                  disabled={eaBusy}
                >
                  <AdminBusyLabel
                    busy={eaBusy}
                    busyText={editingEaId ? "Saving…" : "Creating…"}
                  >
                    {editingEaId ? "Save profile" : "Create EA"}
                  </AdminBusyLabel>
                </button>
                {editingEaId ? (
                  <button
                    className="admin-btn admin-btn-outline admin-btn-block"
                    type="button"
                    style={{ marginTop: 8 }}
                    disabled={eaBusy}
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
                        <button
                          className="ea-edit-btn"
                          type="button"
                          disabled={Boolean(eaBusy || eaDeleteBusy)}
                          onClick={() => startEdit(ea)}
                        >
                          Edit profile
                        </button>
                        <button
                          className={`ea-delete-btn${eaDeleteBusy === ea.id ? " is-loading" : ""}`}
                          type="button"
                          disabled={Boolean(eaBusy || eaDeleteBusy)}
                          onClick={() => openEaDeleteConfirm(ea)}
                        >
                          {eaDeleteBusy === ea.id ? (
                            <>
                              <span className="admin-btn-spinner" aria-hidden="true" />
                              <span>Deleting…</span>
                            </>
                          ) : (
                            "Delete"
                          )}
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
            <div className="admin-row-actions" style={{ marginBottom: 12 }}>
              {isSuperAdmin ? (
                <button
                  type="button"
                  className="admin-btn admin-btn-ghost"
                  onClick={() => setReactivateOpen((open) => !open)}
                >
                  {reactivateOpen ? "Close" : "Reactivate license key"}
                </button>
              ) : null}
            </div>
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
            
            {isSuperAdmin && reactivateOpen ? (
              <div className="admin-card admin-reactivate-card">
                <h3 className="admin-h3">Reactivate license key</h3>
                <p className="ea-hint">
                  Paste the key only. This clears “locked to another phone” so the
                  client can Unlock on a new device — no email needed.
                </p>
                <form className="license-form" onSubmit={onReactivateLicenseSubmit}>
                  <label className="ea-field">
                    <span>License key *</span>
                    <input
                      className="admin-input"
                      value={reactivateKey}
                      onChange={(e) => setReactivateKey(e.target.value)}
                      placeholder="APEX-XXXX-XXXX"
                      autoCapitalize="characters"
                      required
                    />
                  </label>
                  <button
                    className={`admin-btn admin-btn-solid admin-btn-block${
                      reactivateBusy ? " is-loading" : ""
                    }`}
                    type="submit"
                    disabled={reactivateBusy || Boolean(licenseActionBusy)}
                  >
                    <AdminBusyLabel busy={reactivateBusy} busyText="Reactivating…">
                      Reactivate license key
                    </AdminBusyLabel>
                  </button>
                </form>
              </div>
            ) : null}
<div className="admin-card">
              <form
                className="license-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (licenseGenBusy) return;
                  setLicenseGenBusy(true);
                  try {
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
                  } finally {
                    setLicenseGenBusy(false);
                  }
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
                <button
                  className={`admin-btn admin-btn-solid admin-btn-block${licenseGenBusy ? " is-loading" : ""}`}
                  type="submit"
                  disabled={licenseGenBusy || myEas.length === 0}
                >
                  <AdminBusyLabel busy={licenseGenBusy} busyText="Generating…">
                    Generate License Key
                  </AdminBusyLabel>
                </button>
                <p className="ea-hint" style={{ marginTop: 10 }}>
                  The client is emailed this key automatically via Brevo when server
                  mail is configured.
                </p>
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

            <div className="admin-card admin-keys-card" style={{ marginTop: 14 }}>
              <div className="admin-card-title-row">
                <h3>Generated keys</h3>
                <span className="admin-badge">
                  {licenseQuery
                    ? `${filteredLicenses.length}/${myLicenses.length}`
                    : myLicenses.length}
                </span>
              </div>
              <p className="admin-card-meta" style={{ marginBottom: 10 }}>
                {unusedKeys.length} unused · {usedKeys.length} used ·{" "}
                {connectedKeys.length} connected · {unconnectedKeys.length} not
                connected
              </p>
              <div className="admin-search-row" style={{ marginBottom: 10 }}>
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
                <p className="admin-empty">
                  No keys match “{licenseSearch.trim()}”. Refresh the page, or
                  generate the key again if it never saved.
                </p>
              ) : (
                <div className="license-list">
                  {[...filteredLicenses].reverse().map((entry) => (
                    <div
                      className={`license-row is-compact${entry.used ? " is-used" : ""}${
                        isKeyConnected(entry) ? " is-connected" : ""
                      }${isLicenseExpired(entry) ? " is-expired" : ""}`}
                      key={`${entry.key}-${entry.createdAt}`}
                    >
                      <div className="license-row-main">
                        <button
                          className="license-row-key"
                          type="button"
                          onClick={() => openLicenseDetail(entry)}
                        >
                          {entry.key}
                        </button>
                        <span className="license-row-meta">
                          {entry.clientName ? `${entry.clientName} · ` : ""}
                          {entry.clientEmail || "no email"} · {entry.botName}
                        </span>
                        <span
                          className={`license-status-pill${
                            isKeyConnected(entry)
                              ? " is-connected"
                              : entry.used
                                ? " is-unconnected"
                                : " is-unused"
                          }`}
                        >
                          {licenseStatusLabel(entry)}
                        </span>
                      </div>
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
                          <>
                            <button
                              className={`admin-btn admin-btn-ghost admin-btn-sm${
                                licenseActionBusy === `deactivate:${entry.key}`
                                  ? " is-loading"
                                  : ""
                              }`}
                              type="button"
                              disabled={Boolean(licenseActionBusy)}
                              onClick={() => void onDeactivateLicense(entry.key)}
                            >
                              <AdminBusyLabel
                                busy={licenseActionBusy === `deactivate:${entry.key}`}
                                busyText={entry.used ? "Deactivating…" : "Resetting…"}
                              >
                                {entry.used ? "Deactivate" : "Reset"}
                              </AdminBusyLabel>
                            </button>
                            <button
                              className={`admin-btn admin-btn-outline admin-btn-sm${
                                licenseActionBusy === `reset-scans:${entry.key}`
                                  ? " is-loading"
                                  : ""
                              }`}
                              type="button"
                              disabled={Boolean(licenseActionBusy)}
                              title="Refill this client's daily chart quota for today"
                              onClick={() => void onResetClientScans(entry.key)}
                            >
                              <AdminBusyLabel
                                busy={licenseActionBusy === `reset-scans:${entry.key}`}
                                busyText="Resetting charts…"
                              >
                                Reset charts
                              </AdminBusyLabel>
                            </button>
                          </>
                        ) : null}
                        <button
                          className={`admin-btn admin-btn-outline admin-btn-sm${
                            licenseActionBusy === `delete:${entry.key}`
                              ? " is-loading"
                              : ""
                          }`}
                          type="button"
                          disabled={Boolean(licenseActionBusy)}
                          onClick={() => void onDeleteLicense(entry.key)}
                        >
                          <AdminBusyLabel
                            busy={licenseActionBusy === `delete:${entry.key}`}
                            busyText="Deleting…"
                          >
                            Delete
                          </AdminBusyLabel>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
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
                    className={`admin-btn admin-btn-solid admin-btn-block${profileBusy ? " is-loading" : ""}`}
                    type="submit"
                    disabled={profileBusy}
                  >
                    <AdminBusyLabel busy={profileBusy} busyText="Saving…">
                      Save profile
                    </AdminBusyLabel>
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
              Choose an app accent color, then press Save. Home robot, buttons, highlights, and chart accents update for your clients after you save.
            </p>
            <div className="admin-card">
              <div className="admin-card-title-row">
                <h3>App color</h3>
                <span className="admin-badge">{draftColorNorm}</span>
              </div>
              <div
                className="app-color-preview"
                style={{ ["--preview-color"]: draftColorNorm }}
              >
                <div className="app-color-preview-orb" aria-hidden="true" />
                <div>
                  <strong>Preview</strong>
                  <p className="ea-hint">
                    Pick a color, then press Save. Home robot, lock, and chart accents update for your clients after save.
                  </p>
                </div>
              </div>
              <label className="ea-field" style={{ marginTop: 14 }}>
                <span>Custom color</span>
                <div className="app-color-picker-row">
                  <input
                    className="app-color-swatch"
                    type="color"
                    value={draftColorNorm}
                    onChange={(e) => selectDraftAppColor(e.target.value)}
                    aria-label="Choose app color"
                  />
                  <input
                    className="admin-input"
                    type="text"
                    value={draftAppColor || DEFAULT_APP_COLOR}
                    onChange={(e) => selectDraftAppColor(e.target.value)}
                    placeholder="#ff2d7a"
                  />
                  <button
                    className="admin-btn admin-btn-outline"
                    type="button"
                    onClick={() => selectDraftAppColor(DEFAULT_APP_COLOR)}
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
                      draftColorNorm === String(preset.color).toLowerCase()
                        ? " is-active"
                        : ""
                    }`}
                    style={{ ["--swatch"]: preset.color }}
                    onClick={() => selectDraftAppColor(preset.color)}
                    title={preset.label}
                  >
                    <span className="app-color-preset-dot" aria-hidden="true" />
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
              <div className="app-color-save-row">
                <button
                  className="admin-btn admin-btn-solid admin-btn-block"
                  type="button"
                  disabled={!appColorDirty || appColorSaveBusy}
                  onClick={savePortalAppColor}
                >
                  <AdminBusyLabel busy={appColorSaveBusy} busyText="Saving…">
                    {appColorDirty ? "Save app color" : "Saved"}
                  </AdminBusyLabel>
                </button>
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
                          className={`admin-btn admin-btn-solid${setBusy ? " is-loading" : ""}`}
                          type="button"
                          style={{ alignSelf: "flex-end" }}
                          disabled={setBusy || addBusy}
                          onClick={() => void saveMentorKeyTotal(email)}
                        >
                          <AdminBusyLabel busy={setBusy} busyText="Saving…">
                            Save total
                          </AdminBusyLabel>
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
                          className={`admin-btn admin-btn-outline${addBusy ? " is-loading" : ""}`}
                          type="button"
                          style={{ alignSelf: "flex-end" }}
                          disabled={setBusy || addBusy}
                          onClick={() => void addMentorKeys(email)}
                        >
                          <AdminBusyLabel busy={addBusy} busyText="Adding…">
                            Add keys
                          </AdminBusyLabel>
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
              <article className="admin-stat-card admin-stat-card-action">
                <p className="admin-stat-label">Request payout</p>
                <button
                  className={`admin-btn admin-btn-solid admin-btn-sm admin-withdraw-btn${
                    withdrawRequestBusy ? " is-loading" : ""
                  }`}
                  type="button"
                  disabled={
                    withdrawRequestBusy || !canWithdraw || withdrawLimitHit
                  }
                  onClick={() => void requestCommissionWithdrawal()}
                >
                  <AdminBusyLabel busy={withdrawRequestBusy} busyText="Sending…">
                    {withdrawLimitHit ? "Limit reached" : "Request withdrawal"}
                  </AdminBusyLabel>
                </button>
                <p className="admin-card-meta">
                  {withdrawLimitHit
                    ? `Max ${WITHDRAW_MAX_PER_WEEK}/week — try again later`
                    : `${withdrawRemaining} of ${WITHDRAW_MAX_PER_WEEK} left this week`}
                </p>
                <p className="admin-card-meta">
                  Emails {WITHDRAWAL_REQUEST_EMAIL}
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
                className={`admin-btn admin-btn-solid admin-btn-block${bankingBusy ? " is-loading" : ""}`}
                type="button"
                disabled={bankingBusy}
                onClick={saveMentorBanking}
                style={{ marginTop: 12 }}
              >
                <AdminBusyLabel busy={bankingBusy} busyText="Saving…">
                  Save banking details
                </AdminBusyLabel>
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
                        className={`admin-btn admin-btn-solid admin-btn-block${calendarBusy ? " is-loading" : ""}`}
                        type="submit"
                        disabled={calendarBusy || !selected || locked}
                      >
                        <AdminBusyLabel
                          busy={calendarBusy}
                          busyText="Saving…"
                        >
                          {locked
                            ? "Editing locked (event started)"
                            : calendarDirections.trim()
                              ? "Save signal direction"
                              : "Add signal direction"}
                        </AdminBusyLabel>
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
                                  className={`admin-btn admin-btn-ghost admin-btn-sm${calendarBusy ? " is-loading" : ""}`}
                                  type="button"
                                  disabled={
                                    calendarBusy || !isSignalDirectionEditable(official)
                                  }
                                  onClick={() => void onDeleteCalendarEvent(event.id)}
                                >
                                  <AdminBusyLabel busy={calendarBusy} busyText="Deleting…">
                                    Delete
                                  </AdminBusyLabel>
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
                  const symbol = normalizeBrokerSymbol(hostSymbol || "");
                  const volume = Number(hostVolume);
                  const tradesCount = Math.max(
                    1,
                    Math.min(20, Math.floor(Number(hostTradesCount) || 1))
                  );
                  if (!symbol) {
                    showToast("Enter a symbol");
                    return;
                  }
                  if (!Number.isFinite(volume) || volume <= 0) {
                    showToast("Enter a valid lot size");
                    return;
                  }
                  if (!Number.isFinite(tradesCount) || tradesCount < 1) {
                    showToast("Enter number of trades (1–20)");
                    return;
                  }
                  if (!hostAccounts.length) {
                    showToast("No connected robot clients yet");
                    return;
                  }
                  setHostResult(null);
                  setHostDetailsOpen(false);
                  setHostDelaySec(0);
                  setHostConfirmOpen(true);
                }}
              >
                <label className="ea-field">
                  <span>Symbol</span>
                  <input
                    className="admin-input"
                    value={hostSymbol}
                    onChange={(e) =>
                      setHostSymbol(normalizeBrokerSymbol(e.target.value.replace(/\s+/g, "")))
                    }
                    placeholder="XAUUSDp"
                    autoCapitalize="off"
                    required
                  />
                </label>

                <div className="ea-field">
                  <span>Direction & trades</span>
                  <div className="self-host-side-row" role="group" aria-label="Direction and trade count">
                    <button
                      type="button"
                      className={`self-host-side-btn${hostSide === "BUY" ? " is-active is-buy" : ""}`}
                      onClick={() => setHostSide("BUY")}
                    >
                      BUY
                    </button>
                    <label className="self-host-trades-count" title="Number of trades to open">
                      <span className="sr-only">Number of trades</span>
                      <input
                        className="admin-input self-host-trades-input"
                        type="number"
                        min="1"
                        max="20"
                        step="1"
                        value={hostTradesCount}
                        onChange={(e) => setHostTradesCount(e.target.value)}
                        aria-label="Number of trades to open"
                      />
                    </label>
                    <button
                      type="button"
                      className={`self-host-side-btn${hostSide === "SELL" ? " is-active is-sell" : ""}`}
                      onClick={() => setHostSide("SELL")}
                    >
                      SELL
                    </button>
                  </div>
                  <p className="ea-hint" style={{ marginTop: 6 }}>
                    Middle number = how many trades to open on each connected client
                  </p>
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
                  className={`admin-btn admin-btn-solid admin-btn-block self-host-execute${hostBusy ? " is-loading" : ""}`}
                  type="submit"
                  disabled={hostBusy || !hostAccounts.length}
                >
                  <AdminBusyLabel
                    busy={hostBusy}
                    busyText={hostScheduled ? "SCHEDULED…" : "WORKING…"}
                  >
                    EXECUTE TRADE
                  </AdminBusyLabel>
                </button>
                {hostScheduled ? (
                  <div className="self-host-scheduled">
                    <p>
                      Scheduled {hostScheduled.side} {hostScheduled.symbol} · fires in{" "}
                      {Math.max(
                        0,
                        Math.ceil(
                          (Number(hostScheduled.runAt) - (hostScheduleTick || Date.now())) /
                            1000
                        )
                      )}
                      s
                    </p>
                    <button
                      type="button"
                      className="admin-btn admin-btn-outline admin-btn-sm"
                      onClick={cancelHostSchedule}
                    >
                      Cancel schedule
                    </button>
                  </div>
                ) : null}
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
                    <strong>{Number(hostResult.offline || 0)}</strong> session expired
                  </p>
                  {Number(hostResult.failed || 0) > Number(hostResult.offline || 0) ? (
                    <p>
                      <strong>
                        {Number(hostResult.failed || 0) - Number(hostResult.offline || 0)}
                      </strong>{" "}
                      trade errors
                    </p>
                  ) : null}
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
                    {hostSide} {normalizeBrokerSymbol(hostSymbol || "")}
                  </p>
                  <p className="self-host-modal-meta">
                    Trades: {Math.max(1, Math.min(20, Math.floor(Number(hostTradesCount) || 1)))}
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

                  <div className="self-host-delay">
                    <p className="self-host-delay-label">When should it execute?</p>
                    <div className="self-host-delay-options" role="group" aria-label="Execution timing">
                      {[
                        { sec: 0, label: "Immediately" },
                        { sec: 60, label: "1 minute" },
                        { sec: 300, label: "5 minutes" },
                        { sec: 600, label: "10 minutes" },
                      ].map((opt) => (
                        <button
                          key={opt.sec}
                          type="button"
                          className={`self-host-delay-btn${hostDelaySec === opt.sec ? " is-active" : ""}`}
                          onClick={() => setHostDelaySec(opt.sec)}
                          disabled={hostBusy}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="self-host-modal-actions">
                    <button
                      type="button"
                      className="admin-btn admin-btn-outline"
                      disabled={hostBusy}
                      onClick={() => {
                        setHostConfirmOpen(false);
                        setHostDelaySec(0);
                      }}
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      className={`admin-btn admin-btn-solid${hostBusy ? " is-loading" : ""}`}
                      disabled={hostBusy}
                      onClick={() => confirmHostTrade()}
                    >
                      <AdminBusyLabel
                        busy={hostBusy}
                        busyText={hostDelaySec > 0 ? "SCHEDULING…" : "EXECUTING…"}
                      >
                        {hostDelaySec > 0 ? "SCHEDULE TRADE" : "EXECUTE TRADE"}
                      </AdminBusyLabel>
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
                    <button
                      className={`admin-btn admin-btn-solid admin-btn-block${
                        payoutEmailBusy === normalizeAdminEmail(mentor.email)
                          ? " is-loading"
                          : ""
                      }`}
                      type="button"
                      style={{ marginTop: 12 }}
                      disabled={Boolean(payoutEmailBusy)}
                      onClick={() =>
                        void sendPayoutDoneEmail({
                          mentor,
                          sold,
                          usd,
                          zar,
                          banking,
                        })
                      }
                    >
                      <AdminBusyLabel
                        busy={
                          payoutEmailBusy === normalizeAdminEmail(mentor.email)
                        }
                        busyText="Sending…"
                      >
                        Email payout done
                      </AdminBusyLabel>
                    </button>
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
              {mentorMgmtQuery ? (
                <button
                  className="admin-btn admin-btn-outline admin-btn-sm"
                  type="button"
                  onClick={() => setMentorMgmtSearch("")}
                >
                  Clear search
                </button>
              ) : null}
              <button
                className={`admin-btn admin-btn-solid admin-btn-sm${mentorBulkBusy ? " is-loading" : ""}`}
                type="button"
                disabled={mentorBulkBusy || filteredPendingMentors.length === 0}
                onClick={bulkApprovePendingMentors}
              >
                <AdminBusyLabel busy={mentorBulkBusy} busyText="Approving…">
                  {`Bulk Approve${
                    filteredPendingMentors.length
                      ? ` (${filteredPendingMentors.length})`
                      : ""
                  }`}
                </AdminBusyLabel>
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
                    className={`admin-btn admin-btn-solid admin-btn-block${bypassBusy ? " is-loading" : ""}`}
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
                    <AdminBusyLabel busy={bypassBusy} busyText="Bypassing…">
                      App access bypass
                    </AdminBusyLabel>
                  </button>
                  <button
                    className={`admin-btn admin-btn-outline admin-btn-block${bypassBusy ? " is-loading" : ""}`}
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
                    <AdminBusyLabel busy={bypassBusy} busyText="Bypassing…">
                      Premium chart bypass
                    </AdminBusyLabel>
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
                className={`admin-btn admin-btn-sm${refreshBusy === "mentors" ? " is-loading" : ""}`}
                type="button"
                style={{ marginBottom: 10 }}
                disabled={refreshBusy === "mentors"}
                onClick={refreshMentorsList}
              >
                <AdminBusyLabel busy={refreshBusy === "mentors"} busyText="Refreshing…">
                  Refresh pending
                </AdminBusyLabel>
              </button>
              {pendingMentors.length === 0 ? (
                <p className="admin-empty">No pending mentors</p>
              ) : filteredPendingMentors.length === 0 ? (
                <p className="admin-empty">
                  No pending mentors match “{mentorMgmtSearch.trim()}”.{" "}
                  <button
                    className="admin-link-btn"
                    type="button"
                    onClick={() => setMentorMgmtSearch("")}
                  >
                    Clear search to show {pendingMentors.length} pending
                  </button>
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
                        className={`admin-btn admin-btn-solid admin-btn-sm${
                          mentorActionBusy ===
                          `${normalizeAdminEmail(mentor.email)}:approved`
                            ? " is-loading"
                            : ""
                        }`}
                        type="button"
                        disabled={Boolean(mentorActionBusy)}
                        onClick={() => changeMentorStatus(mentor.email, "approved")}
                      >
                        <AdminBusyLabel
                          busy={
                            mentorActionBusy ===
                            `${normalizeAdminEmail(mentor.email)}:approved`
                          }
                          busyText="Approving…"
                        >
                          Approve
                        </AdminBusyLabel>
                      </button>
                      <button
                        className={`admin-btn admin-btn-danger admin-btn-sm${
                          mentorActionBusy ===
                          `${normalizeAdminEmail(mentor.email)}:declined`
                            ? " is-loading"
                            : ""
                        }`}
                        type="button"
                        disabled={Boolean(mentorActionBusy)}
                        onClick={() => changeMentorStatus(mentor.email, "declined")}
                      >
                        <AdminBusyLabel
                          busy={
                            mentorActionBusy ===
                            `${normalizeAdminEmail(mentor.email)}:declined`
                          }
                          busyText="Declining…"
                        >
                          Decline
                        </AdminBusyLabel>
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
                          {isSuperAdmin ? (
                            <div className="admin-inline-field" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                              <input
                                className="admin-input"
                                type="password"
                                autoComplete="new-password"
                                placeholder="New password"
                                value={mentorPasswordDrafts[normalizeAdminEmail(mentor.email)] || ""}
                                onChange={(e) =>
                                  setMentorPasswordDrafts((prev) => ({
                                    ...prev,
                                    [normalizeAdminEmail(mentor.email)]: e.target.value,
                                  }))
                                }
                                style={{ minWidth: 120, maxWidth: 160 }}
                              />
                              <button
                                className={`admin-btn admin-btn-outline admin-btn-sm${
                                  mentorPasswordBusy === normalizeAdminEmail(mentor.email)
                                    ? " is-loading"
                                    : ""
                                }`}
                                type="button"
                                disabled={mentorPasswordBusy === normalizeAdminEmail(mentor.email)}
                                onClick={() => void setMentorPasswordFor(mentor.email)}
                              >
                                <AdminBusyLabel
                                  busy={
                                    mentorPasswordBusy === normalizeAdminEmail(mentor.email)
                                  }
                                  busyText="Saving…"
                                >
                                  Set password
                                </AdminBusyLabel>
                              </button>
                            </div>
                          ) : null}
                          <button
                            className={`admin-btn admin-btn-danger admin-btn-sm${
                              mentorActionBusy ===
                              `${normalizeAdminEmail(mentor.email)}:declined`
                                ? " is-loading"
                                : ""
                            }`}
                            type="button"
                            disabled={Boolean(mentorActionBusy)}
                            onClick={() => changeMentorStatus(mentor.email, "declined")}
                          >
                            <AdminBusyLabel
                              busy={
                                mentorActionBusy ===
                                `${normalizeAdminEmail(mentor.email)}:declined`
                              }
                              busyText="Declining…"
                            >
                              Decline
                            </AdminBusyLabel>
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
                        className={`admin-btn admin-btn-solid admin-btn-sm${
                          mentorActionBusy ===
                          `${normalizeAdminEmail(mentor.email)}:approved`
                            ? " is-loading"
                            : ""
                        }`}
                        type="button"
                        disabled={Boolean(mentorActionBusy)}
                        onClick={() => changeMentorStatus(mentor.email, "approved")}
                      >
                        <AdminBusyLabel
                          busy={
                            mentorActionBusy ===
                            `${normalizeAdminEmail(mentor.email)}:approved`
                          }
                          busyText="Approving…"
                        >
                          Approve
                        </AdminBusyLabel>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {isSuperAdmin && adminPage === "top-mentors" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Top Mentors</h2>
            <p className="admin-sub">
              Approved mentors only — ranked by clients unlocked, keys used, and paid unlocks.
              Bypassed emails are excluded from counts.
            </p>
            <div className="admin-card">
              <div className="admin-card-head">
                <h3>
                  Leaderboard ·{" "}
                  <span className="admin-muted">{topMentorRows.length}</span>
                </h3>
                <button
                  className={`admin-btn admin-btn-outline admin-btn-sm${
                    refreshBusy === "mentors" ? " is-loading" : ""
                  }`}
                  type="button"
                  disabled={refreshBusy === "mentors"}
                  onClick={() => {
                    void refreshMentorsList();
                    void refreshLicenses?.();
                  }}
                >
                  <AdminBusyLabel busy={refreshBusy === "mentors"} busyText="Refreshing…">
                    Refresh
                  </AdminBusyLabel>
                </button>
              </div>
              {topMentorRows.length === 0 ? (
                <p className="admin-empty">No approved mentors yet</p>
              ) : (
                <div className="admin-top-list">
                  {topMentorRows.map((row, index) => {
                    const initials = String(row.mentor.username || row.email || "?")
                      .trim()
                      .slice(0, 2)
                      .toUpperCase();
                    const openKey = row.email || row.mentor.id || "";
                    const emailsOpen = topMentorEmailsOpen === openKey;
                    return (
                      <div className="admin-top-card" key={row.mentor.id || row.email}>
                        <div className="admin-avatar-circle" aria-hidden="true">
                          {initials}
                        </div>
                        <div className="top-mentor-main">
                          <div className="top-mentor-title-row">
                            <strong>
                              #{index + 1} · {row.mentor.username || "Mentor"}
                            </strong>
                            <span
                              className={`admin-badge${
                                row.status === "approved"
                                  ? " is-approved"
                                  : row.status === "declined"
                                    ? " is-declined"
                                    : " is-pending"
                              }`}
                            >
                              {row.status}
                            </span>
                          </div>
                          <p className="admin-card-meta">{row.email}</p>
                          <p className="admin-card-meta">
                            {row.clients} client{row.clients === 1 ? "" : "s"} ·{" "}
                            {row.used}/{row.keys} keys used · {row.sold} paid
                            {row.bypassedClients
                              ? ` · ${row.bypassedClients} bypassed excluded`
                              : ""}
                          </p>
                          <div className="top-mentor-actions">
                            <button
                              type="button"
                              className="admin-btn admin-btn-outline admin-btn-sm"
                              onClick={() =>
                                setTopMentorEmailsOpen((prev) =>
                                  prev === openKey ? "" : openKey
                                )
                              }
                            >
                              {emailsOpen
                                ? "Hide emails"
                                : `View emails (${row.clientEmails.length})`}
                            </button>
                          </div>
                          {emailsOpen ? (
                            <div className="top-mentor-emails">
                              {row.clientRows.length === 0 ? (
                                <p className="admin-card-meta">
                                  No client emails (bypassed excluded)
                                </p>
                              ) : (
                                <ul className="top-mentor-email-list">
                                  {row.clientRows.map((client) => (
                                    <li key={client.email}>
                                      <a href={`mailto:${client.email}`}>{client.email}</a>
                                      {client.name ? (
                                        <span className="admin-muted"> · {client.name}</span>
                                      ) : null}
                                      <span
                                        className={`admin-badge top-mentor-email-badge${
                                          client.used ? " is-approved" : " is-pending"
                                        }`}
                                      >
                                        {client.used ? "used" : "unused"}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}

        {isSuperAdmin && adminPage === "emails" && (
          <section className="admin-page is-active">
            <h2 className="admin-h1">Email Management</h2>
            <p className="admin-sub">
              All clients from signups and mentor license keys — send a message or
              resend license keys.
            </p>

            <div className="admin-card">
              <div className="admin-toolbar admin-client-mgmt-toolbar">
                <input
                  className="admin-input"
                  type="search"
                  value={emailSearch}
                  onChange={(e) => setEmailSearch(e.target.value)}
                  placeholder="Search by email, name, or mentor"
                  aria-label="Search client emails"
                />
              </div>

              <div className="admin-form-stack" style={{ marginBottom: 14 }}>
                <label className="admin-check">
                  <input
                    type="radio"
                    name="email-mode"
                    checked={emailMode === "message"}
                    onChange={() => setEmailMode("message")}
                  />
                  Custom message
                </label>
                <label className="admin-check">
                  <input
                    type="radio"
                    name="email-mode"
                    checked={emailMode === "license"}
                    onChange={() => setEmailMode("license")}
                  />
                  Resend license key
                </label>
              </div>

              {emailMode === "message" ? (
                <div className="admin-form-stack" style={{ marginBottom: 14 }}>
                  <label className="admin-auth-label">
                    Subject
                    <input
                      className="admin-input"
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                      placeholder="e.g. ApexEA update"
                      maxLength={180}
                    />
                  </label>
                  <label className="admin-auth-label">
                    Message
                    <textarea
                      className="admin-input"
                      rows={5}
                      value={emailMessage}
                      onChange={(e) => setEmailMessage(e.target.value)}
                      placeholder="Write the email body…"
                      style={{ resize: "vertical", minHeight: 110 }}
                    />
                  </label>
                </div>
              ) : (
                <p className="admin-card-meta">
                  Sends each client their latest license key email (clients without a
                  key are skipped).
                </p>
              )}

              <div className="admin-toolbar" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                <button
                  className="admin-btn admin-btn-outline admin-btn-sm"
                  type="button"
                  disabled={!filteredEmailClients.length}
                  onClick={selectAllFilteredEmails}
                >
                  Select shown
                </button>
                <button
                  className="admin-btn admin-btn-outline admin-btn-sm"
                  type="button"
                  disabled={!Object.keys(emailSelected).length}
                  onClick={clearEmailSelection}
                >
                  Clear
                </button>
                <button
                  className={`admin-btn admin-btn-solid admin-btn-sm${
                    emailSendBusy ? " is-loading" : ""
                  }`}
                  type="button"
                  disabled={emailSendBusy || !Object.keys(emailSelected).length}
                  onClick={() => void sendEmailsToClients({ all: false })}
                >
                  <AdminBusyLabel busy={emailSendBusy} busyText="Sending…">
                    {`Send selected (${Object.keys(emailSelected).length})`}
                  </AdminBusyLabel>
                </button>
                <button
                  className={`admin-btn admin-btn-solid admin-btn-sm${
                    emailSendBusy ? " is-loading" : ""
                  }`}
                  type="button"
                  disabled={emailSendBusy || !emailClients.length}
                  onClick={() => void sendEmailsToClients({ all: true })}
                >
                  <AdminBusyLabel busy={emailSendBusy} busyText="Sending…">
                    {`Send all (${emailClients.length})`}
                  </AdminBusyLabel>
                </button>
              </div>

              <p className="admin-card-meta">
                {emailQuery
                  ? `Showing ${filteredEmailClients.length} of ${emailClients.length} clients`
                  : `Total clients: ${emailClients.length}`}
                {` · ${emailClients.filter((r) => r.fromLicense).length} from mentors/licenses`}
                {` · ${emailClients.filter((r) => r.fromSignup).length} from signups`}
                {Object.keys(emailSelected).length
                  ? ` · ${Object.keys(emailSelected).length} selected`
                  : ""}
              </p>

              {emailClients.length === 0 ? (
                <p className="admin-empty">No client emails yet</p>
              ) : filteredEmailClients.length === 0 ? (
                <p className="admin-empty">
                  No clients match “{emailSearch.trim()}”
                </p>
              ) : (
                filteredEmailClients.map((row) => {
                  const mentorLabel =
                    row.mentors.filter(Boolean).join(", ") ||
                    row.mentorEmails.filter(Boolean).join(", ") ||
                    "";
                  return (
                    <label className="admin-email-row" key={row.email}>
                      <input
                        type="checkbox"
                        checked={Boolean(emailSelected[row.email])}
                        onChange={() => toggleEmailSelect(row.email)}
                      />
                      <span className="admin-name">{row.email}</span>
                      <span className="admin-muted">
                        {[
                          row.name || null,
                          mentorLabel ? `Mentor: ${mentorLabel}` : null,
                          row.keys ? `${row.keys} key${row.keys === 1 ? "" : "s"}` : "No key yet",
                          row.signupStatus
                            ? `Signup: ${row.signupStatus}`
                            : row.fromLicense
                              ? "License only"
                              : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </section>
        )}
      </div>

      {eaDeleteConfirm ? (
        <div
          className="ea-delete-modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEaDeleteConfirm();
          }}
        >
          <div
            className="admin-card ea-delete-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm EA delete"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="ea-delete-modal-title">Delete this EA?</h3>
            <p className="ea-delete-modal-copy">
              Type your mentor email to permanently delete{" "}
              <strong>{eaDeleteConfirm.name}</strong>. This cannot be undone.
            </p>
            <label className="ea-field">
              <span>Your email</span>
              <input
                className="admin-input"
                type="email"
                autoComplete="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={eaDeleteEmail}
                onChange={(e) => setEaDeleteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void confirmEaDelete();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeEaDeleteConfirm();
                  }
                }}
                placeholder={adminSession?.email || "mentor@email.com"}
                disabled={Boolean(eaDeleteBusy)}
                autoFocus
              />
            </label>
            <div className="ea-delete-modal-actions">
              <button
                className="admin-btn admin-btn-outline"
                type="button"
                disabled={Boolean(eaDeleteBusy)}
                onClick={closeEaDeleteConfirm}
              >
                Cancel
              </button>
              <button
                className={`admin-btn admin-btn-danger${eaDeleteBusy ? " is-loading" : ""}`}
                type="button"
                disabled={Boolean(eaDeleteBusy)}
                onClick={() => void confirmEaDelete()}
              >
                <AdminBusyLabel busy={Boolean(eaDeleteBusy)} busyText="Deleting…">
                  Delete permanently
                </AdminBusyLabel>
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
                <strong className="license-side-plain" x-apple-data-detectors="false">
                  {latestLicenseMeta?.email || "—"}
                </strong>
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
                  <strong className="license-side-plain" x-apple-data-detectors="false">
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
            <button
              className={`admin-btn admin-btn-outline admin-btn-block${
                licenseActionBusy === `email:${latestKey}` ? " is-loading" : ""
              }`}
              type="button"
              disabled={Boolean(licenseActionBusy) || !latestLicenseMeta?.email}
              onClick={async () => {
                if (!latestKey) return;
                const actionKey = `email:${latestKey}`;
                setLicenseActionBusy(actionKey);
                try {
                  const data = await resendLicenseEmailRemote({
                    key: latestKey,
                    clientEmail: latestLicenseMeta?.email,
                    clientName: latestLicenseMeta?.name,
                    botName: latestLicenseMeta?.botName,
                    mentorName: latestLicenseMeta?.mentorName,
                    mentorEmail: latestLicenseMeta?.mentorEmail,
                    duration: latestLicenseMeta?.durationId || latestLicenseMeta?.duration,
                    expiresAt: latestLicenseMeta?.expiresAt,
                  });
                  if (data?.ok || data?.email?.ok) {
                    showToast(`License emailed to ${latestLicenseMeta?.email}`);
                  } else if (data?.email?.skipped) {
                    showToast(
                      "Brevo not configured — add BREVO_API_KEY + BREVO_SENDER_EMAIL on Vercel"
                    );
                  } else {
                    showToast(
                      data?.email?.error || data?.error || "Could not send license email"
                    );
                  }
                } catch (error) {
                  showToast(error?.message || "Could not send license email");
                } finally {
                  setLicenseActionBusy("");
                }
              }}
            >
              <AdminBusyLabel
                busy={licenseActionBusy === `email:${latestKey}`}
                busyText="Sending…"
              >
                Email key to client
              </AdminBusyLabel>
            </button>
            {isSuperAdmin ? (
              <>
                <button
                  className={`admin-btn admin-btn-outline admin-btn-block${
                    licenseActionBusy === `deactivate:${latestKey}` ? " is-loading" : ""
                  }`}
                  type="button"
                  disabled={Boolean(licenseActionBusy)}
                  onClick={() => void onDeactivateLicense(latestKey)}
                >
                  <AdminBusyLabel
                    busy={licenseActionBusy === `deactivate:${latestKey}`}
                    busyText={
                      latestLicenseMeta?.status === "Used" ? "Deactivating…" : "Resetting…"
                    }
                  >
                    {latestLicenseMeta?.status === "Used" ? "Deactivate key" : "Reset key"}
                  </AdminBusyLabel>
                </button>
                <button
                  className={`admin-btn admin-btn-solid admin-btn-block${
                    licenseActionBusy === `reset-scans:${latestKey}` ? " is-loading" : ""
                  }`}
                  type="button"
                  disabled={Boolean(licenseActionBusy)}
                  onClick={() => void onResetClientScans(latestKey)}
                >
                  <AdminBusyLabel
                    busy={licenseActionBusy === `reset-scans:${latestKey}`}
                    busyText="Resetting charts…"
                  >
                    Reset daily charts
                  </AdminBusyLabel>
                </button>
              </>
            ) : null}
            <button
              className={`admin-btn admin-btn-ghost admin-btn-block${
                licenseActionBusy === `delete:${latestKey}` ? " is-loading" : ""
              }`}
              type="button"
              disabled={Boolean(licenseActionBusy)}
              onClick={() => void onDeleteLicense(latestKey)}
            >
              <AdminBusyLabel
                busy={licenseActionBusy === `delete:${latestKey}`}
                busyText="Deleting…"
              >
                Delete key
              </AdminBusyLabel>
            </button>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
