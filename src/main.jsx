import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { runBootGuard, startShellWatch } from "./bootGuard.js";
import { warmBotPhotoCache } from "./botPhotoCache.js";
import { AppProvider, isNativeApp } from "./store.jsx";
import "./styles.css";

// Signal to the inline HTML watchdog that the app module executed.
try {
  document.documentElement.dataset.apexeaBoot = "1";
} catch {
  // ignore
}

function mountApp() {
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </StrictMode>
  );
}

function installSwipeLock() {
  // Block horizontal page pans on phones. Vertical scrolling still works.
  let startX = 0;
  let startY = 0;
  let locking = false;

  window.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      locking = false;
    },
    { passive: true }
  );

  window.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length !== 1) return;
      const target = event.target;
      if (
        target &&
        (target.closest?.("input, textarea, select, [contenteditable='true']") ||
          target.isContentEditable)
      ) {
        return;
      }
      const dx = event.touches[0].clientX - startX;
      const dy = event.touches[0].clientY - startY;
      if (!locking) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        locking = Math.abs(dx) > Math.abs(dy);
      }
      if (locking) {
        event.preventDefault();
      }
    },
    { passive: false }
  );
}

async function boot() {
  // Paint the React shell immediately. Upgrade checks run after first paint so
  // /admin and the client app are not stuck on a black screen waiting on network.
  warmBotPhotoCache().catch(() => {});

  try {
    if (isNativeApp()) {
      document.documentElement.classList.add("is-native");
      document.documentElement.dataset.platform = "android";
    }
  } catch {
    // ignore
  }

  installSwipeLock();
  mountApp();

  // Hide native splash ASAP once the React shell paints (Android APK only).
  queueMicrotask(() => {
    try {
      if (!window.Capacitor?.isNativePlatform?.()) return;
      import("@capacitor/splash-screen")
        .then(({ SplashScreen }) => SplashScreen.hide())
        .catch(() => {});
    } catch {
      // ignore on web
    }
  });

  // After paint: drop stale SW caches and upgrade if this shell is behind prod.
  try {
    const reloading = await runBootGuard();
    if (reloading) return;
    startShellWatch();
  } catch {
    startShellWatch();
  }
}

boot().catch(() => {
  // Last resort: still mount the app if boot helpers fail.
  startShellWatch();
  mountApp();
});
