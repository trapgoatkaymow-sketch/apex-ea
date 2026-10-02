import { useEffect, useState } from "react";

const DISMISS_KEY = "apexea-apk-update-dismiss-v1";
const DOWNLOAD_URL = "https://www.apex-ea.com/android";

function isNative() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.());
  } catch {
    return false;
  }
}

/**
 * When a newer signed APK is published, prompt Install-over (never delete).
 * UI/shell updates come from the live site automatically once this shell is installed.
 */
export default function ApkUpdateBanner() {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    if (!isNative()) return undefined;
    let cancelled = false;

    async function check() {
      try {
        const dismissed = String(sessionStorage.getItem(DISMISS_KEY) || "");
        const { App } = await import("@capacitor/app");
        const native = await App.getInfo();
        const localCode = Number(native?.build || 0) || 0;
        const localName = String(native?.version || "").trim();

        const response = await fetch(
          `https://www.apex-ea.com/app-version.json?t=${Date.now()}`,
          { cache: "no-store", credentials: "omit", headers: { Accept: "application/json" } }
        );
        if (!response.ok) return;
        const remote = await response.json();
        const remoteCode = Number(remote?.apkVersionCode || 0) || 0;
        const remoteName = String(remote?.apkVersionName || "").trim();
        const apkUrl = String(remote?.apkUrl || DOWNLOAD_URL).trim() || DOWNLOAD_URL;

        if (!remoteCode || localCode <= 0 || remoteCode <= localCode) return;
        const token = `${remoteCode}:${remoteName || "apk"}`;
        if (dismissed === token) return;
        if (cancelled) return;
        setInfo({
          token,
          apkUrl,
          localName: localName || String(localCode),
          remoteName: remoteName || String(remoteCode),
        });
      } catch {
        // offline / plugin missing
      }
    }

    void check();
    const timer = window.setInterval(() => void check(), 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (!info) return null;

  return (
    <div className="apk-update-banner" role="status">
      <div className="apk-update-banner__text">
        <strong>App update ready</strong>
        <span>
          v{info.remoteName} — tap Install (do not delete the app)
        </span>
      </div>
      <div className="apk-update-banner__actions">
        <a className="apk-update-banner__install" href={info.apkUrl}>
          Install
        </a>
        <button
          type="button"
          className="apk-update-banner__dismiss"
          onClick={() => {
            try {
              sessionStorage.setItem(DISMISS_KEY, info.token);
            } catch {
              // ignore
            }
            setInfo(null);
          }}
        >
          Later
        </button>
      </div>
    </div>
  );
}
