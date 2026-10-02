/**
 * Scanner busy / AI offline — notify the user and hand off to Home START.
 */

export const PENDING_HOME_START_KEY = "apexea-pending-home-start-v1";
export const REQUEST_HOME_START_EVENT = "apexea-request-home-start";

const NOTIFY_TITLE = "Scanner busy";
const NOTIFY_BODY =
  "Many people are using the scanner. Tap START on Home to trade now.";

/** Mark that Home should auto-press START after navigation. */
export function markPendingHomeStart() {
  try {
    sessionStorage.setItem(PENDING_HOME_START_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** True while Home START is waiting to be pressed. */
export function hasPendingHomeStart() {
  try {
    return sessionStorage.getItem(PENDING_HOME_START_KEY) === "1";
  } catch {
    return false;
  }
}

/** Returns true once if a pending Home START was requested. */
export function consumePendingHomeStart() {
  try {
    if (sessionStorage.getItem(PENDING_HOME_START_KEY) !== "1") return false;
    sessionStorage.removeItem(PENDING_HOME_START_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Ask the active Home screen to run START (after navigation). */
export function requestHomeStart() {
  markPendingHomeStart();
  try {
    window.dispatchEvent(new CustomEvent(REQUEST_HOME_START_EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * System / browser notification when the scanner busy prompt appears.
 * Falls back quietly when Notification API or permission is unavailable.
 */
export async function notifyScannerBusy() {
  if (typeof window === "undefined") return;
  try {
    if (typeof Notification === "undefined") return;

    let permission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        return;
      }
    }
    if (permission !== "granted") return;

    const n = new Notification(NOTIFY_TITLE, {
      body: NOTIFY_BODY,
      tag: "apexea-scanner-busy",
      renotify: true,
      silent: false,
    });
    // Auto-close so the tray does not pile up while the in-app modal is open.
    window.setTimeout(() => {
      try {
        n.close();
      } catch {
        /* ignore */
      }
    }, 12_000);
  } catch {
    /* WebView / denied — modal + toast still cover UX */
  }
}
