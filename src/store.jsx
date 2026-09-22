import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { mediaUrl } from "./apiOrigin.js";
import { clearBotPhotoCache, prefetchBotPhotos } from "./botPhotoCache.js";
import {
  fetchSignups,
  mergeSignups,
  submitSignup,
  clearSignupAccessBypassed,
  updateSignupAccessBypassed,
  updateSignupAccessPaid,
  updateSignupPremiumScanner,
  updateSignupStatus,
} from "./signupsApi.js";
import {
  createLicenseRemote,
  createLicensesBulkRemote,
  deactivateLicenseRemote,
  deleteLicenseRemote,
  fetchLicense,
  fetchLicenses,
  fetchLicensesByEmail,
  mergeLicenses,
  markLicenseUsedRemote,
  normalizeLicenseKey,
  licenseKeyVariants,
  isLicenseExpired,
  resolveLicenseExpiry,
  photoFreshness,
  pickFresherPhoto,
  uploadBotPhotoRemote,
  rememberDeletedLicenseKey,
  isRememberedDeletedLicenseKey,
  filterOutDeletedLicenses,
  resetClientScansRemote,
} from "./licensesApi.js";
import { getOrCreateDeviceId } from "./deviceId.js";
import {
  clearDeviceBypass,
  hasDeviceAccess,
  isSignupEntitled,
  rememberDeviceAccess,
} from "./deviceAccess.js";
import {
  DEFAULT_MENTOR_LICENSE_KEYS,
  fetchMentors,
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_USERNAME,
  updateMentorAppColor,
} from "./mentorsApi.js";
import { recordTrade } from "./dailyTradeHistory.js";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";
import {
  ackPendingTradeEvents,
  fetchPendingTradeEvents,
} from "./tradeEventsApi.js";
import {
  DEFAULT_APP_COLOR,
  applyAppTheme,
  normalizeHexColor,
} from "./theme.js";

const STORAGE_KEY = "apexea-app-v1";
const BACKUP_KEY = "apexea-app-v1-backup";
const MT5_SESSION_KEY = "apexea-mt5-session";
export const ADMIN_PATH = "/admin";

export function isAdminPath(pathname = typeof window !== "undefined" ? window.location.pathname : "/") {
  const path = String(pathname || "/")
    .replace(/\/+$/, "")
    .toLowerCase() || "/";
  return path === ADMIN_PATH || path.endsWith(ADMIN_PATH);
}

/** Capacitor Android/iOS shell — client trading app only (no mentor portal). */
export function isNativeApp() {
  try {
    return Boolean(
      typeof window !== "undefined" &&
        window.Capacitor &&
        typeof window.Capacitor.isNativePlatform === "function" &&
        window.Capacitor.isNativePlatform()
    );
  } catch {
    return false;
  }
}

