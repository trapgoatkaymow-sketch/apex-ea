import { useEffect, useRef } from "react";
import AdminPortal from "./AdminPortal.jsx";
import CoverLock from "./CoverLock.jsx";
import PairsSheet from "./PairsSheet.jsx";
import V2Interface from "./V2Interface.jsx";
import ZetaInterface from "./ZetaInterface.jsx";
import { useApp } from "./store.jsx";

export default function App() {
  const {
    activeInterface,
    hasActiveBot,
    adminOpen,
    openAdmin,
    toast,
    showToast,
  } = useApp();

  const hotspotRef = useRef({ count: 0, first: 0 });

  useEffect(() => {
    const remoteId = String(window.__APEXEA_UPDATE_AVAILABLE__ || "").trim();
    if (!remoteId) return undefined;
    showToast("New app update on apex-ea.com — reinstall APK to stay current");
    try {
      delete window.__APEXEA_UPDATE_AVAILABLE__;
    } catch {
      // ignore
    }
    return undefined;
  }, [showToast]);

  function onBrandHotspot(event) {
    if (!event.target.closest(".apexea-hotspot")) return;
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - hotspotRef.current.first > 600) {
      hotspotRef.current = { count: 1, first: now };
    } else {
      hotspotRef.current.count += 1;
    }
    if (hotspotRef.current.count >= 3) {
      hotspotRef.current = { count: 0, first: 0 };
      openAdmin("dashboard");
      showToast("Admin portal");
    }
  }

  return (
    <div
      className={`phone${hasActiveBot ? "" : " is-locked"}${adminOpen ? " is-admin-open" : ""}`}
      data-interface={activeInterface}
      onClick={onBrandHotspot}
    >
      <div className="glow" aria-hidden="true" />
      <div className="glow glow-soft" aria-hidden="true" />

      {activeInterface === "zeta" ? <ZetaInterface /> : <V2Interface />}

      <CoverLock />
      <PairsSheet />
      <AdminPortal />

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
