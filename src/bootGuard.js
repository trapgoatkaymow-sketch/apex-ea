/**
 * Keep clients on the latest deploy and protect against stale Safari / WebView
 * shells that used to serve old JS after apex-ea.com updated.
 */
const BUILD_ID = String(import.meta.env.VITE_APP_BUILD_ID || "dev");
const RELOAD_KEY = "apexea-build-reload-v1";
const STORED_BUILD_KEY = "apexea-build-id-v1";

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

/**
 * @returns {Promise<boolean>} true when a forced reload was triggered
 */
export async function runBootGuard() {
  await unregisterServiceWorkers();
  await clearRuntimeCaches();

  try {
    localStorage.setItem(STORED_BUILD_KEY, BUILD_ID);
  } catch {
    // ignore quota
  }

  try {
    const response = await fetch(versionUrl(), {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const remote = await response.json();
    const remoteId = String(remote?.buildId || "").trim();
    if (!remoteId || remoteId === BUILD_ID || remoteId === "dev") return false;

    // Native APK embeds dist — cannot hot-swap JS; surface update once per build.
    try {
      if (window.Capacitor?.isNativePlatform?.()) {
        const seenNative = sessionStorage.getItem("apexea-native-update-hint");
        if (seenNative !== remoteId) {
          sessionStorage.setItem("apexea-native-update-hint", remoteId);
          window.__APEXEA_UPDATE_AVAILABLE__ = remoteId;
        }
        return false;
      }
    } catch {
      // ignore
    }

    const alreadyReloaded = sessionStorage.getItem(RELOAD_KEY);
    if (alreadyReloaded === remoteId) return false;
    sessionStorage.setItem(RELOAD_KEY, remoteId);
    // Hard navigation so Safari drops a stale index.html shell.
    const url = new URL(window.location.href);
    url.searchParams.set("_build", remoteId.slice(0, 12));
    window.location.replace(url.toString());
    return true;
  } catch {
    return false;
  }
}

export function getAppBuildId() {
  return BUILD_ID;
}
