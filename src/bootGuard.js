/**
 * Keep clients on the locked live product UI and reject stale Safari / WebView
 * shells that used to paint older Interface 1 / Interface 2 layouts.
 *
 * Upgrade path is remote app-version.json (shellGeneration / minShellGeneration).
 * We never reload solely because localStorage remembers a newer generation when
 * the CDN is still serving older HTML — that caused infinite loops. Instead:
 *   1) Live remote gen above this bundle → reload once to the locked shell.
 *   2) Live minShell / uiLocked floor above this bundle → reload once.
 *   3) Cache nukes only happen on that forced reload path.
 */
import {
  BUILD_ID_STORAGE_KEY,
  LOCK_WATERMARK_KEY,
  RECOVERY_SESSION_KEY,
  RELOAD_SESSION_KEY,
  SHELL_GEN_STORAGE_KEY,
  UI_SHELL_FLOOR,
  UI_SHELL_GENERATION,
  UI_SHELL_LABEL,
  UI_SHELL_LOCKED,
} from "./uiShellLock.js";

const BUILD_ID = String(import.meta.env.VITE_APP_BUILD_ID || "dev");
const CHECK_INTERVAL_MS = UI_SHELL_LOCKED ? 45_000 : 90_000;

function versionUrl() {
  const stamp = Date.now();
  try {
    if (
      typeof window !== "undefined" &&
      window.Capacitor?.isNativePlatform?.()
    ) {
      return `https://www.apex-ea.com/app-version.json?t=${stamp}`;
    }
  } catch {
    // ignore
  }
  return `/app-version.json?t=${stamp}`;
}

async function unregisterServiceWorkers() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => reg.unregister().catch(() => false)));
  } catch {
    // ignore
  }
}

async function clearRuntimeCaches() {
  if (typeof caches === "undefined" || !caches?.keys) return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key).catch(() => false)));
  } catch {
    // ignore
  }
}

function rememberLocalShell() {
  try {
    localStorage.setItem(BUILD_ID_STORAGE_KEY, BUILD_ID);
    // Only raise the watermark — never fight a sticky CDN with reload loops.
    const prev = Number(localStorage.getItem(SHELL_GEN_STORAGE_KEY) || 0);
    localStorage.setItem(
      SHELL_GEN_STORAGE_KEY,
      String(Math.max(prev, UI_SHELL_GENERATION))
    );
    if (UI_SHELL_LOCKED) {
      const prevFloor = Number(localStorage.getItem(LOCK_WATERMARK_KEY) || 0);
      localStorage.setItem(
        LOCK_WATERMARK_KEY,
        String(Math.max(prevFloor, UI_SHELL_FLOOR, UI_SHELL_GENERATION))
      );
    }
    document.documentElement.dataset.uiShell = UI_SHELL_LABEL;
    document.documentElement.dataset.shellGen = String(UI_SHELL_GENERATION);
    if (UI_SHELL_LOCKED) {
      document.documentElement.dataset.uiLocked = "1";
    }
    // App mounted — clear one-shot boot retry flag.
    sessionStorage.removeItem("apexea-boot-retry-v1");
  } catch {
    // ignore quota / DOM
  }
}

async function forceReload(remoteId, remoteGen) {
  const alreadyReloaded = sessionStorage.getItem(RELOAD_SESSION_KEY);
  const token = `${remoteId || "build"}:${remoteGen || UI_SHELL_GENERATION}`;
  if (alreadyReloaded === token) return false;
  sessionStorage.setItem(RELOAD_SESSION_KEY, token);
  try {
    sessionStorage.setItem(RECOVERY_SESSION_KEY, "1");
  } catch {
    // ignore
  }
  await unregisterServiceWorkers();
  await clearRuntimeCaches();
  const url = new URL(window.location.href);
  url.searchParams.set("_build", String(remoteId || "next").slice(0, 12));
  url.searchParams.set("_shell", String(remoteGen || UI_SHELL_GENERATION));
  url.searchParams.set("_t", String(Date.now()));
  window.location.replace(url.toString());
  return true;
}

async function fetchRemoteVersion() {
  const response = await fetch(versionUrl(), {
    method: "GET",
    cache: "no-store",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  return response.json();
}

function isNativePlatform() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

function isProdHost() {
  try {
    const host = String(window.location.hostname || "");
    return (
      host === "apex-ea.com" ||
      host === "www.apex-ea.com" ||
      host.endsWith(".vercel.app")
    );
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<boolean>} true when a forced reload was triggered
 */
export async function runBootGuard() {
  rememberLocalShell();

  try {
    const remote = await fetchRemoteVersion();
    if (!remote) return false;

    const remoteId = String(remote?.buildId || "").trim();
    const remoteGen = Number(remote?.shellGeneration || 0);
    const remoteFloor = Number(
      remote?.minShellGeneration ||
        remote?.shellFloor ||
        (remote?.uiLocked ? remoteGen : 0) ||
        0
    );

    const generationStale =
      Number.isFinite(remoteGen) && remoteGen > 0 && remoteGen > UI_SHELL_GENERATION;

    // Locked product floor — any older shell that can reach live must upgrade,
    // even when shellGeneration alone is equal/ambiguous on a partial deploy.
    const belowLockedFloor =
      UI_SHELL_LOCKED &&
      Number.isFinite(remoteFloor) &&
      remoteFloor > 0 &&
      UI_SHELL_GENERATION < remoteFloor;

    // Ignore ephemeral local-* build ids from Vite/Vercel preview stamps so
    // every deploy does not bounce mentors through a reload loop.
    const buildStale =
      isProdHost() &&
      Boolean(remoteId) &&
      remoteId !== BUILD_ID &&
      remoteId !== "dev" &&
      !String(remoteId).startsWith("local-") &&
      !String(BUILD_ID).startsWith("local-");

    if (!generationStale && !belowLockedFloor && !buildStale) return false;

    if (isNativePlatform()) {
      try {
        const seenNative = sessionStorage.getItem("apexea-native-update-hint");
        if (seenNative !== remoteId) {
          sessionStorage.setItem("apexea-native-update-hint", remoteId);
          window.__APEXEA_UPDATE_AVAILABLE__ = remoteId;
        }
      } catch {
        // ignore
      }
      return false;
    }

    return forceReload(remoteId, remoteGen || UI_SHELL_GENERATION);
  } catch {
    return false;
  }
}

/** Re-check while the app stays open so a long-lived tab cannot keep old UI. */
export function startShellWatch() {
  if (typeof window === "undefined") return () => {};

  let timer = 0;
  const check = () => {
    runBootGuard().catch(() => {});
  };

  timer = window.setInterval(check, CHECK_INTERVAL_MS);

  const onVisible = () => {
    if (document.visibilityState === "visible") check();
  };
  const onPageShow = (event) => {
    // bfcache restore — re-validate against live app-version.json (no local watermark fight).
    if (event?.persisted) check();
  };

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onPageShow);
  };
}

export function getAppBuildId() {
  return BUILD_ID;
}

export function getUiShellGeneration() {
  return UI_SHELL_GENERATION;
}

export function isUiShellLocked() {
  return UI_SHELL_LOCKED;
}
