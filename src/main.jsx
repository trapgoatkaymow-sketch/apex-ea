import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { runBootGuard } from "./bootGuard.js";
import { warmBotPhotoCache } from "./botPhotoCache.js";
import { AppProvider, isNativeApp } from "./store.jsx";
import "./styles.css";

async function boot() {
  // Drop stale service workers / Cache Storage, then reload once if this shell
  // is older than the live deploy (Safari used to keep old index.html forever).
  const reloading = await runBootGuard();
  if (reloading) return;

  // Warm IndexedDB photo cache ASAP so robot list avatars paint instantly.
  warmBotPhotoCache().catch(() => {});

  // Tag the document early so CSS can demote expensive WebView effects on Android.
  try {
    if (isNativeApp()) {
      document.documentElement.classList.add("is-native");
      document.documentElement.dataset.platform = "android";
    }
  } catch {
    // ignore
  }

  // Block horizontal page pans on phones. Vertical scrolling still works.
  (() => {
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
  })();

  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </StrictMode>
  );

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
}

boot().catch(() => {
  // Last resort: still mount the app if the guard fails.
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </StrictMode>
  );
});