function loadMt5Session() {
  try {
    const raw = localStorage.getItem(MT5_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistMt5Session(session) {
  try {
    if (!session) localStorage.removeItem(MT5_SESSION_KEY);
    else localStorage.setItem(MT5_SESSION_KEY, JSON.stringify(session));
  } catch {
    // ignore
  }
}

export const DEFAULT_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "USDCHF",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "EURGBP",
  "EURJPY",
  "GBPJPY",
  "XAUUSD",
  "XAGUSD",
  "BTCUSD",
  "ETHUSD",
  "NAS100",
  "US30",
];

export const STRATEGY_LABELS = {
  scalper: "Scalper",
  trend: "Trend Follower",
  grid: "Grid",
  news: "News Trader",
};

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeSymbol(raw) {
  return normalizeBrokerSymbol(raw);
}

function randomLicenseKey() {
  // Avoid 0/O/1/I/L so keys stay clear when typed on another phone.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const chunk = () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(
      ""
    );
  return `APEX-${chunk()}-${chunk()}`;
}

function parseState(raw) {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function eaCount(state) {
  return Array.isArray(state?.eas) ? state.eas.length : 0;
}

function loadState() {
  try {
    const primary = parseState(localStorage.getItem(STORAGE_KEY));
    const backup = parseState(localStorage.getItem(BACKUP_KEY));
    if (eaCount(primary) === 0 && eaCount(backup) > 0) {
      return {
        ...(primary || {}),
        eas: backup.eas,
        bots: Array.isArray(backup.bots) ? backup.bots : primary?.bots || [],
        licenseKeys: Array.isArray(backup.licenseKeys)
          ? backup.licenseKeys
          : primary?.licenseKeys || [],
        catalog: backup.catalog?.length ? backup.catalog : primary?.catalog,
        symbolMeta: backup.symbolMeta || primary?.symbolMeta || {},
        appColor: primary?.appColor || backup.appColor || DEFAULT_APP_COLOR,
        coverEmail: primary?.coverEmail || backup.coverEmail || "",
        signups: primary?.signups?.length ? primary.signups : backup.signups || [],
        activeInterface: primary?.activeInterface || backup.activeInterface || "zeta",
        premiumScannerEmails: Array.isArray(primary?.premiumScannerEmails)
          ? primary.premiumScannerEmails
          : backup.premiumScannerEmails || [],
      };
    }
    // If a refresh wiped keys from primary but backup still has them, restore.
    if (
      primary &&
      backup &&
      Array.isArray(backup.licenseKeys) &&
      backup.licenseKeys.length >
        (Array.isArray(primary.licenseKeys) ? primary.licenseKeys.length : 0)
    ) {
      const byKey = new Map();
      for (const row of [
        ...(Array.isArray(primary.licenseKeys) ? primary.licenseKeys : []),
        ...backup.licenseKeys,
      ]) {
        const key = String(row?.key || "")
          .trim()
          .toUpperCase();
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, row);
      }
      return {
        ...primary,
        licenseKeys: Array.from(byKey.values()),
      };
    }
    return primary || backup;
  } catch {
    return null;
  }
}

function isRealProfilePhoto(value) {
  const photo = String(value || "").trim();
  if (!photo || photo === "/logo.png") return false;
  return (
    photo.startsWith("data:image/") ||
    photo.startsWith("/api/licenses/photo") ||
    /^https?:\/\//i.test(photo)
  );
}

/** Photos kept in localStorage must stay tiny — mobile Safari quota is ~5MB total. */
const MAX_STORED_DATA_URL = 48_000;

function slimPhotoForStorage(value, botId = "") {
  const photo = String(value || "").trim();
  const id = String(botId || "").trim();
  // Keep the packaged logo as-is. Never invent a /api/licenses/photo URL for it —
  // that 404s for most bots and leaves Home with a broken image for ~1s.
  if (!photo || photo === "/logo.png") return "/logo.png";
  if (photo.startsWith("/api/licenses/photo") || /^https?:\/\//i.test(photo)) return photo;
  if (photo.startsWith("data:image/")) {
    // Large embeds blow quota — keep a durable API path so Home can still load.
    if (photo.length > MAX_STORED_DATA_URL) {
      return id
        ? `/api/licenses/photo?botId=${encodeURIComponent(id)}&v=full`
        : "/logo.png";
    }
    return photo;
  }
  return photo;
}

/** Prefer a real uploaded/synced photo over the placeholder logo. */
function pickProfilePhoto(...candidates) {
  for (const value of candidates) {
    if (isRealProfilePhoto(value)) return String(value).trim();
  }
  for (const value of candidates) {
    const photo = String(value || "").trim();
    if (photo) return photo;
  }
  return "/logo.png";
}

function slimPayloadForStorage(payload) {
  return {
    ...payload,
    eas: (payload.eas || []).map((ea) => ({
      ...ea,
      ownerEmail: String(ea.ownerEmail || ea.mentorEmail || "")
        .trim()
        .toLowerCase(),
      ownerId: String(ea.ownerId || ea.mentorId || "").trim(),
      photo: slimPhotoForStorage(ea.photo, ea.id),
    })),
    bots: (payload.bots || []).map((bot) => ({
      ...bot,
      photo: slimPhotoForStorage(bot.photo, bot.id),
    })),
    licenseKeys: (payload.licenseKeys || []).map((row) => ({
      ...row,
      bot: row.bot
        ? {
            ...row.bot,
            photo: slimPhotoForStorage(row.bot.photo, row.bot.id || row.botId),
          }
        : row.bot,
    })),
  };
}

function stripAllEmbeddedPhotos(payload) {
  const wipe = (photo, botId = "") => {
    const value = String(photo || "").trim();
    const id = String(botId || "").trim();
    if (!value || value === "/logo.png") return "/logo.png";
    if (value.startsWith("/api/licenses/photo") || /^https?:\/\//i.test(value)) return value;
    // Drop oversized data embeds — only invent an API path when there were real bytes.
    if (value.startsWith("data:image/") && id) {
      return `/api/licenses/photo?botId=${encodeURIComponent(id)}&v=full`;
    }
    return "/logo.png";
  };
  return {
    ...payload,
    eas: (payload.eas || []).map((ea) => ({ ...ea, photo: wipe(ea.photo, ea.id) })),
    bots: (payload.bots || []).map((bot) => ({ ...bot, photo: wipe(bot.photo, bot.id) })),
    licenseKeys: (payload.licenseKeys || []).map((row) => ({
      ...row,
      bot: row.bot
        ? { ...row.bot, photo: wipe(row.bot.photo, row.bot.id || row.botId) }
        : row.bot,
    })),
  };
}

/** Prefer durable API photo paths so Home can show full-quality bytes. */
async function materializePhotoForLicense(photo) {
  const value = String(photo || "").trim();
  if (!value || value === "/logo.png") return "/logo.png";
  if (value.startsWith("/api/licenses/photo") || /^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith("data:image/")) return value;
  return value;
}

function stabilizePayload(payload) {
  let slim = slimPayloadForStorage(payload);
  // Never overwrite a populated robot store with an empty shell (quota races /
  // Strict Mode remounts). That made the app "forget" bots and look like old code.
  try {
    const existing = parseState(localStorage.getItem(STORAGE_KEY));
    if (existing) {
      const nextEas = eaCount(slim);
      const prevEas = eaCount(existing);
      const prevActive = (existing.bots || []).some((bot) => bot?.active);
      const nextActive = (slim.bots || []).some((bot) => bot?.active);
      if (nextEas === 0 && prevEas > 0) {
        slim = {
          ...slim,
          eas: existing.eas,
          bots: existing.bots,
          licenseKeys:
            Array.isArray(slim.licenseKeys) && slim.licenseKeys.length
              ? slim.licenseKeys
              : existing.licenseKeys,
        };
      } else if (!nextActive && prevActive && Array.isArray(existing.bots)) {
        slim = {
          ...slim,
          bots: existing.bots,
          eas: slim.eas?.length ? slim.eas : existing.eas,
        };
      }
    }
  } catch {
    // ignore parse errors
  }
  return slim;
}

function saveState(payload) {
  const slim = stabilizePayload(payload);
  const raw = JSON.stringify(slim);
  localStorage.setItem(STORAGE_KEY, raw);
  // Keep the last non-empty EA snapshot so an empty overwrite can be recovered.
  if (eaCount(slim) > 0) {
    try {
      localStorage.setItem(BACKUP_KEY, raw);
    } catch {
      // Backup is optional — primary save already succeeded.
    }
  }
}

function clearEaBackup() {
  try {
    localStorage.removeItem(BACKUP_KEY);
  } catch {
    // ignore
  }
}

function clearAppStoragePressure() {
  // Keep primary + backup + device access — never wipe robot memory under quota pressure.
  try {
    clearBotPhotoCache();
  } catch {
    // ignore
  }
  try {
    // Drop known heavy keys that are not required for EA save.
    // Do NOT clear apexea-daily-scans-v1 — quotas must persist through the day.
    // Do NOT clear BACKUP_KEY — recovering robots after a bad write depends on it.
    const keep = new Set([
      STORAGE_KEY,
      BACKUP_KEY,
      "apexea-app-v1-backup",
      "apexea-daily-scans-v1",
      "apexea-device-id",
      "apexea-device-access-v1",
      "apexea-build-id-v1",
      "apexea-shell-gen-v1",
      "apexea-mt5-session",
      "apexea-trade-history-v2",
    ]);
    localStorage.removeItem("apexea-float-pos");
    localStorage.removeItem("apexea-float-pos-zeta");
    localStorage.removeItem("apexea-float-pos-v2");
    localStorage.removeItem("apexea-self-host-recent-v1");
    localStorage.removeItem("apexea-trade-management");
    // Sweep other apexea scratch keys that can bloat Safari's ~5MB quota.
    const doomed = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || keep.has(key)) continue;
      if (
        key.startsWith("apexea-") &&
        (key.includes("cache") ||
          key.includes("float") ||
          key.includes("draft") ||
          key.includes("scratch"))
      ) {
        doomed.push(key);
      }
    }
    doomed.forEach((key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

const defaultState = {
  activeInterface: "zeta",
  coverEmail: "",
  signups: [],
  eas: [],
  bots: [],
  licenseKeys: [],
  catalog: [...DEFAULT_SYMBOLS],
  symbolMeta: {},
  appColor: DEFAULT_APP_COLOR,
  toast: "",
};

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const savedRaw = loadState();
  const saved = savedRaw
    ? {
        ...savedRaw,
        ...slimPayloadForStorage(savedRaw),
      }
    : null;
  // Free quota from older oversized photo embeds / backups as soon as the app boots.
  if (typeof window !== "undefined") {
    try {
      clearAppStoragePressure();
      if (saved) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(slimPayloadForStorage(saved)));
      }
    } catch {
      try {
        clearAppStoragePressure();
        if (saved) {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(stripAllEmbeddedPhotos(saved))
          );
        }
      } catch {
        // ignore — persist effect will keep trying
      }
    }
  }
  const [activeInterface, setActiveInterface] = useState(
    saved?.activeInterface === "v2" ? "v2" : "zeta"
  );
  const [coverEmail, setCoverEmail] = useState(saved?.coverEmail || "");
  const [signups, setSignups] = useState(saved?.signups || []);
  const [eas, setEas] = useState(saved?.eas || []);
  const [bots, setBots] = useState(saved?.bots || []);
  const [licenseKeys, setLicenseKeys] = useState(() =>
    filterOutDeletedLicenses(saved?.licenseKeys || [])
  );
  const [catalog, setCatalog] = useState(
    saved?.catalog?.length ? saved.catalog : [...DEFAULT_SYMBOLS]
  );
  const [symbolMeta, setSymbolMeta] = useState(saved?.symbolMeta || {});
  const [appColor, setAppColorState] = useState(
    normalizeHexColor(saved?.appColor || DEFAULT_APP_COLOR)
  );
  const [premiumScannerEmails, setPremiumScannerEmails] = useState(() => {
    const list = Array.isArray(saved?.premiumScannerEmails)
      ? saved.premiumScannerEmails
      : [];
    return list
      .map((email) =>
        String(email || "")
          .trim()
          .toLowerCase()
      )
      .filter((email) => email.includes("@"));
  });
  /** mentorEmail → portal username (for client header) */
  const [mentorDirectory, setMentorDirectory] = useState({});
  const [mentorThemes, setMentorThemes] = useState({});
  const portalThemeOwnerRef = useRef("");
  const [toast, setToast] = useState("");
  const [adminOpen, setAdminOpenState] = useState(() =>
    typeof window !== "undefined" ? isAdminPath() && !isNativeApp() : false
  );
  const [adminPage, setAdminPage] = useState("dashboard");
  const [lockStep, setLockStep] = useState("cover");
  const lockStepRef = useRef(lockStep);
  useEffect(() => {
    lockStepRef.current = lockStep;
  }, [lockStep]);
  const [pairsOpen, setPairsOpen] = useState(false);
  const [zetaView, setZetaView] = useState("home");
  const [v2View, setV2View] = useState("home");
  const [v2Running, setV2Running] = useState(false);
  const [v2SymTab, setV2SymTab] = useState("allowed");
  const [editingSymbol, setEditingSymbol] = useState(null);
  const [editingEaId, setEditingEaId] = useState(null);
  const [mt5Session, setMt5SessionState] = useState(() => loadMt5Session());
  const [engineMode, setEngineMode] = useState("idle");
  const [engineStep, setEngineStep] = useState(0);
  const [engineLogs, setEngineLogs] = useState([]);
  const [orbTradeLive, setOrbTradeLive] = useState(null);
  const persistReady = useRef(false);

  const syncAdminPath = useCallback((open) => {
    if (typeof window === "undefined") return;
    const onAdmin = isAdminPath();
    if (open && !onAdmin) {
      window.history.pushState({ apexAdmin: true }, "", ADMIN_PATH);
    } else if (!open && onAdmin) {
      window.history.pushState({ apexAdmin: false }, "", "/");
    }
  }, []);

  const openAdmin = useCallback(
    (page = "dashboard") => {
      if (isNativeApp()) return;
      if (page) setAdminPage(page);
      setAdminOpenState(true);
      syncAdminPath(true);
    },
    [syncAdminPath]
  );

  const setAdminOpen = useCallback(
    (open) => {
      if (open) {
        if (isNativeApp()) return;
        openAdmin("dashboard");
        return;
      }
      setAdminOpenState(false);
      syncAdminPath(false);
    },
    [openAdmin, syncAdminPath]
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    function onPopState() {
      if (isNativeApp()) {
        if (isAdminPath()) {
          window.history.replaceState({ apexAdmin: false }, "", "/");
        }
        setAdminOpenState(false);
        return;
      }
      setAdminOpenState(isAdminPath());
    }
    window.addEventListener("popstate", onPopState);
    // Deep-link /admin on first load — blocked in the native trading app.
    if (isNativeApp()) {
      if (isAdminPath()) window.history.replaceState({ apexAdmin: false }, "", "/");
      setAdminOpenState(false);
    } else if (isAdminPath()) {
      setAdminOpenState(true);
    }
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const previous = document.title;
    if (adminOpen) document.title = "Admin — APEX EA";
    else document.title = previous.includes("Admin") ? "apex-ea" : previous;
    return () => {
      document.title = previous;
    };
  }, [adminOpen]);

  const setMt5Session = useCallback((session) => {
    setMt5SessionState(session);
    persistMt5Session(session);
  }, []);

  const pushEngineLog = useCallback((line) => {
    setEngineLogs((prev) => [...prev.slice(-40), String(line)]);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(""), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = useCallback((message) => setToast(message), []);

  useEffect(() => {
    applyAppTheme(appColor);
  }, [appColor]);

  const setAppColor = useCallback(
    async (next, options = {}) => {
      const color = normalizeHexColor(next);
      setAppColorState(color);
      applyAppTheme(color);
      const persistEmail = normalizeEmail(options.persistEmail || "");
      if (persistEmail) {
        portalThemeOwnerRef.current = persistEmail;
        try {
          await updateMentorAppColor(persistEmail, color);
          setMentorThemes((prev) => {
            const nextThemes = { ...prev, [persistEmail]: color };
            // Brand color also drives license mentors that inherit it.
            if (persistEmail === normalizeEmail(SUPER_ADMIN_EMAIL)) {
              nextThemes["trapgoatkaymow@gmail.com"] = color;
            }
            return nextThemes;
          });
        } catch (error) {
          showToast(error?.message || "Could not save app color");
          return color;
        }
      }
      if (!options.silent) showToast("App color updated");
      return color;
    },
    [showToast]
  );

  const lastPersistRawRef = useRef("");
  const persistTimerRef = useRef(0);

  useEffect(() => {
    // Skip the first run so Strict Mode remounts cannot blank a prior save
    // before React state finishes hydrating from localStorage.
    if (!persistReady.current) {
      persistReady.current = true;
      return undefined;
    }

    const payload = {
      activeInterface,
      coverEmail,
      signups,
      eas,
      bots,
      licenseKeys,
      catalog,
      symbolMeta,
      appColor,
      premiumScannerEmails,
    };

    const flush = () => {
      try {
        const slim = stabilizePayload(payload);
        const raw = JSON.stringify(slim);
        // Skip identical writes — 5s license polls used to thrash localStorage on Android.
        if (raw === lastPersistRawRef.current) return;
        lastPersistRawRef.current = raw;
        localStorage.setItem(STORAGE_KEY, raw);
        if (eaCount(slim) > 0) {
          try {
            localStorage.setItem(BACKUP_KEY, raw);
          } catch {
            // Backup is optional — primary save already succeeded.
          }
        }
      } catch {
        try {
          clearAppStoragePressure();
          saveState(payload);
        } catch {
          try {
            clearAppStoragePressure();
            const stripped = stripAllEmbeddedPhotos(payload);
            saveState(stripped);
            // Slim in-memory state so we stop rewriting oversized embeds.
            setEas((prev) =>
              prev.map((ea) => ({ ...ea, photo: slimPhotoForStorage(ea.photo, ea.id) }))
            );
            setBots((prev) =>
              prev.map((bot) => ({ ...bot, photo: slimPhotoForStorage(bot.photo, bot.id) }))
            );
            setLicenseKeys((prev) =>
              prev.map((row) =>
                row.bot
                  ? {
                      ...row,
                      bot: {
                        ...row.bot,
                        photo: slimPhotoForStorage(
                          row.bot.photo,
                          row.bot.id || row.botId
                        ),
                      },
                    }
                  : row
              )
            );
            // Recovered after clearing cache — photos reload from the API.
            // Avoid alarming unlock / activate with a storage toast.
          } catch {
            try {
              clearEaBackup();
              const minimal = stripAllEmbeddedPhotos(payload);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(minimal));
              setEas((prev) =>
                prev.map((ea) => ({ ...ea, photo: slimPhotoForStorage(ea.photo, ea.id) }))
              );
              setBots((prev) =>
                prev.map((bot) => ({ ...bot, photo: slimPhotoForStorage(bot.photo, bot.id) }))
              );
              setLicenseKeys((prev) =>
                prev.map((row) =>
                  row.bot
                    ? {
                        ...row,
                        bot: {
                          ...row.bot,
                          photo: slimPhotoForStorage(
                            row.bot.photo,
                            row.bot.id || row.botId
                          ),
                        },
                      }
                    : row
                )
              );
            } catch {
              showToast(
                "Could not save — storage is full. Clear site data for apex-ea.com and retry."
              );
            }
          }
        }
      }
    };

    // Light debounce on native so rapid poll setState does not thrash disk,
    // but keep it short so the UI feels as snappy as mobile web.
    const delay = isNativeApp() ? 120 : 0;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    if (!delay) {
      flush();
      return undefined;
    }
    persistTimerRef.current = window.setTimeout(flush, delay);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [
    activeInterface,
    coverEmail,
    signups,
    eas,
    bots,
    licenseKeys,
    catalog,
    symbolMeta,
    appColor,
    premiumScannerEmails,
    showToast,
  ]);

  const hasActiveBot = useMemo(
    () => bots.some((b) => b.active),
    [bots]
  );

  const v2ScannerPremium = useMemo(() => {
    const email = normalizeEmail(coverEmail);
    if (!email) return false;
    if (premiumScannerEmails.includes(email)) return true;
    const signup = signups.find((row) => normalizeEmail(row.email) === email);
    return Boolean(signup?.premiumScanner);
  }, [coverEmail, premiumScannerEmails, signups]);

  const unlockV2ScannerPremium = useCallback(
    (email = coverEmail) => {
      const key = normalizeEmail(email);
      if (!key || !key.includes("@")) {
        showToast("Missing email for premium unlock");
        return false;
      }
      setCoverEmail(key);
      setPremiumScannerEmails((prev) =>
        prev.includes(key) ? prev : [...prev, key]
      );
      setSignups((prev) =>
        mergeSignups(prev, [
          {
            email: key,
            status: "approved",
            createdAt: Date.now(),
            premiumScanner: true,
            premiumScannerAt: Date.now(),
          },
        ])
      );
      return true;
    },
    [coverEmail, showToast]
  );

  const activeBot = useMemo(() => {
    const active = bots.find((b) => b.active && b.selected) || bots.find((b) => b.active);
    return active || null;
  }, [bots]);

  // Prefetch robot photos into IndexedDB so Home avatars paint from disk next open.
  useEffect(() => {
    const active = bots.filter((b) => b?.active && b?.id);
    if (!active.length) return undefined;
    const timer = setTimeout(() => prefetchBotPhotos(active), 0);
    return () => clearTimeout(timer);
  }, [bots]);

  const appSymbols = useMemo(() => {
    const set = new Set();
    eas.forEach((ea) => ea.symbols.forEach((s) => set.add(s)));
    return set;
  }, [eas]);

  const ensureCatalog = useCallback((symbol) => {
    const clean = normalizeSymbol(symbol);
    if (!clean) return;
    setCatalog((prev) =>
      prev.some((s) => s.toLowerCase() === clean.toLowerCase()) ? prev : [...prev, clean]
    );
  }, []);

  const getSymbolMeta = useCallback(
    (symbol) =>
      symbolMeta[symbol] || {
        lotSize: 0.01,
        action: "BOTH",
        platform: "MT5",
        trades: 1,
      },
    [symbolMeta]
  );

  const refreshSignups = useCallback(async () => {
    try {
      const remote = await fetchSignups();
      let merged = remote;
      setSignups((prev) => {
        merged = mergeSignups(prev, remote);
        return merged;
      });
      // Restore local premium-scanner unlocks from remote signup flags only
      // (never from plain approved/app-access payment).
      const paid = (merged || [])
        .filter((row) => row?.premiumScanner)
        .map((row) =>
          String(row.email || "")
            .trim()
            .toLowerCase()
        )
        .filter((email) => email.includes("@"));
      if (paid.length) {
        setPremiumScannerEmails((prev) => Array.from(new Set([...prev, ...paid])));
      }
      return merged;
    } catch (error) {
      // Keep local cache if remote sync is temporarily unavailable.
      return null;
    }
  }, []);

  useEffect(() => {
    const pollMs = isNativeApp() ? 20000 : 15000;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      refreshSignups();
    };
    // Android: paint Home first, then sync signups (was competing with hero photos).
    const bootDelay = isNativeApp() ? 900 : 0;
    const bootTimer = setTimeout(tick, bootDelay);
    const timer = setInterval(tick, pollMs);
    return () => {
      clearTimeout(bootTimer);
      clearInterval(timer);
    };
  }, [refreshSignups]);

  const refreshMentorDirectory = useCallback(async () => {
    try {
      const list = await fetchMentors();
      const map = {};
      const themes = {};
      for (const mentor of list || []) {
        const email = normalizeEmail(mentor?.email);
        const username = String(mentor?.username || "").trim();
        if (email && username) map[email] = username;
        const color = normalizeHexColor(mentor?.appColor || "", "");
        if (email && color) themes[email] = color;
      }
      setMentorDirectory(map);
      setMentorThemes(themes);
      return map;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    // Android APK: one delayed fetch so first paint is not blocked.
    const bootDelay = isNativeApp() ? 1200 : 0;
    const bootTimer = setTimeout(() => {
      refreshMentorDirectory();
    }, bootDelay);
    if (isNativeApp()) {
      return () => clearTimeout(bootTimer);
    }
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refreshMentorDirectory();
    }, 20000);
    return () => {
      clearTimeout(bootTimer);
      clearInterval(timer);
    };
  }, [refreshMentorDirectory]);

  // Fill empty / brand mentorName stamps from the portal directory.
  // Do not overwrite a different real stamp here — Profile save syncs licenses
  // server-side; overwriting locally made sticky personal names beat brands.
  useEffect(() => {
    if (!Object.keys(mentorDirectory).length) return undefined;
    const brand = String(SUPER_ADMIN_USERNAME || "APEX EA").trim().toLowerCase();
    setLicenseKeys((prev) => {
      let changed = false;
      const next = prev.map((row) => {
        const email = normalizeEmail(row.mentorEmail);
        const username = email ? String(mentorDirectory[email] || "").trim() : "";
        if (!username) return row;
        const current = String(row.mentorName || "").trim();
        if (current === username) return row;
        const currentIsBrand = !current || current.toLowerCase() === brand;
        if (current && !currentIsBrand) return row;
        changed = true;
        return { ...row, mentorName: username };
      });
      return changed ? next : prev;
    });
    return undefined;
  }, [mentorDirectory]);

  // Apply the mentor's portal App color to home / lock / scanner (robot accents).
  useEffect(() => {
    if (adminOpen) return undefined;
    if (!Object.keys(mentorThemes).length) return undefined;

    const keys = Array.isArray(licenseKeys) ? licenseKeys : [];
    const eaList = Array.isArray(eas) ? eas : [];
    const account = normalizeEmail(coverEmail);
    const botId = String(activeBot?.id || "").trim();
    const brandEmail = normalizeEmail(SUPER_ADMIN_EMAIL);
    const brandTheme = normalizeHexColor(mentorThemes[brandEmail] || "", "");

    const pickTheme = (email) => {
      const key = normalizeEmail(email);
      if (!key) return "";
      const own = normalizeHexColor(mentorThemes[key] || "", "");
      if (own) return own;
      // Licenses usually store the operating mentor email (gmail). When that
      // mentor has no custom color, inherit the Admin Portal brand color.
      if (key !== brandEmail && brandTheme) return brandTheme;
      return "";
    };

    let themeColor = "";

    if (account) {
      const bound = keys.filter((row) => {
        const client = normalizeEmail(row.clientEmail || row.email || row.boundEmail);
        const usedBy = normalizeEmail(row.usedByEmail || row.usedBy);
        return client === account || usedBy === account;
      });
      bound.sort(
        (a, b) =>
          Number(b.usedAt || b.updatedAt || 0) - Number(a.usedAt || a.updatedAt || 0)
      );
      for (const row of bound) {
        themeColor = pickTheme(row.mentorEmail || row.ownerEmail);
        if (themeColor) break;
      }
    }

    if (!themeColor && botId) {
      const forBot = keys.filter(
        (row) =>
          String(row.botId || "").trim() === botId ||
          String(row.bot?.id || "").trim() === botId
      );
      forBot.sort(
        (a, b) =>
          Number(b.usedAt || b.updatedAt || 0) - Number(a.usedAt || a.updatedAt || 0)
      );
      for (const row of forBot) {
        themeColor = pickTheme(row.mentorEmail || row.ownerEmail);
        if (themeColor) break;
      }
      if (!themeColor) {
        const ea = eaList.find((item) => item.id === botId);
        themeColor = pickTheme(ea?.ownerEmail);
      }
    }

    if (!themeColor) {
      const anyKey = keys.find((row) => pickTheme(row.mentorEmail || row.ownerEmail));
      if (anyKey) themeColor = pickTheme(anyKey.mentorEmail || anyKey.ownerEmail);
    }

    if (!themeColor) {
      const owned = eaList.find((item) => pickTheme(item.ownerEmail));
      if (owned) themeColor = pickTheme(owned.ownerEmail);
    }

    // Portal owner previewing as themselves (web) — use their saved theme.
    if (!themeColor && portalThemeOwnerRef.current) {
      themeColor = pickTheme(portalThemeOwnerRef.current);
    }

    // Last resort: Admin Portal brand color (superadmin App color).
    if (!themeColor && brandTheme) themeColor = brandTheme;

    if (!themeColor) return undefined;
    if (normalizeHexColor(appColor) === themeColor) return undefined;
    setAppColorState(themeColor);
    applyAppTheme(themeColor);
    return undefined;
  }, [
    adminOpen,
    mentorThemes,
    licenseKeys,
    eas,
    coverEmail,
    activeBot,
    appColor,
  ]);

  const refreshLicenses = useCallback(async () => {
    try {
      const remote = await fetchLicenses();
      const remoteKeySet = new Set(
        (Array.isArray(remote) ? remote : [])
          .map((row) => normalizeLicenseKey(row?.key))
          .filter(Boolean)
      );
      // Merge remote + local. Drop stale local-only unused keys that never made
      // it to the shared store — they inflated mentor "556 keys" / quota math.
      // Keep fresh local generates briefly, and keep used keys a bit longer.
      setLicenseKeys((prev) => {
        const keptLocal = (Array.isArray(prev) ? prev : []).filter(
          (row) => !isRememberedDeletedLicenseKey(row.key)
        );
        const merged = filterOutDeletedLicenses(mergeLicenses(keptLocal, remote));
        if (!remoteKeySet.size) return merged;
        // If the remote payload is suspiciously smaller than what we already
        // have, keep the merge as-is — a partial/cold durable read was flipping
        // mentor dashboard counts to "error" / zero quota mid-session.
        const prevCount = keptLocal.length;
        const remoteCount = remoteKeySet.size;
        if (prevCount >= 50 && remoteCount < Math.floor(prevCount * 0.6)) {
          return merged;
        }
        const now = Date.now();
        return merged.filter((row) => {
          const key = normalizeLicenseKey(row.key);
          if (remoteKeySet.has(key)) return true;
          const age = now - Number(row.createdAt || row.updatedAt || 0);
          if (row.used && age < 24 * 60 * 60 * 1000) return true;
          if (!row.used && age < 30 * 60 * 1000) return true;
          return false;
        });
      });

      // Mentor photo updates sync live onto local EAs/bots.
      // Always keep the freshest photo (versioned API path beats stale data URLs).
      const photoByBotId = new Map();
      remote.forEach((row) => {
        const id = String(row.botId || row.bot?.id || "").trim();
        const photo = String(row.bot?.photo || "").trim();
        if (!id || !photo || photo === "/logo.png") return;
        const prevPhoto = photoByBotId.get(id);
        photoByBotId.set(id, prevPhoto ? pickFresherPhoto(photo, prevPhoto) : photo);
      });
      if (photoByBotId.size) {
        setEas((prev) =>
          prev.map((ea) => {
            const remotePhoto = photoByBotId.get(ea.id);
            if (!remotePhoto) return ea;
            const localPhoto = String(ea.photo || "");
            if (!isRealProfilePhoto(localPhoto)) {
              return { ...ea, photo: remotePhoto };
            }
            // Tiny legacy data-URL embeds look blurry on Home — always prefer a
            // durable API path when remote has one (full bytes from GitHub).
            if (
              localPhoto.startsWith("data:image/") &&
              remotePhoto.startsWith("/api/licenses/photo")
            ) {
              return { ...ea, photo: remotePhoto };
            }
            const remoteFresh = photoFreshness(remotePhoto);
            const localFresh = photoFreshness(localPhoto);
            if (remoteFresh > localFresh) return { ...ea, photo: remotePhoto };
            if (remoteFresh < localFresh) return ea;
            // Tie on unversioned data URLs: keep local so a just-uploaded picture
            // is not overwritten by an older embedded remote snapshot.
            if (
              remotePhoto.startsWith("data:") &&
              localPhoto.startsWith("data:") &&
              remotePhoto !== localPhoto
            ) {
              return ea;
            }
            if (remotePhoto.includes("v=") && !localPhoto.includes("v=")) {
              return { ...ea, photo: remotePhoto };
            }
            return ea;
          })
        );
        setBots((prev) =>
          prev.map((bot) => {
            const remotePhoto = photoByBotId.get(bot.id);
            if (!remotePhoto) return bot;
            const localPhoto = String(bot.photo || "");
            if (!isRealProfilePhoto(localPhoto)) {
              return { ...bot, photo: remotePhoto };
            }
            // Prefer full-quality API bytes over tiny local data-URL embeds.
            if (
              localPhoto.startsWith("data:image/") &&
              remotePhoto.startsWith("/api/licenses/photo")
            ) {
              return { ...bot, photo: remotePhoto };
            }
            const remoteFresh = photoFreshness(remotePhoto);
            const localFresh = photoFreshness(localPhoto);
            if (remoteFresh > localFresh) return { ...bot, photo: remotePhoto };
            if (remoteFresh < localFresh) return bot;
            if (
              remotePhoto.startsWith("data:") &&
              localPhoto.startsWith("data:") &&
              remotePhoto !== localPhoto
            ) {
              return bot;
            }
            if (remotePhoto.includes("v=") && !localPhoto.includes("v=")) {
              return { ...bot, photo: remotePhoto };
            }
            return bot;
          })
        );
      }
      return remote;
    } catch {
      return null;
    }
  }, []);

  // Push any device-local keys into the shared store once so other phones can use them.
  const licenseMigrateRef = useRef(false);
  useEffect(() => {
    if (licenseMigrateRef.current) return;
    licenseMigrateRef.current = true;
    const run = async () => {
      const local = Array.isArray(licenseKeys) ? licenseKeys : [];
      const queue = local.filter(
        (entry) =>
          entry?.key &&
          !isRememberedDeletedLicenseKey(entry.key) &&
          entry.clientEmail &&
          String(entry.clientEmail).includes("@") &&
          entry.clientName
      );
      const concurrency = isNativeApp() ? 2 : 3;
      let idx = 0;
      async function worker() {
        while (idx < queue.length) {
          const entry = queue[idx];
          idx += 1;
          try {
            const photo = String(entry.bot?.photo || "");
            await createLicenseRemote({
              ...entry,
              bot: entry.bot
                ? {
                    ...entry.bot,
                    photo: photo || "/logo.png",
                  }
                : undefined,
            });
          } catch {
            // keep going — remote may already have the key / deleted
          }
        }
      }
      await Promise.all(
        Array.from(
          { length: Math.min(concurrency, Math.max(queue.length, 1)) },
          () => worker()
        )
      );
      await refreshLicenses();
    };
    // Let Home paint before migrate hits the network.
    const delay = isNativeApp() ? 1500 : 400;
    const timer = setTimeout(() => {
      run().catch(() => {});
    }, delay);
    return () => clearTimeout(timer);
  }, [licenseKeys, refreshLicenses]);

  useEffect(() => {
    // Keep licenses fresh without thrashing the 800KB+ shared store every few seconds.
    const pollMs = isNativeApp() ? 30000 : 20000;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      refreshLicenses();
    };
    const bootDelay = isNativeApp() ? 700 : 120;
    const bootTimer = setTimeout(tick, bootDelay);
    const timer = setInterval(tick, pollMs);
    const onVis = () => {
      if (!document.hidden) refreshLicenses();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(bootTimer);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshLicenses]);

  // If mentor uploaded a photo after the license was issued (still /logo.png on
  // the key), upgrade local bots/EAs when the photo API starts serving bytes.
  // Also try sibling botIds that share the same EA name (older keys).
  // Never snap a real API path back to /logo.png on a flaky probe — that left
  // Home stuck on the default robot even when Mentor Portal showed the picture.
  useEffect(() => {
    const botId = String(activeBot?.id || "").trim();
    const photo = String(activeBot?.photo || "").trim();
    if (!botId) return undefined;
    if (isRealProfilePhoto(photo)) return undefined;
    let cancelled = false;
    const botName = String(activeBot?.name || "")
      .trim()
      .toLowerCase();
    const aliasIds = [
      ...new Set(
        [
          ...(Array.isArray(activeBot?.photoAliases)
            ? activeBot.photoAliases
            : []),
          ...(Array.isArray(licenseKeys) ? licenseKeys : [])
            .filter((row) => {
              const rowName = String(row.botName || row.bot?.name || "")
                .trim()
                .toLowerCase();
              return Boolean(botName && rowName && rowName === botName);
            })
            .map((row) => String(row.botId || row.bot?.id || "").trim()),
        ]
          .map((id) => String(id || "").trim())
          .filter((id) => id)
      ),
    ];
    const probeIds = [botId, ...aliasIds.filter((id) => id !== botId)];

    void (async () => {
      for (const probeId of probeIds) {
        if (cancelled) return;
        const apiPath = `/api/licenses/photo?botId=${encodeURIComponent(probeId)}&v=${Date.now()}`;
        try {
          const response = await fetch(mediaUrl(apiPath), {
            method: "GET",
            cache: "no-store",
          });
          if (cancelled) return;
          const type = String(response.headers.get("content-type") || "");
          const okImage = response.ok && type.startsWith("image/");
          if (!okImage) continue;
          const nextPhoto = `/api/licenses/photo?botId=${encodeURIComponent(probeId)}&v=full`;
          setBots((prev) =>
            prev.map((bot) =>
              bot.id === botId && !isRealProfilePhoto(bot.photo)
                ? { ...bot, photo: nextPhoto, photoAliases: aliasIds }
                : bot
            )
          );
          setEas((prev) =>
            prev.map((ea) =>
              ea.id === botId && !isRealProfilePhoto(ea.photo)
                ? { ...ea, photo: nextPhoto, photoAliases: aliasIds }
                : ea
            )
          );
          return;
        } catch {
          // try next alias
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeBot?.id, activeBot?.photo, activeBot?.name, activeBot?.photoAliases, licenseKeys]);

  const requestSignup = useCallback(
    async (email) => {
      const key = normalizeEmail(email);
      setCoverEmail(key);
      setSignups((prev) => {
        const existing = prev.find((s) => s.email === key);
        if (existing) {
          if (existing.status === "declined") {
            return prev.map((s) =>
              s.email === key
                ? { ...s, status: "pending", createdAt: Date.now() }
                : s
            );
          }
          return prev;
        }
        return [...prev, { email: key, status: "pending", createdAt: Date.now() }];
      });

      // Await server upsert so paid/bypassed flags are present before paywall checks.
      try {
        const remote = await submitSignup(key);
        if (remote) {
          setSignups((prev) => mergeSignups(prev, [remote]));
        } else {
          await refreshSignups();
        }
      } catch (error) {
        showToast(error.message || "Could not sync signup to server");
      }
      return key;
    },
    [refreshSignups, showToast]
  );

  const ingestSignup = useCallback((row) => {
    if (!row?.email) return;
    setSignups((prev) => mergeSignups(prev, [row]));
  }, []);

  const setSignupStatus = useCallback(
    async (email, status, { silent = false } = {}) => {
      const key = normalizeEmail(email);
      setSignups((prev) => {
        const exists = prev.some((s) => s.email === key);
        if (exists) {
          return prev.map((s) => (s.email === key ? { ...s, status } : s));
        }
        return [...prev, { email: key, status, createdAt: Date.now() }];
      });

      try {
        const remote = await updateSignupStatus(key, status);
        if (remote) setSignups((prev) => mergeSignups(prev, [remote]));
      } catch (error) {
        if (!silent) showToast(error.message || "Could not update signup on server");
        return false;
      }

      if (!silent) {
        showToast(
          status === "approved"
            ? `${key} approved`
            : status === "declined"
              ? `${key} declined`
              : `${key} updated`
        );
      }
      if (status === "approved" && normalizeEmail(coverEmail) === key) {
        // Never yank someone out of an active PayPal checkout.
        if (lockStepRef.current !== "pay") {
          setLockStep("license");
          if (!silent) showToast("Approved — enter your license key");
        }
      }
      if (status === "declined" && normalizeEmail(coverEmail) === key) {
        if (lockStepRef.current !== "pay") {
          setLockStep("pending");
        }
      }
      return true;
    },
    [coverEmail, showToast]
  );

  const bypassAppAccess = useCallback(
    async (email) => {
      const key = normalizeEmail(email);
      if (!key || !key.includes("@")) {
        showToast("Enter a valid email");
        return false;
      }
      await setSignupStatus(key, "approved");
      try {
        const remote = await updateSignupAccessBypassed(key);
        if (remote) setSignups((prev) => mergeSignups(prev, [remote]));
      } catch {
        // Still mark bypassed locally so Top Mentors / commission stay accurate.
        setSignups((prev) =>
          mergeSignups(prev, [
            {
              email: key,
              status: "approved",
              accessPaid: false,
              accessBypassed: true,
              accessBypassedAt: Date.now(),
              createdAt: Date.now(),
            },
          ])
        );
      }
      rememberDeviceAccess(key, { paid: true, bypassed: true });
      showToast(`App access bypassed for ${key}`);
      return true;
    },
    [setSignupStatus, showToast]
  );

  const clearAppAccessBypass = useCallback(
    async (email) => {
      const key = normalizeEmail(email);
      if (!key || !key.includes("@")) {
        showToast("Enter a valid email");
        return false;
      }
      try {
        const remote = await clearSignupAccessBypassed(key);
        if (remote) {
          setSignups((prev) =>
            mergeSignups(prev, [{ ...remote, accessBypassed: false }])
          );
        } else {
          setSignups((prev) =>
            prev.map((row) =>
              normalizeEmail(row.email) === key
                ? { ...row, accessBypassed: false, accessBypassedAt: null }
                : row
            )
          );
        }
      } catch (error) {
        setSignups((prev) =>
          prev.map((row) =>
            normalizeEmail(row.email) === key
              ? { ...row, accessBypassed: false, accessBypassedAt: null }
              : row
          )
        );
        showToast(error.message || `Removed bypass for ${key} (local)`);
        clearDeviceBypass(key);
        return true;
      }
      clearDeviceBypass(key);
      showToast(`Removed bypass for ${key}`);
      return true;
    },
    [showToast]
  );

  const bypassPremiumScanner = useCallback(
    async (email) => {
      const key = normalizeEmail(email);
      if (!key || !key.includes("@")) {
        showToast("Enter a valid email");
        return false;
      }
      try {
        const remote = await updateSignupPremiumScanner(key);
        if (remote) setSignups((prev) => mergeSignups(prev, [remote]));
        unlockV2ScannerPremium(key);
        showToast(`Premium chart bypassed for ${key}`);
        return true;
      } catch (error) {
        // Expired GitHub token used to surface "Bad credentials" and block bypass.
        // Still unlock locally so admin bypass always works for this device/session.
        unlockV2ScannerPremium(key);
        setSignups((prev) =>
          mergeSignups(prev, [
            {
              email: key,
              status: "approved",
              createdAt: Date.now(),
              premiumScanner: true,
              premiumScannerAt: Date.now(),
            },
          ])
        );
        showToast(`Premium chart bypassed for ${key}`);
        return true;
      }
    },
    [showToast, unlockV2ScannerPremium]
  );


  const getSignup = useCallback(
    (email = coverEmail) => {
      const key = normalizeEmail(email);
      return signups.find((s) => s.email === key) || null;
    },
    [coverEmail, signups]
  );


  const mentorDisplayName = useMemo(() => {
    const formatFromEmail = (email) => {
      const mail = String(email || "").trim();
      if (!mail.includes("@")) return "";
      const local = mail.split("@")[0].replace(/[._-]+/g, " ").trim();
      if (!local) return "";
      return local
        .split(" ")
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    };

    const pickFromLicense = (row) => {
      if (!row) return "";
      const named = String(row.mentorName || "").trim();
      if (named) return named;
      return formatFromEmail(row.mentorEmail);
    };

    const account = normalizeEmail(coverEmail);
    const keys = Array.isArray(licenseKeys) ? licenseKeys : [];
    const eaList = Array.isArray(eas) ? eas : [];
    const botId = String(activeBot?.id || "").trim();

    // Prefer the mentor tied to the active bot first (multi-bot clients).
    if (botId) {
      const forBot = keys.filter(
        (row) =>
          String(row.botId || "").trim() === botId ||
          String(row.bot?.id || "").trim() === botId
      );
      forBot.sort(
        (a, b) =>
          Number(b.usedAt || b.updatedAt || 0) - Number(a.usedAt || a.updatedAt || 0)
      );
      const fromBotLicense = pickFromLicense(forBot.find((row) => row?.used) || forBot[0]);
      if (fromBotLicense) return fromBotLicense;
    }

    if (account) {
      const used = keys.filter(
        (row) => row?.used && normalizeEmail(row.clientEmail) === account
      );
      used.sort(
        (a, b) =>
          Number(b.usedAt || b.updatedAt || 0) - Number(a.usedAt || a.updatedAt || 0)
      );
      const fromUsed = pickFromLicense(used[0]);
      if (fromUsed) return fromUsed;

      const bound = keys.filter((row) => normalizeEmail(row.clientEmail) === account);
      bound.sort(
        (a, b) =>
          Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)
      );
      const fromBound = pickFromLicense(bound[0]);
      if (fromBound) return fromBound;
    }

    if (botId) {
      const ea =
        eaList.find((item) => item.id === botId) ||
        eaList.find((item) => String(item.ownerEmail || "").includes("@"));
      const fromOwner = formatFromEmail(ea?.ownerEmail);
      if (fromOwner) return fromOwner;
    }

    const anyOwner = eaList.find((item) => String(item.ownerEmail || "").includes("@"));
    return formatFromEmail(anyOwner?.ownerEmail);
  }, [activeBot, coverEmail, eas, licenseKeys]);

  /** Mentor portal username shown in the client top header. Never use client main text. */
  const mainTextDisplay = useMemo(() => {
    const account = normalizeEmail(coverEmail);
    const keys = Array.isArray(licenseKeys) ? licenseKeys : [];
    const eaList = Array.isArray(eas) ? eas : [];
    const botId = String(activeBot?.id || "").trim();
    const brandName = String(SUPER_ADMIN_USERNAME || "APEX EA").trim();

    const isBrandStamp = (name) => {
      const value = String(name || "").trim();
      if (!value) return true;
      return value.toLowerCase() === brandName.toLowerCase();
    };

    /** True when a candidate header name is really the client's own name. */
    const looksLikeClientName = (name, row) => {
      const value = String(name || "").trim().toLowerCase();
      if (!value) return false;
      const clientName = String(row?.clientName || row?.mainText || "")
        .trim()
        .toLowerCase();
      if (clientName && (value === clientName || clientName.startsWith(`${value} `))) {
        return true;
      }
      if (account) {
        const local = account.split("@")[0] || "";
        if (local && value === local) return true;
      }
      return false;
    };

    const resolveMentorUsername = (row) => {
      if (!row) return "";
      const mentorEmail = normalizeEmail(row.mentorEmail);
      const fromDir = mentorEmail ? String(mentorDirectory[mentorEmail] || "").trim() : "";
      const named = String(row.mentorName || "").trim();

      const dirOk =
        fromDir && !isBrandStamp(fromDir) && !looksLikeClientName(fromDir, row);
      const namedOk =
        named && !isBrandStamp(named) && !looksLikeClientName(named, row);

      // Prefer the license mentor stamp (set at key-gen / Profile sync). The live
      // mentor directory can lag behind multi-store merges with a personal name.
      if (namedOk) return named;
      if (dirOk) return fromDir;
      if (named && !isBrandStamp(named)) return named;
      if (fromDir && !isBrandStamp(fromDir)) return fromDir;
      return "";
    };

    const resolveEaOwnerUsername = (id) => {
      if (!id) return "";
      const ea = eaList.find((item) => item.id === id);
      const ownerEmail = normalizeEmail(ea?.ownerEmail);
      if (ownerEmail && mentorDirectory[ownerEmail]) {
        const name = String(mentorDirectory[ownerEmail] || "").trim();
        if (name && !isBrandStamp(name)) return name;
      }
      // Any non-brand mentor who already issued a key for this bot.
      const forBot = keys.filter(
        (row) =>
          String(row.botId || "").trim() === id ||
          String(row.bot?.id || "").trim() === id
      );
      for (const row of forBot) {
        const name = resolveMentorUsername(row);
        if (name && !isBrandStamp(name)) return name;
      }
      return "";
    };

    if (botId) {
      const forBot = keys.filter(
        (row) =>
          String(row.botId || "").trim() === botId ||
          String(row.bot?.id || "").trim() === botId
      );
      forBot.sort(
        (a, b) =>
          Number(b.usedAt || b.updatedAt || 0) - Number(a.usedAt || a.updatedAt || 0)
      );
      const fromBot = resolveMentorUsername(forBot.find((row) => row?.used) || forBot[0]);
      if (fromBot && !isBrandStamp(fromBot)) return fromBot;

      const fromOwner = resolveEaOwnerUsername(botId);
      if (fromOwner) return fromOwner;
      if (fromBot) return fromBot;
    }

    if (account) {
      const used = keys.filter(
        (row) => row?.used && normalizeEmail(row.clientEmail) === account
      );
      used.sort(
        (a, b) =>
          Number(b.usedAt || b.updatedAt || 0) - Number(a.usedAt || a.updatedAt || 0)
      );
      const fromUsed = resolveMentorUsername(used[0]);
      if (fromUsed && !isBrandStamp(fromUsed)) return fromUsed;

      const bound = keys.filter((row) => normalizeEmail(row.clientEmail) === account);
      bound.sort(
        (a, b) =>
          Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)
      );
      const fromBound = resolveMentorUsername(bound[0]);
      if (fromBound && !isBrandStamp(fromBound)) return fromBound;

      if (botId) {
        const fromOwner = resolveEaOwnerUsername(botId);
        if (fromOwner) return fromOwner;
      }
      if (fromUsed) return fromUsed;
      if (fromBound) return fromBound;
    }

    // Last resort: any EA owner that maps to a real mentor username.
    for (const ea of eaList) {
      const ownerEmail = normalizeEmail(ea?.ownerEmail);
      if (ownerEmail && mentorDirectory[ownerEmail]) {
        const name = String(mentorDirectory[ownerEmail] || "").trim();
        if (name && !isBrandStamp(name)) return name;
      }
    }
    for (const ea of eaList) {
      const ownerEmail = normalizeEmail(ea?.ownerEmail);
      if (ownerEmail && mentorDirectory[ownerEmail]) return mentorDirectory[ownerEmail];
    }

    return "";
  }, [activeBot, coverEmail, eas, licenseKeys, mentorDirectory]);

  const resolveLockStep = useCallback(() => {
    const current = lockStepRef.current;
    // Never interrupt an active PayPal checkout — remounting the buttons
    // mid-card-entry looks like the page "restarting itself".
    if (current === "pay") return;

    // Mentor invite links must win over the normal unlock flow.
    try {
      const params = new URLSearchParams(window.location.search || "");
      // Returning from PayPal hosted checkout — stay on pay until capture finishes.
      if (
        params.get("paypal_return") === "1" ||
        params.get("paypal_cancel") === "1" ||
        (params.get("token") && params.get("PayerID"))
      ) {
        setLockStep("pay");
        return;
      }
      const hash = String(window.location.hash || "");
      const fromHash = hash.includes("invite=") || hash.includes("code=");
      const invite = String(
        params.get("invite") || params.get("code") || ""
      )
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (invite || fromHash) {
        setLockStep("invite");
        return;
      }
    } catch {
      // ignore
    }

    // Keep invite / license key entry while the user is actively on them
    // (unless invite URL above forced invite).
    if (current === "invite" || current === "license") return;

    const signup = getSignup(coverEmail);
    if (!coverEmail) {
      setLockStep("cover");
      return;
    }
    // Device memory OR server paid/bypass → license entry (no PayPal again).
    if (hasDeviceAccess(coverEmail) || isSignupEntitled(signup, coverEmail)) {
      setLockStep("license");
      return;
    }
    if (!signup) {
      setLockStep("cover");
      return;
    }
    setLockStep("pending");
  }, [coverEmail, getSignup]);

  useEffect(() => {
    if (!hasActiveBot) resolveLockStep();
  }, [hasActiveBot, resolveLockStep]);

  const upsertEa = useCallback(
    async ({ id, name, strategy, photo, symbols, ownerEmail = "", ownerId = "" }) => {
      const cleanSymbols = [];
      for (const raw of symbols) {
        const symbol = normalizeSymbol(raw);
        if (!symbol) continue;
        if (cleanSymbols.some((s) => s.toLowerCase() === symbol.toLowerCase())) continue;
        cleanSymbols.push(symbol);
      }
      cleanSymbols.forEach(ensureCatalog);
      let photoValue = String(photo || "").trim();
      const hasProfilePhoto =
        photoValue.startsWith("data:image/") ||
        photoValue.startsWith("/api/licenses/photo") ||
        /^https?:\/\//i.test(photoValue);
      if (!hasProfilePhoto) {
        showToast("Upload a profile picture before creating the bot");
        return null;
      }
      const owner = {
        ownerEmail: String(ownerEmail || "")
          .trim()
          .toLowerCase(),
        ownerId: String(ownerId || "").trim(),
      };
      const botId =
        id ||
        `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`;

      // Upload gallery/camera data URLs. Prefer a short API path in app state so
      // localStorage never fills up with multi-MB embeds (that blocked saves).
      if (photoValue.startsWith("data:image/")) {
        const originalDataUrl = photoValue;
        try {
          const uploaded = await uploadBotPhotoRemote(botId, photoValue);
          const uploadedPhoto = String(uploaded || "").trim();
          if (uploadedPhoto.startsWith("/api/licenses/photo")) {
            try {
              const check = await fetch(mediaUrl(uploadedPhoto), { method: "GET", cache: "no-store" });
              photoValue = check.ok ? uploadedPhoto : slimPhotoForStorage(originalDataUrl);
            } catch {
              photoValue = slimPhotoForStorage(originalDataUrl);
            }
          } else if (
            uploadedPhoto.startsWith("data:image/") &&
            uploadedPhoto.length <= MAX_STORED_DATA_URL
          ) {
            photoValue = uploadedPhoto;
          } else if (
            uploadedPhoto.startsWith("/api/licenses/photo") ||
            /^https?:\/\//i.test(uploadedPhoto)
          ) {
            photoValue = uploadedPhoto;
          } else {
            photoValue = slimPhotoForStorage(originalDataUrl);
            if (photoValue === "/logo.png") {
              showToast("Picture uploaded — avatar will show once storage frees up");
            }
          }
        } catch {
          photoValue = slimPhotoForStorage(originalDataUrl);
          if (photoValue === "/logo.png") {
            showToast("Picture too large for this phone — try a smaller image");
          } else {
            showToast("Picture saved on this device");
          }
        }
      }

      // API paths are safe; huge data URLs are slimmed so license rows do not explode quota.
      const statePhoto =
        photoValue.startsWith("/api/licenses/photo") || /^https?:\/\//i.test(photoValue)
          ? photoValue
          : slimPhotoForStorage(photoValue);
      const licensePhoto = slimPhotoForStorage(statePhoto);

      if (id) {
        setEas((prev) =>
          prev.map((ea) =>
            ea.id === id
              ? {
                  ...ea,
                  name,
                  strategy,
                  photo: statePhoto,
                  symbols: cleanSymbols,
                  ownerEmail: owner.ownerEmail || ea.ownerEmail || "",
                  ownerId: owner.ownerId || ea.ownerId || "",
                }
              : ea
          )
        );
        setBots((prev) =>
          prev.map((bot) =>
            bot.id === id ? { ...bot, name, photo: statePhoto, active: true } : bot
          )
        );
        setLicenseKeys((prev) =>
          prev.map((row) => {
            const rowBotId = String(row.botId || row.bot?.id || "").trim();
            if (rowBotId !== id) return row;
            return {
              ...row,
              botName: name || row.botName,
              updatedAt: Date.now(),
              bot: {
                ...(row.bot || { id, name, strategy: "scalper", symbols: [] }),
                id,
                name: name || row.bot?.name || row.botName || "Bot",
                photo: licensePhoto,
              },
            };
          })
        );
        showToast(`${name} profile updated`);
        // Pull the rewritten license photos quickly so client apps sync.
        window.setTimeout(() => {
          void refreshLicenses();
        }, 400);
      } else {
        setEas((prev) => [
          {
            id: botId,
            name,
            strategy,
            photo: statePhoto,
            symbols: cleanSymbols,
            ...owner,
          },
          ...prev,
        ]);
        setBots((prev) => [
          ...prev.map((b) => ({ ...b, selected: false })),
          {
            id: botId,
            name,
            photo: statePhoto,
            active: true,
            selected: true,
          },
        ]);
        showToast(`${name} created`);
      }
      setEditingEaId(null);
      return true;
    },
    [ensureCatalog, refreshLicenses, showToast]
  );

  const selectBot = useCallback((botId) => {
    setBots((prev) =>
      prev.map((b) => ({ ...b, selected: b.id === botId }))
    );
  }, []);

  const removeActiveBot = useCallback(() => {
    const current =
      bots.find((b) => b.active && b.selected) || bots.find((b) => b.active);
    if (!current) {
      showToast("No active bot to remove");
      return;
    }
    const ok = window.confirm(
      `Remove ${current.name} from the app home?\n\nYour EA stays in Manage EA. Use a license key to activate it again.`
    );
    if (!ok) return;
    setBots((prev) => {
      const updated = prev.map((b) =>
        b.id === current.id ? { ...b, active: false, selected: false } : b
      );
      const next = updated.find((b) => b.active);
      if (next) {
        return updated.map((b) => ({ ...b, selected: b.id === next.id }));
      }
      return updated;
    });
    showToast(`${current.name} removed — restore with a license key`);
  }, [bots, showToast]);

  const deleteEa = useCallback(
    (eaId) => {
      const ea = eas.find((e) => e.id === eaId);
      setEas((prev) => {
        const next = prev.filter((e) => e.id !== eaId);
        if (next.length === 0) clearEaBackup();
        return next;
      });
      setBots((prev) => {
        const next = prev.filter((b) => b.id !== eaId);
        if (!next.some((b) => b.selected) && next.some((b) => b.active)) {
          const first = next.find((b) => b.active);
          return next.map((b) => ({ ...b, selected: b.id === first.id }));
        }
        return next;
      });
      showToast(`${ea?.name || "EA"} deleted`);
      if (editingEaId === eaId) setEditingEaId(null);
      return true;
    },
    [eas, editingEaId, showToast]
  );

  const generateLicense = useCallback(
    async (
      botId,
      {
        clientEmail = "",
        clientName = "",
        mainText = "",
        mentorEmail = "",
        mentorId = "",
        mentorName = "",
        duration = "lifetime",
      } = {}
    ) => {
      const bot = bots.find((b) => b.id === botId);
      if (!bot) {
        showToast("Select a bot");
        return null;
      }
      const email = normalizeEmail(clientEmail);
      const name = String(clientName || "").trim();
      const username = String(mainText || name || "").trim();
      if (!name) {
        showToast("Enter the client name");
        return null;
      }
      if (!email || !email.includes("@")) {
        showToast("Enter the client email");
        return null;
      }

      // Always mint a fresh key — same client email may receive multiple
      // licenses. Each new key emails once; the same key is never re-emailed.
      const ea = eas.find((item) => item.id === botId);
      const key = randomLicenseKey();
      const ownerEmail =
        String(mentorEmail || ea?.ownerEmail || "")
          .trim()
          .toLowerCase() || "";
      const ownerId = String(mentorId || ea?.ownerId || "").trim();
      const ownerName = String(mentorName || "").trim();
      const createdAt = Date.now();
      const timing = resolveLicenseExpiry(duration, createdAt);

      if (ownerEmail && ownerEmail !== String(SUPER_ADMIN_EMAIL).toLowerCase()) {
        let allowance = DEFAULT_MENTOR_LICENSE_KEYS;
        try {
          const mentors = await fetchMentors();
          const mentor = (Array.isArray(mentors) ? mentors : []).find(
            (m) => normalizeEmail(m.email) === ownerEmail
          );
          if (mentor && String(mentor.role || "").toLowerCase() === "superadmin") {
            allowance = null;
          } else if (mentor?.licenseKeysAllowed != null) {
            allowance = Number(mentor.licenseKeysAllowed);
          }
        } catch {
          allowance = DEFAULT_MENTOR_LICENSE_KEYS;
        }
        if (allowance != null && Number.isFinite(allowance)) {
          const used = (Array.isArray(licenseKeys) ? licenseKeys : []).filter(
            (row) => normalizeEmail(row.mentorEmail) === ownerEmail
          ).length;
          if (used >= allowance) {
            showToast(
              `License key limit reached (${used}/${allowance}). Ask super admin to add more keys.`
            );
            return null;
          }
        }
      }

      // Prefer the versioned API photo path so every activation gets the latest
      // picture. Fall back to an embedded data URL only when upload cannot sync.
      let photo = String(bot.photo || ea?.photo || "/logo.png").trim() || "/logo.png";
      const originalPhoto = photo;
      if (photo.startsWith("data:image/")) {
        try {
          const uploaded = await uploadBotPhotoRemote(bot.id, photo);
          const uploadedPhoto = String(uploaded || "").trim();
          if (uploadedPhoto.startsWith("/api/licenses/photo")) {
            try {
              const check = await fetch(mediaUrl(uploadedPhoto), { method: "GET", cache: "no-store" });
              photo = check.ok ? uploadedPhoto : originalPhoto;
            } catch {
              photo = originalPhoto;
            }
          } else if (uploadedPhoto.startsWith("data:image/")) {
            photo = uploadedPhoto;
          } else if (isRealProfilePhoto(uploadedPhoto)) {
            photo = uploadedPhoto;
          }
        } catch {
          // Keep the local data URL — createLicenseRemote will embed it.
          photo = originalPhoto;
        }
      } else if (photo.startsWith("/api/licenses/photo")) {
        // Verify the synced path still serves; otherwise fall back to logo later.
        try {
          const check = await fetch(mediaUrl(photo), { method: "GET", cache: "no-store" });
          if (!check.ok) photo = await materializePhotoForLicense(originalPhoto);
        } catch {
          photo = await materializePhotoForLicense(originalPhoto);
        }
      } else {
        photo = await materializePhotoForLicense(photo);
      }

      const entry = {
        key,
        botId: bot.id,
        botName: bot.name,
        clientEmail: email,
        clientName: name,
        mainText: username,
        mentorEmail: ownerEmail,
        mentorId: ownerId,
        mentorName: ownerName,
        used: false,
        duration: timing.duration,
        expiresAt: timing.expiresAt,
        createdAt,
        usedAt: null,
        deviceId: null,
        boundAt: null,
        updatedAt: Date.now(),
        bot: {
          id: bot.id,
          name: bot.name,
          photo,
          strategy: ea?.strategy || "scalper",
          symbols: Array.isArray(ea?.symbols) ? ea.symbols : [],
        },
      };

      // Keep signup list in sync — license email is approved for activation.
      try {
        await submitSignup(email);
        await updateSignupStatus(email, "approved");
        setSignups((prev) =>
          mergeSignups(prev, [{ email, status: "approved", createdAt: Date.now() }])
        );
      } catch {
        // license create still proceeds
      }

      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const remote = await createLicenseRemote({
            ...entry,
            bot: {
              ...entry.bot,
              photo: entry.bot.photo || "/logo.png",
            },
          });
          if (!remote?.key) {
            throw new Error("Server did not return a license key");
          }
          // Confirm the key is readable from the shared store (not just this response).
          const verified = await fetchLicense(remote.key);
          const saved = verified || remote;
          setLicenseKeys((prev) => mergeLicenses(prev, [saved]));
          const syncedPhoto = saved.bot?.photo;
          if (syncedPhoto && syncedPhoto !== "/logo.png") {
            setEas((prev) =>
              prev.map((item) =>
                item.id === bot.id ? { ...item, photo: syncedPhoto } : item
              )
            );
            setBots((prev) =>
              prev.map((item) =>
                item.id === bot.id ? { ...item, photo: syncedPhoto } : item
              )
            );
          }
          const mail = remote?._email || null;
          if (mail?.ok && !mail?.skipped) {
            showToast(`License ready for ${name} · emailed ${email}`);
          } else if (mail?.ok && mail?.reason === "already-sent") {
            showToast(`License ready for ${name} · already emailed ${email}`);
          } else if (mail?.skipped && /brevo|not configured/i.test(String(mail.error || ""))) {
            showToast(
              `License ready for ${name} · email not configured (add Brevo keys on Vercel)`
            );
          } else if (mail?.skipped && mail?.ok) {
            showToast(`License ready for ${name} · emailed ${email}`);
          } else if (mail?.skipped) {
            showToast(
              `License ready for ${name} · email not configured (add Brevo keys on Vercel)`
            );
          } else if (mail && !mail.ok) {
            showToast(
              `License ready for ${name} · email failed (${mail.error || "Brevo"})`
            );
          } else {
            showToast(`License ready for ${name} · ${email}`);
          }
          return saved.key;
        } catch (error) {
          lastError = error;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }

      showToast(
        lastError?.message === "Bad credentials"
          ? `Could not save license — server needs a fresh GitHub token. Try again.`
          : `Could not save license key (${lastError?.message || "offline"}). Tap Generate again.`
      );
      return null;
    },
    [bots, eas, licenseKeys, showToast]
  );

  const generateLicensesBulk = useCallback(
    async (
      botId,
      clients = [],
      {
        duration = "lifetime",
        mentorEmail = "",
        mentorId = "",
        mentorName = "",
      } = {}
    ) => {
      const bot = bots.find((b) => b.id === botId);
      if (!bot) {
        showToast("Select a bot");
        return null;
      }
      const list = Array.isArray(clients) ? clients : [];
      if (!list.length) {
        showToast("Upload a CSV with client name and email columns");
        return null;
      }
      const ea = eas.find((item) => item.id === botId);
      const ownerEmail =
        String(mentorEmail || ea?.ownerEmail || "")
          .trim()
          .toLowerCase() || "";
      const ownerId = String(mentorId || ea?.ownerId || "").trim();
      const ownerName = String(mentorName || "").trim();

      let photo = String(bot.photo || ea?.photo || "/logo.png").trim() || "/logo.png";
      if (photo.startsWith("data:image/")) {
        try {
          const uploaded = await uploadBotPhotoRemote(bot.id, photo);
          if (String(uploaded || "").trim()) photo = String(uploaded).trim();
        } catch {
          // keep local
        }
      }

      try {
        const result = await createLicensesBulkRemote({
          botId: bot.id,
          botName: bot.name,
          duration,
          mentorEmail: ownerEmail,
          mentorId: ownerId,
          mentorName: ownerName,
          bot: {
            id: bot.id,
            name: bot.name,
            photo,
            strategy: ea?.strategy || "scalper",
            symbols: Array.isArray(ea?.symbols) ? ea.symbols : [],
          },
          clients: list,
        });
        if (result.created?.length) {
          setLicenseKeys((prev) => mergeLicenses(prev, result.created));
          setSignups((prev) =>
            mergeSignups(
              prev,
              result.created.map((row) => ({
                email: row.clientEmail,
                status: "approved",
                accessPaid: true,
                createdAt: Date.now(),
              }))
            )
          );
        }
        showToast(
          `Imported ${result.createdCount} key${result.createdCount === 1 ? "" : "s"}` +
            (result.skippedCount ? ` · ${result.skippedCount} already existed` : "") +
            (result.errorCount ? ` · ${result.errorCount} row error(s)` : "") +
            (result.email?.sentCount
              ? ` · emailed ${result.email.sentCount}`
              : result.email?.skippedCount
                ? ` · email not configured`
                : result.email?.failedCount
                  ? ` · ${result.email.failedCount} email(s) failed`
                  : "")
        );
        return result;
      } catch (error) {
        showToast(error.message || "Bulk import failed");
        return null;
      }
    },
    [bots, eas, showToast]
  );

  const activateLicense = useCallback(
    async (rawKey, options = {}) => {
      const accountEmail = normalizeEmail(coverEmail);
      const signup = getSignup(accountEmail);

      const key = normalizeLicenseKey(rawKey);
      if (!key) {
        showToast("Enter a license key");
        return false;
      }

      const variants = licenseKeyVariants(rawKey);
      const wantCompact = normalizeLicenseKey(rawKey).replace(/-/g, "");
      const matchKey = (item) => {
        const key = normalizeLicenseKey(item?.key);
        if (!key) return false;
        return (
          variants.includes(key) ||
          key.replace(/-/g, "") === wantCompact
        );
      };
      let entry = licenseKeys.find(matchKey) || null;

      if (!entry) {
        try {
          entry = await fetchLicense(rawKey);
          if (entry) setLicenseKeys((prev) => mergeLicenses(prev, [entry]));
        } catch {
          entry = null;
        }
      }
      if (!entry && accountEmail) {
        try {
          const byEmail = await fetchLicensesByEmail(accountEmail);
          setLicenseKeys((prev) => mergeLicenses(prev, byEmail));
          entry = byEmail.find(matchKey) || null;
        } catch {
          // continue
        }
      }
      if (!entry) {
        try {
          const remote = await fetchLicenses();
          setLicenseKeys((prev) => mergeLicenses(prev, remote));
          entry = remote.find(matchKey) || null;
        } catch {
          // keep local miss
        }
      }

      if (!entry) {
        showToast("Invalid license key — ask your mentor to generate a new one");
        return false;
      }

      if (isLicenseExpired(entry)) {
        showToast("License key has expired — ask your mentor for a new one");
        return false;
      }

      const licenseEmail = normalizeEmail(entry.clientEmail);
      const mentorEmail = normalizeEmail(entry.mentorEmail || entry.ownerEmail);
      // Client who owns the key OR mentor who issued it can reclaim after reinstall.
      let emailOwnsLicense = Boolean(
        accountEmail &&
          ((licenseEmail && accountEmail === licenseEmail) ||
            (mentorEmail && accountEmail === mentorEmail))
      );
      const approved = signup?.status === "approved";
      // Owning the key is enough after signup-store resets; otherwise require approval.
      if (!approved && !emailOwnsLicense) {
        setLockStep("pending");
        showToast(
          signup?.status === "declined"
            ? "Access was declined by super admin"
            : "Account must be approved by super admin first"
        );
        return false;
      }

      const deviceId = getOrCreateDeviceId();
      let boundDevice = String(entry.deviceId || "").trim();
      // Always refresh from the server before the phone-lock check so a just
      // reactivated key is not blocked by a stale localStorage used/deviceId.
      try {
        const fresh = await fetchLicense(rawKey);
        if (fresh) {
          entry = fresh;
          setLicenseKeys((prev) => mergeLicenses(prev, [fresh]));
          boundDevice = String(entry.deviceId || "").trim();
          const freshClient = normalizeEmail(entry.clientEmail);
          const freshMentor = normalizeEmail(
            entry.mentorEmail || entry.ownerEmail
          );
          emailOwnsLicense = Boolean(
            accountEmail &&
              ((freshClient && accountEmail === freshClient) ||
                (freshMentor && accountEmail === freshMentor))
          );
        }
      } catch {
        // keep local
      }
      if (entry.used && boundDevice && boundDevice !== deviceId) {
        // Owner or issuing mentor can reclaim after reinstall (new device id).
        if (!emailOwnsLicense) {
          showToast("This license is locked to another phone");
          return false;
        }
      }

      // Bind to this phone (same phone re-opens; owner email reclaims after reinstall).
      const healLicense =
        options && typeof options === "object" && matchKey(options.license)
          ? options.license
          : entry;
      let remote = null;
      try {
        remote = await markLicenseUsedRemote(entry.key || key, {
          deviceId,
          email: accountEmail,
          license: healLicense,
          botId: entry.botId || entry.bot?.id || "",
          botName: entry.botName || entry.bot?.name || "",
        });
      } catch (error) {
        showToast(error.message || "Could not lock license to this phone");
        return false;
      }
      if (remote) {
        entry = remote;
        setLicenseKeys((prev) => mergeLicenses(prev, [remote]));
      }

      const snapshot = entry.bot || {
        id: entry.botId,
        name: entry.botName || "Bot",
        photo: "/logo.png",
        strategy: "scalper",
        symbols: [],
      };

      // Prefer a durable photo from this bot's other licenses / same EA name /
      // photo API over /logo.png (older keys reuse a different botId).
      const snapshotName = String(snapshot.name || entry.botName || "")
        .trim()
        .toLowerCase();
      const snapshotId = String(snapshot.id || entry.botId || "").trim();
      let activationPhoto = pickProfilePhoto(
        snapshot.photo,
        ...(Array.isArray(licenseKeys) ? licenseKeys : [])
          .filter((row) => {
            const rowId = String(row.botId || row.bot?.id || "").trim();
            const rowName = String(row.botName || row.bot?.name || "")
              .trim()
              .toLowerCase();
            if (snapshotId && rowId === snapshotId) return true;
            if (snapshotName && rowName && rowName === snapshotName) return true;
            return false;
          })
          .map((row) => row.bot?.photo)
      );
      const botIdForPhoto = snapshotId;
      const aliasIds = [
        ...new Set(
          (Array.isArray(licenseKeys) ? licenseKeys : [])
            .filter((row) => {
              const rowName = String(row.botName || row.bot?.name || "")
                .trim()
                .toLowerCase();
              return Boolean(
                snapshotName && rowName && rowName === snapshotName
              );
            })
            .map((row) => String(row.botId || row.bot?.id || "").trim())
            .filter((id) => id && id !== botIdForPhoto)
        ),
      ];
      if (botIdForPhoto && !isRealProfilePhoto(activationPhoto)) {
        const probeIds = [botIdForPhoto, ...aliasIds];
        for (const probeId of probeIds) {
          const apiPath = `/api/licenses/photo?botId=${encodeURIComponent(probeId)}&v=full`;
          try {
            const check = await fetch(mediaUrl(apiPath), {
              method: "GET",
              cache: "no-store",
            });
            const type = String(check.headers.get("content-type") || "");
            if (check.ok && type.startsWith("image/")) {
              activationPhoto = apiPath;
              break;
            }
          } catch {
            // try next alias
          }
        }
      }
      snapshot.photo = activationPhoto;
      if (aliasIds.length) snapshot.photoAliases = aliasIds;

      // New activations always start stopped — user taps START.
      setV2Running(false);
      setEngineMode("idle");
      setEngineStep(0);
      setOrbTradeLive(null);

      setEas((prev) => {
        if (prev.some((ea) => ea.id === snapshot.id)) {
          return prev.map((ea) =>
            ea.id === snapshot.id
              ? {
                  ...ea,
                  name: snapshot.name || ea.name,
                  // Don't let a logo placeholder from an old key wipe an existing picture.
                  photo: pickProfilePhoto(snapshot.photo, ea.photo),
                  photoAliases: snapshot.photoAliases || ea.photoAliases || [],
                  strategy: snapshot.strategy || ea.strategy,
                  ownerEmail: ea.ownerEmail || entry.mentorEmail || "",
                  ownerId: ea.ownerId || entry.mentorId || "",
                  symbols:
                    Array.isArray(snapshot.symbols) && snapshot.symbols.length
                      ? snapshot.symbols
                      : ea.symbols,
                }
              : ea
          );
        }
        return [
          {
            id: snapshot.id,
            name: snapshot.name || entry.botName || "Bot",
            photo: pickProfilePhoto(snapshot.photo),
            photoAliases: snapshot.photoAliases || [],
            strategy: snapshot.strategy || "scalper",
            ownerEmail: entry.mentorEmail || "",
            ownerId: entry.mentorId || "",
            symbols: Array.isArray(snapshot.symbols) ? snapshot.symbols : [],
          },
          ...prev,
        ];
      });

      setBots((prev) => {
        const exists = prev.some((b) => b.id === snapshot.id);
        const licenseMeta = {
          licenseKey: entry.key || key,
          licenseDuration: entry.duration || "lifetime",
          licenseExpiresAt: entry.expiresAt ?? null,
          licenseCreatedAt: Number(entry.createdAt) || Date.now(),
        };
        if (exists) {
          return prev.map((b) =>
            b.id === snapshot.id
              ? {
                  ...b,
                  name: snapshot.name || b.name,
                  photo: pickProfilePhoto(snapshot.photo, b.photo),
                  photoAliases: snapshot.photoAliases || b.photoAliases || [],
                  active: true,
                  selected: true,
                  ...licenseMeta,
                }
              : { ...b, selected: false }
          );
        }
        return [
          ...prev.map((b) => ({ ...b, selected: false })),
          {
            id: snapshot.id,
            name: snapshot.name || entry.botName || "Bot",
            photo: pickProfilePhoto(snapshot.photo),
            photoAliases: snapshot.photoAliases || [],
            active: true,
            selected: true,
            ...licenseMeta,
          },
        ];
      });

      const usedAt = Number(entry.usedAt) || Date.now();
      const priorUsed = licenseKeys.some(
        (item) =>
          normalizeEmail(item.clientEmail) === accountEmail &&
          item.used &&
          !variants.includes(normalizeLicenseKey(item.key))
      );
      const accessPaid = Boolean(signup?.accessPaid) && !signup?.accessBypassed;
      const alreadyUnlocked = Boolean(signup?.appAccessUnlockedAt);
      const commissionEligible = Boolean(
        accessPaid && !alreadyUnlocked && !priorUsed
      );
      const commissionReason = commissionEligible
        ? "first_paid_access"
        : signup?.accessBypassed
          ? "invite_migrate_bypass"
          : !accessPaid
            ? "not_paid"
            : "access_already_active";

      setLicenseKeys((prev) =>
        mergeLicenses(prev, [
          {
            ...entry,
            used: true,
            usedAt,
            deviceId: entry.deviceId || deviceId,
            boundAt: entry.boundAt || usedAt,
            updatedAt: usedAt,
            commissionEligible:
              entry.commissionEligible != null
                ? Boolean(entry.commissionEligible)
                : commissionEligible,
            commissionReason: entry.commissionReason || commissionReason,
            clientEmail: entry.clientEmail || accountEmail,
          },
        ])
      );

      setSignups((prev) =>
        mergeSignups(prev, [
          {
            ...(signup || { email: accountEmail, status: "approved" }),
            email: accountEmail,
            status: "approved",
            appAccessUnlockedAt: signup?.appAccessUnlockedAt || usedAt,
          },
        ])
      );

      rememberDeviceAccess(accountEmail, {
        paid: Boolean(signup?.accessPaid) || hasDeviceAccess(accountEmail),
        bypassed: false,
      });

      const wasReclaimed =
        entry.used &&
        boundDevice &&
        boundDevice !== deviceId &&
        emailOwnsLicense;

      showToast(
        wasReclaimed
          ? `${snapshot.name || entry.botName || "Bot"} restored for ${accountEmail}`
          : `${snapshot.name || entry.botName || "Bot"} activated for ${accountEmail}`
      );
      return true;
    },
    [coverEmail, getSignup, licenseKeys, showToast]
  );

  /** Re-bind every non-expired license owned by this email onto this phone. */
  const restoreLicensesByEmail = useCallback(
    async (rawEmail = coverEmail) => {
      const accountEmail = normalizeEmail(rawEmail || coverEmail);
      if (!accountEmail || !accountEmail.includes("@")) {
        showToast("Enter the email linked to your license");
        return false;
      }

      let remote = [];
      try {
        remote = await fetchLicensesByEmail(accountEmail);
        if (remote.length) setLicenseKeys((prev) => mergeLicenses(prev, remote));
      } catch {
        remote = [];
      }

      // Reclaim every non-expired key owned by this email — including ones
      // stamped with an old device id after Android WebView cleared storage.
      const mine = (remote.length ? remote : licenseKeys).filter(
        (row) =>
          normalizeEmail(row.clientEmail) === accountEmail &&
          !isLicenseExpired(row) &&
          String(row.key || "").trim()
      );

      const signup = getSignup(accountEmail);
      const entitled =
        isSignupEntitled(signup, accountEmail) || mine.length > 0;
      if (!entitled) {
        showToast("Pay or get approved before restoring access");
        return false;
      }

      if (mine.length && !isSignupEntitled(signup, accountEmail)) {
        try {
          const remoteSignup = await updateSignupAccessPaid(accountEmail);
          if (remoteSignup) setSignups((prev) => mergeSignups(prev, [remoteSignup]));
        } catch {
          setSignups((prev) =>
            mergeSignups(prev, [
              {
                email: accountEmail,
                status: "approved",
                accessPaid: true,
                accessPaidAt: Date.now(),
                createdAt: Date.now(),
              },
            ])
          );
        }
      }

      rememberDeviceAccess(accountEmail, {
        paid: true,
        bypassed: true,
      });

      if (!mine.length) {
        return false;
      }

      let restored = 0;
      for (const row of mine) {
        const ok = await activateLicense(row.key);
        if (ok) restored += 1;
      }
      if (restored === 0) {
        return false;
      }
      return true;
    },
    [activateLicense, coverEmail, getSignup, licenseKeys, showToast]
  );

  const deactivateLicense = useCallback(
    async (rawKey, { adminEmail = "" } = {}) => {
      const key = normalizeLicenseKey(rawKey);
      if (!key) {
        showToast("Missing license key");
        return null;
      }
      const actor = normalizeEmail(adminEmail);
      if (!actor || actor !== normalizeEmail(SUPER_ADMIN_EMAIL)) {
        showToast("Only super admin can activate used license keys");
        return null;
      }
      const variants = licenseKeyVariants(key);
      const local = licenseKeys.find((item) =>
        variants.includes(normalizeLicenseKey(item.key))
      );
      const cleared = {
        ...(local || { key }),
        key: local?.key || key,
        used: false,
        usedAt: null,
        deviceId: null,
        boundAt: null,
        updatedAt: Date.now(),
      };
      setLicenseKeys((prev) => mergeLicenses(prev, [cleared]));
      try {
        const remote = await deactivateLicenseRemote(key, { adminEmail: actor });
        if (remote) setLicenseKeys((prev) => mergeLicenses(prev, [remote]));
        showToast("License deactivated — available again");
        return remote || cleared;
      } catch (error) {
        showToast(error.message || "Could not deactivate license");
        return null;
      }
    },
    [licenseKeys, showToast]
  );

  const resetClientScans = useCallback(
    async (rawKey, { adminEmail = "" } = {}) => {
      const key = normalizeLicenseKey(rawKey);
      if (!key) {
        showToast("Missing license key");
        return null;
      }
      const actor = normalizeEmail(adminEmail);
      const allowedAdmins = new Set([
        normalizeEmail(SUPER_ADMIN_EMAIL),
        "trapgoatkaymow@gmail.com",
      ]);
      if (!actor || !allowedAdmins.has(actor)) {
        showToast("Only super admin can reset client daily charts");
        return null;
      }
      try {
        const remote = await resetClientScansRemote(key, { adminEmail: actor });
        if (remote) setLicenseKeys((prev) => mergeLicenses(prev, [remote]));
        showToast("Daily charts reset for today — client can analyze again");
        return remote;
      } catch (error) {
        showToast(error.message || "Could not reset daily charts");
        return null;
      }
    },
    [showToast]
  );

  const deleteLicense = useCallback(
    async (rawKey) => {
      const key = normalizeLicenseKey(rawKey);
      if (!key) {
        showToast("Missing license key");
        return false;
      }
      const variants = licenseKeyVariants(key);
      rememberDeletedLicenseKey(key);
      setLicenseKeys((prev) =>
        prev.filter((item) => !variants.includes(normalizeLicenseKey(item.key)))
      );
      try {
        await deleteLicenseRemote(key);
        showToast("License deleted");
        await refreshLicenses?.();
        // Keep deny list even if remote list briefly still has the key.
        setLicenseKeys((prev) => filterOutDeletedLicenses(prev));
        return true;
      } catch (error) {
        // Still keep it deleted locally — do not let refresh resurrect it.
        rememberDeletedLicenseKey(key);
        showToast(error.message || "Could not delete license on server — removed locally");
        setLicenseKeys((prev) => filterOutDeletedLicenses(prev));
        return true;
      }
    },
    [refreshLicenses, showToast]
  );

  const saveSymbolMeta = useCallback((symbol, meta) => {
    setSymbolMeta((prev) => ({ ...prev, [symbol]: meta }));
    ensureCatalog(symbol);
    // If not on any EA yet, attach to first EA
    setEas((prev) => {
      if (prev.some((ea) => ea.symbols.includes(symbol))) return prev;
      if (prev.length === 0) return prev;
      const [first, ...rest] = prev;
      return [{ ...first, symbols: [...first.symbols, symbol] }, ...rest];
    });
    showToast(`${symbol} saved`);
  }, [ensureCatalog, showToast]);

  const removeSymbolEverywhere = useCallback((symbol) => {
    setEas((prev) =>
      prev.map((ea) => ({
        ...ea,
        symbols: ea.symbols.filter((s) => s !== symbol),
      }))
    );
    setSymbolMeta((prev) => {
      const next = { ...prev };
      delete next[symbol];
      return next;
    });
    showToast(`${symbol} removed`);
  }, [showToast]);

  const toggleInterface = useCallback(() => {
    setActiveInterface((prev) => (prev === "zeta" ? "v2" : "zeta"));
    setZetaView("home");
    setV2View("home");
  }, []);

  const publishOrbTrade = useCallback((details = {}) => {
    setOrbTradeLive({
      botName: String(details.botName || "").trim(),
      comment: String(details.comment || "").trim(),
      symbol: normalizeBrokerSymbol(details.symbol || ""),
      lotSize: Number(details.lotSize) > 0 ? Number(details.lotSize) : 0.01,
      action: String(details.action || details.side || "BOTH").toUpperCase(),
      side: String(details.side || "").toUpperCase(),
      entry: Number(details.entry) > 0 ? Number(details.entry) : null,
      takeProfit: Number(details.takeProfit) > 0 ? Number(details.takeProfit) : null,
      stopLoss: Number(details.stopLoss) > 0 ? Number(details.stopLoss) : null,
      target: String(details.target || "").trim().toUpperCase(),
      at: Date.now(),
    });
  }, []);

  const clearOrbTrade = useCallback(() => {
    setOrbTradeLive(null);
  }, []);

  // Mentor Self Hosting → client script orb. Poll pending fills for this email.
  const mentorTradePollBusy = useRef(false);
  const seenMentorTradeIds = useRef(new Set());
  useEffect(() => {
    if (adminOpen || !hasActiveBot) return undefined;
    const email = normalizeEmail(coverEmail);
    if (!email || !email.includes("@")) return undefined;

    const pull = async () => {
      if (mentorTradePollBusy.current) return;
      if (typeof document !== "undefined" && document.hidden) return;
      mentorTradePollBusy.current = true;
      try {
        const events = await fetchPendingTradeEvents(email);
        if (!events.length) return;
        const fresh = events.filter((row) => {
          const id = String(row?.id || "").trim();
          if (!id || seenMentorTradeIds.current.has(id)) return false;
          return true;
        });
        if (!fresh.length) {
          // Already shown locally — still ack so the queue drains.
          await ackPendingTradeEvents(
            email,
            events.map((row) => row.id).filter(Boolean)
          );
          return;
        }

        setZetaView("home");
        setV2View("home");

        for (const event of fresh) {
          const id = String(event.id || "").trim();
          if (id) seenMentorTradeIds.current.add(id);
          const side = String(event.side || event.action || "BUY").toUpperCase();
          const symbol = String(event.symbol || "")
            .trim()
            .toUpperCase()
            .replace(/[-–—]+$/g, "");
          const lotSize =
            Number(event.volume || event.lotSize) > 0
              ? Number(event.volume || event.lotSize)
              : 0.01;
          const botName =
            String(activeBot?.name || event.botName || "Bot").trim() || "Bot";
          const comment =
            String(event.comment || "mentor~APEXEA").trim().slice(0, 31) ||
            "mentor~APEXEA";
          recordTrade({
            botName,
            symbol,
            lotSize,
            action: side,
            side,
            comment,
            stopLoss: event.stopLoss,
            takeProfit: event.takeProfit,
            at: Number(event.at) || Date.now(),
            id: id || undefined,
          });
          publishOrbTrade({
            botName,
            comment,
            symbol,
            lotSize,
            action: side,
            side,
            stopLoss: event.stopLoss,
            takeProfit: event.takeProfit,
          });
        }

        await ackPendingTradeEvents(
          email,
          fresh.map((row) => row.id).filter(Boolean)
        );
        const last = fresh[fresh.length - 1];
        const lastSide = String(last?.side || "BUY").toUpperCase();
        const lastSym = normalizeBrokerSymbol(last?.symbol || "");
        if (lastSym) {
          showToast(
            `Mentor opened ${lastSide} ${lastSym}${
              fresh.length > 1 ? ` (+${fresh.length - 1})` : ""
            }`
          );
        }
        window.setTimeout(() => clearOrbTrade(), 12000);
      } catch {
        // best-effort — next poll retries
      } finally {
        mentorTradePollBusy.current = false;
      }
    };

    const bootDelay = isNativeApp() ? 2000 : 0;
    const pollMs = isNativeApp() ? 12000 : 4000;
    const bootTimer = setTimeout(pull, bootDelay);
    const timer = setInterval(pull, pollMs);
    return () => {
      clearTimeout(bootTimer);
      clearInterval(timer);
    };
  }, [
    adminOpen,
    hasActiveBot,
    coverEmail,
    activeBot?.name,
    publishOrbTrade,
    clearOrbTrade,
    showToast,
  ]);

  const value = {
    activeInterface,
    toggleInterface,
    coverEmail,
    setCoverEmail,
    mentorDisplayName,
    mainTextDisplay,
    signups,
    requestSignup,
    ingestSignup,
    setSignupStatus,
    bypassAppAccess,
    clearAppAccessBypass,
    bypassPremiumScanner,
    refreshSignups,
    getSignup,
    eas,
    upsertEa,
    deleteEa,
    editingEaId,
    setEditingEaId,
    bots,
    activeBot,
    hasActiveBot,
    v2ScannerPremium,
    unlockV2ScannerPremium,
    selectBot,
    removeActiveBot,
    licenseKeys,
    generateLicense,
    generateLicensesBulk,
    activateLicense,
    restoreLicensesByEmail,
    deactivateLicense,
    resetClientScans,
    deleteLicense,
    refreshLicenses,
    catalog,
    ensureCatalog,
    appSymbols,
    getSymbolMeta,
    saveSymbolMeta,
    removeSymbolEverywhere,
    normalizeSymbol,
    normalizeEmail,
    appColor,
    setAppColor,
    toast,
    showToast,
    adminOpen,
    setAdminOpen,
    openAdmin,
    adminPage,
    setAdminPage,
    lockStep,
    setLockStep,
    resolveLockStep,
    pairsOpen,
    setPairsOpen,
    zetaView,
    setZetaView,
    v2View,
    setV2View,
    v2Running,
    setV2Running,
    v2SymTab,
    setV2SymTab,
    editingSymbol,
    setEditingSymbol,
    mt5Session,
    setMt5Session,
    engineMode,
    setEngineMode,
    engineStep,
    setEngineStep,
    engineLogs,
    setEngineLogs,
    pushEngineLog,
    orbTradeLive,
    publishOrbTrade,
    clearOrbTrade,
    STRATEGY_LABELS,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
