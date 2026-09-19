/**
 * Keep clients on the latest deploy and protect against stale Safari / WebView
 * shells that used to serve old JS after apex-ea.com updated.
 *
 * Also enforces UI_SHELL_GENERATION so an older bundled shell cannot keep
 * painting retired layouts once a newer generation is live.
 */
import {
  BUILD_ID_STORAGE_KEY,
  RELOAD_SESSION_KEY,
  SHELL_GEN_STORAGE_KEY,
  UI_SHELL_GENERATION,
  UI_SHELL_LABEL,
} from "./uiShellLock.js";

const BUILD_ID = String(import.meta.env.VITE_APP_BUILD_ID || "dev");
const CHECK_INTERVAL_MS = 90_000;

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
    localStorage.setItem(SHELL_GEN_STORAGE_KEY, String(UI_SHELL_GENERATION));
    document.documentElement.dataset.uiShell = UI_SHELL_LABEL;
    document.documentElement.dataset.shellGen = String(UI_SHELL_GENERATION);
  } catch {
    // ignore quota / DOM
  }
}

/**
 * If this tab previously ran a NEWER shell, then somehow loaded older HTML/JS
 * (bfcache, weird CDN, restored tab), force a network reload.
 */
function rejectDowngrade() {
  try {
    const seenGen = Number(localStorage.getItem(SHELL_GEN_STORAGE_KEY) || 0);
    if (seenGen > UI_SHELL_GENERATION) {
      const url = new URL(window.location.href);
      url.searchParams.set("_shell", String(seenGen));
      url.searchParams.set("_t", String(Date.now()));
      window.location.replace(url.toString());
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function forceReload(remoteId, remoteGen) {
  const alreadyReloaded = sessionStorage.getItem(RELOAD_SESSION_KEY);
  const token = `${remoteId || "build"}:${remoteGen || UI_SHELL_GENERATION}`;
  if (alreadyReloaded === token) return false;
  sessionStorage.setItem(RELOAD_SESSION_KEY, token);
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
  await unregisterServiceWorkers();
  await clearRuntimeCaches();

  if (rejectDowngrade()) return true;

  rememberLocalShell();

  try {
    const remote = await fetchRemoteVersion();
    if (!remote) return false;

    const remoteId = String(remote?.buildId || "").trim();
    const remoteGen = Number(remote?.shellGeneration || 0);

    const generationStale =
      Number.isFinite(remoteGen) && remoteGen > 0 && remoteGen > UI_SHELL_GENERATION;
    const buildStale =
      isProdHost() &&
      Boolean(remoteId) &&
      remoteId !== BUILD_ID &&
      remoteId !== "dev" &&
      !String(remoteId).startsWith("local-");

    if (!generationStale && !buildStale) return false;

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
