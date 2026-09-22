import { useEffect, useMemo, useRef, useState } from "react";
import BotAvatar from "./BotAvatar.jsx";
import ScanEye from "./ScanEye.jsx";
import SniperScan from "./SniperScan.jsx";
import TrapScannerResult from "./TrapScannerResult.jsx";
import {
  CHART_DETECTION_STATUS,
  EXECUTE_ENGINE_STEPS,
  TRADE_ENGINE_STEPS,
  analyzeChartImage,
  detectSymbolFromChart,
  sleep,
} from "./chartScanner.js";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";
import { BrokerMark } from "./ConnectedBrokerBadge.jsx";
import { buildBotTradeComment, buildScannerFillComment, placeTrade } from "./metaApi.js";
import { recordTrade } from "./dailyTradeHistory.js";
import { isNativeApp, useApp } from "./store.jsx";
import { fetchLicensesByEmail } from "./licensesApi.js";
import {
  applyRemoteScanGrant,
  consumeScan,
  loadScansLeft,
  pickLatestScanGrant,
  scanQuota,
} from "./scanQuota.js";
import {
  describeManagementPlan,
  loadTradeManagement,
  saveTradeManagement,
} from "./tradeManagement.js";

/** Android WebView: keep motion close to web, with a lighter particle count. */
const SCANNER_PARTICLE_COUNT = isNativeApp() ? 12 : 18;
const SCANNER_OUTER_PARTICLES = isNativeApp() ? 8 : 18;
const SCAN_STEP_MS = isNativeApp() ? 220 : 420;
const SCAN_STEP_GAP_MS = isNativeApp() ? 36 : 70;
const SCAN_SETTLE_MS = isNativeApp() ? 220 : 500;
const TRADE_SETTLE_MS = isNativeApp() ? 320 : 700;

/**
 * Trade index → TP target (cycles forever):
 *   T1 → TP1, T2 → TP2, T3 → TP3, T4 → TP1, T5 → TP2, ...
 * Never dump T4+ onto TP3 — that made 15-trade fills look like T3..T15 all TP3.
 */
function targetForTradeIndex(index) {
  const n = Math.max(0, Math.floor(Number(index) || 0));
  const slot = n % 3;
  if (slot === 0) {
    return { target: "TP1", takeProfitKey: "takeProfit1", tradeNo: n + 1 };
  }
  if (slot === 1) {
    return { target: "TP2", takeProfitKey: "takeProfit2", tradeNo: n + 1 };
  }
  return { target: "TP3", takeProfitKey: "takeProfit3", tradeNo: n + 1 };
}

/**
 * Build the exact open order for each thread.
 * Thread 1 always TP1, thread 2 always TP2, thread 3 always TP3, then repeat.
 * Skip a thread only when its mapped TP price is missing.
 */
function buildTpThreads({ tradeCount, lot, signal }) {
  const count = clampTrades(tradeCount);
  const volume = clampLot(lot);
  const threads = [];
  for (let i = 0; i < count; i += 1) {
    const { target, takeProfitKey, tradeNo } = targetForTradeIndex(i);
    const takeProfit = Number(signal?.[takeProfitKey]);
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) continue;
    threads.push({
      index: i,
      tradeNo,
      target,
      takeProfitKey,
      takeProfit,
      volume,
    });
  }
  return threads;
}

function clampTrades(value) {
  const n = Math.floor(Number(value) || 1);
  return Math.min(20, Math.max(1, n));
}

/** Normalize lot only when saving / trading — not while the user is typing. */
function normalizeLot(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (raw === "" || raw === "." || raw === "0.") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Keep up to 4 decimals so users can type values like 0.015 / 2.5 freely.
  return Number(Math.min(1000, n).toFixed(4));
}

function clampLot(value) {
  return normalizeLot(value) ?? 0.01;
}

function formatSetupPrice(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return String(n);
}

export default function ChartScanner({ variant = "default", active = true }) {
  const {
    activeBot,
    eas,
    catalog,
    getSymbolMeta,
    saveSymbolMeta,
    ensureCatalog,
    mt5Session,
    setZetaView,
    setV2View,
    showToast,
    setEngineMode,
    setEngineStep,
    setEngineLogs,
    pushEngineLog,
    engineMode,
    engineStep,
    engineLogs,
    toggleInterface,
    publishOrbTrade,
    clearOrbTrade,
    activeInterface,
    coverEmail,
    licenseKeys,
  } = useApp();

  /** Interface 2 Chart Scanner = premium — tag MT5 comments with "premium". */
  const isPremiumScanner = variant === "v2" || activeInterface === "v2";

  const uploadRef = useRef(null);
  const cameraRef = useRef(null);
  const symbols = useMemo(() => {
    const ea = eas.find((item) => item.id === activeBot?.id);
    const fromEa = Array.isArray(ea?.symbols) ? ea.symbols : [];
    if (fromEa.length) return fromEa;
    if (catalog?.length) return catalog.slice(0, 12);
    return ["EURUSD", "XAUUSD", "GBPUSD", "USDJPY"];
  }, [activeBot, eas, catalog]);

  const [preview, setPreview] = useState("");
  const [symbol, setSymbol] = useState("");
  const [symbolSource, setSymbolSource] = useState("");
  const [detectionStatus, setDetectionStatus] = useState("");
  const [detectionMessage, setDetectionMessage] = useState("");
  const [detectionHint, setDetectionHint] = useState("");
  const [detectingSymbol, setDetectingSymbol] = useState(false);
  const [trades, setTrades] = useState(1);
  const [lotSize, setLotSize] = useState(0.01);
  const [scansLeft, setScansLeft] = useState(() => loadScansLeft(variant));
  const [signal, setSignal] = useState(null);
  const [fills, setFills] = useState([]);
  const [busy, setBusy] = useState(false);
  const [execProgress, setExecProgress] = useState({ done: 0, total: 0 });
  const [engineProgress, setEngineProgress] = useState(0);
  const [tradeManagement, setTradeManagement] = useState(() => loadTradeManagement());

  useEffect(() => {
    if (active) setScansLeft(loadScansLeft(variant));
  }, [variant, active]);

  // Refresh quota when the app returns to the foreground (new calendar day),
  // and apply any super-admin daily scan reset grant for this client.
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;

    async function refreshQuotaAndGrants() {
      const email = String(coverEmail || "")
        .trim()
        .toLowerCase();
      let grant = pickLatestScanGrant(licenseKeys);
      if (email.includes("@")) {
        try {
          const remote = await fetchLicensesByEmail(email);
          if (cancelled) return;
          const remoteGrant = pickLatestScanGrant(remote);
          if (
            remoteGrant &&
            (!grant || Number(remoteGrant.resetAt) > Number(grant.resetAt || 0))
          ) {
            grant = remoteGrant;
          }
        } catch {
          // offline — still try local licenseKeys grant
        }
      }
      if (cancelled) return;
      if (grant) {
        const result = applyRemoteScanGrant(grant);
        if (result?.applied) {
          setScansLeft(loadScansLeft(variant));
          showToast(
            `Daily scans restored · I1 ${result.zeta} · I2 ${result.v2}`
          );
          return;
        }
      }
      setScansLeft(loadScansLeft(variant));
    }

    void refreshQuotaAndGrants();
    const onFocus = () => void refreshQuotaAndGrants();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshQuotaAndGrants();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => void refreshQuotaAndGrants(), 45_000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [active, coverEmail, licenseKeys, showToast, variant]);

  useEffect(() => {
    if (!symbol) return;
    const meta = getSymbolMeta(symbol);
    setTrades(clampTrades(meta.trades));
    setLotSize(clampLot(meta.lotSize));
  }, [symbol, getSymbolMeta]);

  const connected = Boolean(mt5Session?.accountId);
  const engineActive = engineMode === "scanning" || engineMode === "trading";
  const setupReady = Boolean(
    signal?.side &&
      signal?.entry != null &&
      signal?.takeProfit1 != null &&
      signal?.takeProfit2 != null &&
      signal?.takeProfit3 != null
  );
  const managementPlan = useMemo(
    () => describeManagementPlan(tradeManagement),
    [tradeManagement]
  );
  const activeStepLabel =
    engineMode === "trading"
      ? EXECUTE_ENGINE_STEPS[
          Math.min(engineStep, EXECUTE_ENGINE_STEPS.length - 1)
        ]?.label || "Executing trade"
      : TRADE_ENGINE_STEPS[
          Math.min(engineStep, TRADE_ENGINE_STEPS.length - 1)
        ]?.label || "Trading engine ready";

  function persistTradeSettings(nextTrades = trades, nextLot = lotSize, nextSymbol = symbol) {
    if (!nextSymbol) return;
    const meta = getSymbolMeta(nextSymbol);
    saveSymbolMeta(nextSymbol, {
      ...meta,
      trades: clampTrades(nextTrades),
      lotSize: clampLot(nextLot),
      platform: meta.platform || "MT5",
      action: meta.action || "BOTH",
    });
  }

  function requireConnectedMt5(action = "scan") {
    if (connected) return true;
    showToast(
      action === "capture"
        ? "Connect a trading account before scanning charts"
        : "Connect a trading account to use the scanner"
    );
    setZetaView("metatrader");
    setV2View("metatrader");
    return false;
  }

  function openUpload() {
    if (!requireConnectedMt5("capture")) return;
    uploadRef.current?.click();
  }

  function openCamera() {
    if (!requireConnectedMt5("capture")) return;
    cameraRef.current?.click();
  }

  function resetDetectionState() {
    setSymbol("");
    setSymbolSource("");
    setDetectionStatus("");
    setDetectionMessage("");
    setDetectionHint("");
  }

  async function applyDetectedSymbol(dataUrl) {
    setDetectingSymbol(true);
    resetDetectionState();
    setSignal(null);
    setFills([]);
    try {
      const detection = await detectSymbolFromChart(dataUrl, {
        catalog: [...symbols, ...(catalog || [])],
      });
      const status = String(detection?.status || CHART_DETECTION_STATUS.NO_CHART);
      setDetectionStatus(status);
      setDetectionMessage(detection?.message || "");
      setDetectionHint(detection?.uiMessage || "");

      if (
        status === CHART_DETECTION_STATUS.SYMBOL_DETECTED &&
        detection?.symbol
      ) {
        const next = normalizeBrokerSymbol(detection.symbol);
        ensureCatalog?.(next);
        setSymbol(next);
        setSymbolSource("scanner");
        showToast(`Symbol detected: ${next}`);
        return next;
      }

      // OpenAI saw a chart but was unsure — still prefill any OCR guess for edit.
      const suggested = normalizeBrokerSymbol(
        detection?.suggestedSymbol || detection?.symbol || ""
      );
      if (status === CHART_DETECTION_STATUS.SYMBOL_UNCLEAR && suggested) {
        ensureCatalog?.(suggested);
        setSymbol(suggested);
        setSymbolSource("scanner");
        setDetectionStatus(CHART_DETECTION_STATUS.SYMBOL_DETECTED);
        setDetectionMessage(`Possible symbol: ${suggested}`);
        showToast(`Possible symbol: ${suggested} — edit if needed`);
        return suggested;
      }

      setSymbol(suggested || "");
      setSymbolSource(suggested ? "scanner" : "");
      if (detection?.quotaFallback) {
        showToast(
          detection.message ||
            "Chart ready — type the symbol to keep scanning"
        );
      } else if (
        status === CHART_DETECTION_STATUS.NO_CHART &&
        detection?.error &&
        /credit|quota|billing|unavailable|OpenAI|503|429/i.test(
          String(detection.error)
        )
      ) {
        showToast(
          /credit|quota|billing/i.test(String(detection.error))
            ? "AI scanner offline — type the symbol, then Scan"
            : detection.message || detection.error || "Chart analysis unavailable"
        );
      } else if (status === CHART_DETECTION_STATUS.NO_CHART) {
        showToast("No trading chart detected");
      } else if (status === CHART_DETECTION_STATUS.SYMBOL_UNCLEAR) {
        showToast("Chart detected — symbol unclear. Type the symbol manually.");
      } else {
        showToast(detection?.error || "Chart analysis unavailable");
      }
      return suggested || null;
    } catch {
      resetDetectionState();
      setDetectionStatus(CHART_DETECTION_STATUS.NO_CHART);
      setDetectionMessage("No trading chart detected");
      setDetectionHint("Please upload a clear trading chart.");
      showToast("Chart analysis failed");
      return null;
    } finally {
      setDetectingSymbol(false);
    }
  }

  function onFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!connected) {
      showToast("Connect a trading account before scanning charts");
      setZetaView("metatrader");
      setV2View("metatrader");
      event.target.value = "";
      return;
    }
    if (!file.type.startsWith("image/")) {
      showToast("Upload a chart screenshot image");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      setPreview(dataUrl);
      setSignal(null);
      setFills([]);
      setEngineProgress(0);
      resetDetectionState();
      showToast("Analyzing image…");
      void applyDetectedSymbol(dataUrl);
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  }

  async function runScan() {
    if (!requireConnectedMt5("scan")) return;
    if (!preview) {
      showToast("Capture or upload a chart first");
      return;
    }
    // Re-read storage so a new day refreshes quota even if React state is still 0.
    const remaining = loadScansLeft(variant);
    if (remaining !== scansLeft) setScansLeft(remaining);
    if (remaining <= 0) {
      showToast(
        `No scans left today (${scanQuota(variant)} / day)`
      );
      return;
    }
    if (
      detectionStatus === CHART_DETECTION_STATUS.NO_CHART ||
      !symbol
    ) {
      showToast(
        preview && !symbol
          ? "Enter the chart symbol (e.g. US30) or re-upload a clearer screenshot"
          : "Please upload a clear trading chart."
      );
      return;
    }

    setBusy(true);
    setSignal(null);
    setFills([]);
    setEngineLogs([]);
    setEngineMode("scanning");
    setEngineStep(0);
    setEngineProgress(8);

    try {
      for (let i = 0; i < TRADE_ENGINE_STEPS.length; i += 1) {
        setEngineStep(i);
        setEngineProgress(10 + Math.round((i / TRADE_ENGINE_STEPS.length) * 80));
        pushEngineLog(TRADE_ENGINE_STEPS[i].label);
        await sleep(SCAN_STEP_MS + i * SCAN_STEP_GAP_MS);
      }

      pushEngineLog("Building complete trade setup");
      const result = await analyzeChartImage(preview, {
        catalog: [...symbols, ...(catalog || [])],
        hintSymbol: symbol,
        preferDetectedSymbol: true,
      });

      if (
        !result?.side ||
        result.entry == null ||
        result.takeProfit1 == null ||
        result.takeProfit2 == null ||
        result.takeProfit3 == null
      ) {
        throw new Error("Could not build a complete trade setup with TP1/TP2/TP3");
      }

      const tradeSymbol = normalizeBrokerSymbol(
        result.detectedSymbol || result.symbol || ""
      );
      if (!tradeSymbol) {
        const err = new Error("Chart detected — symbol unclear");
        err.code = "SYMBOL_UNCLEAR";
        throw err;
      }

      ensureCatalog?.(tradeSymbol);
      setSymbol(tradeSymbol);
      setSymbolSource("scanner");
      setDetectionStatus(CHART_DETECTION_STATUS.SETUP_READY);
      setDetectionMessage("");
      setDetectionHint("");
      persistTradeSettings(trades, lotSize, tradeSymbol);

      setSignal(result);
      const nextScans = consumeScan(variant);
      setScansLeft(nextScans);
      setEngineStep(TRADE_ENGINE_STEPS.length - 1);
      setEngineProgress(100);
      pushEngineLog(
        `Setup ready · ${result.side} ${tradeSymbol} · Entry ${result.entry} · TP1 ${result.takeProfit1} · TP2 ${result.takeProfit2} · TP3 ${result.takeProfit3}`
      );
      showToast(
        result.source === "local-fallback"
          ? `${result.side} ${tradeSymbol} setup ready (offline AI) · ${nextScans} scans left`
          : `${result.side} ${tradeSymbol} setup ready · ${nextScans} scans left`
      );
      await sleep(SCAN_SETTLE_MS);
      setEngineMode("idle");
    } catch (error) {
      setEngineMode("idle");
      setEngineProgress(0);
      setSignal(null);
      if (error.code === "NO_CHART") {
        resetDetectionState();
        setDetectionStatus(CHART_DETECTION_STATUS.NO_CHART);
        setDetectionMessage(error.message || "No trading chart detected");
        setDetectionHint(error.uiMessage || "Please upload a clear trading chart.");
        showToast("No trading chart detected");
      } else if (error.code === "SYMBOL_UNCLEAR") {
        setDetectionStatus(CHART_DETECTION_STATUS.SYMBOL_UNCLEAR);
        setDetectionMessage(error.message || "Chart detected — symbol unclear");
        setDetectionHint(error.uiMessage || "Type the chart symbol, then Scan.");
        showToast("Type the chart symbol, then tap Scan");
      } else if (error.code === "ANALYSIS_UNAVAILABLE") {
        showToast(error.message || "Live analysis unavailable — retry");
      } else {
        showToast(error.message || "Scan failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function executeTrade() {
    if (!signal?.side || !signal?.symbol) {
      showToast("Scan a chart first to build a setup");
      return;
    }
    if (
      signal.takeProfit1 == null ||
      signal.takeProfit2 == null ||
      signal.takeProfit3 == null
    ) {
      showToast("Setup is missing TP1/TP2/TP3");
      return;
    }
    if (!connected) {
      showToast("Connect a trading account to execute trades");
      setZetaView("metatrader");
      setV2View("metatrader");
      return;
    }

    const tradeCount = clampTrades(trades);
    const lot = clampLot(lotSize);
    const tradeSymbol = normalizeBrokerSymbol(
      signal.detectedSymbol || signal.symbol || symbol
    );
    if (!tradeSymbol) {
      showToast("Symbol missing from setup");
      return;
    }

    // Always trade the scanner chart direction — never flip BUY/SELL from
    // a locked pair preference (that was blowing accounts with wrong bias).
    const side =
      String(signal.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";

    const tradeComment = buildBotTradeComment(activeBot?.name);
    const orbComment = isPremiumScanner
      ? `${tradeComment}|premium`.slice(0, 31)
      : tradeComment;
    const threads = buildTpThreads({
      tradeCount,
      lot,
      signal,
    });
    if (!threads.length) {
      showToast("Setup is missing TP1/TP2/TP3 prices for the selected trades");
      return;
    }

    setBusy(true);
    setFills([]);
    setEngineLogs([]);
    setEngineMode("trading");
    setEngineStep(0);
    setEngineProgress(12);
    setExecProgress({ done: 0, total: threads.length });
    persistTradeSettings(tradeCount, lot, tradeSymbol);
    publishOrbTrade?.({
      botName: activeBot?.name || "Bot",
      comment: orbComment,
      symbol: tradeSymbol,
      lotSize: lot,
      action: side,
      side,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit1,
      target: "TP1",
    });
    // Stay on the scanner so Execute → Executing is visible until all fills complete.

    try {
      pushEngineLog(
        `Opening ${side} ${tradeSymbol} · SL ${signal.stopLoss} · TP1 ${signal.takeProfit1} · TP2 ${signal.takeProfit2} · TP3 ${signal.takeProfit3}`
      );
      pushEngineLog(`Partial plan · ${managementPlan.summary}`);
      pushEngineLog(
        `Thread map · ${threads.map((t) => `T${t.tradeNo}→${t.target}`).join(" · ")}`
      );
      if (isPremiumScanner) {
        pushEngineLog("Premium scanner · MT5 comments tagged premium");
      }

      const nextFills = [];
      let lastError = "";
      let completed = 0;
      const totalTrades = threads.length;

      // Open strictly in thread order: 1=TP1, 2=TP2, 3=TP3 (never reshuffle).
      for (const thread of threads) {
        const { target, takeProfit, tradeNo, volume } = thread;
        const tradeCommentTag = buildScannerFillComment({
          botName: activeBot?.name,
          variant: isPremiumScanner ? "v2" : "default",
          premium: isPremiumScanner,
        });
        setEngineStep(0);
        try {
          const fill = await placeTrade({
            accountId: mt5Session.accountId,
            symbol: tradeSymbol,
            volume,
            side,
            stopLoss: signal.stopLoss,
            takeProfit,
            region: mt5Session.region || "",
            comment: tradeCommentTag,
            // Always chart-scanner for API gate; Interface 2 carries |premium in comment.
            source: "chart-scanner",
          });
          const filledSymbol = normalizeBrokerSymbol(
            String(fill?.symbol || tradeSymbol).replace(/[-–—]+$/g, "")
          );
          if (filledSymbol && filledSymbol !== tradeSymbol) {
            setSymbol(filledSymbol);
            persistTradeSettings(tradeCount, lot, filledSymbol);
          }
          nextFills.push({
            ...fill,
            symbol: filledSymbol || fill?.symbol || tradeSymbol,
            target,
            tradeNo,
            takeProfit,
            comment: tradeCommentTag,
          });
          recordTrade({
            botName: activeBot?.name || "Bot",
            // Same symbol the scanner shows after fill (broker-resolved when available).
            symbol: filledSymbol || tradeSymbol,
            lotSize: volume,
            action: side,
            side,
            comment: tradeCommentTag,
            entry: signal.entry,
            stopLoss: signal.stopLoss,
            takeProfit,
            target,
          });
          pushEngineLog(
            `Trade ${tradeNo} · ${target}${isPremiumScanner ? " · premium" : ""} · ${filledSymbol || tradeSymbol} · TP ${takeProfit} · comment ${tradeCommentTag}`
          );
        } catch (error) {
          lastError = error.message || "Trade failed";
          nextFills.push({
            ok: false,
            symbol: tradeSymbol,
            side,
            volume,
            target,
            tradeNo,
            takeProfit,
            error: lastError,
          });
          pushEngineLog(`Trade ${tradeNo} · ${target} failed · ${lastError}`);
        }
        completed += 1;
        setExecProgress({ done: completed, total: totalTrades });
        setEngineStep(1);
        setEngineProgress(20 + Math.round((completed / Math.max(1, totalTrades)) * 75));
        await sleep(220);
      }

      if (managementPlan.moveSlToBreakevenAfterTp1) {
        pushEngineLog(managementPlan.breakevenNote);
      }
      if (managementPlan.protectProfitAfterTp2) {
        pushEngineLog(managementPlan.protectNote);
      }

      setFills(nextFills);
      setEngineProgress(100);
      const okCount = nextFills.filter((f) => f.ok !== false).length;
      if (okCount) {
        showToast(`Executed ${okCount}/${nextFills.length} trades`);
      } else {
        showToast(lastError || nextFills[0]?.error || "No trades filled");
      }
      await sleep(TRADE_SETTLE_MS);
      setEngineMode("idle");
      setExecProgress({ done: 0, total: 0 });
      // Keep the opening-trades script visible briefly, then return to welcome.
      window.setTimeout(() => clearOrbTrade?.(), 12000);
    } catch (error) {
      setEngineMode("idle");
      setEngineProgress(0);
      setExecProgress({ done: 0, total: 0 });
      clearOrbTrade?.();
      showToast(error.message || "Execution failed");
    } finally {
      setBusy(false);
    }
  }

  const canScan =
    connected &&
    Boolean(preview) &&
    Boolean(symbol) &&
    detectionStatus !== CHART_DETECTION_STATUS.NO_CHART &&
    scansLeft > 0;

  // Interface 1 = classic glowing orb + track engine.
  // Interface 2 = SCAN LOCK portal + desk Trading Engine (+ Trap result card).
  const useTrapResult = variant === "v2";
  const isExecuting = busy && engineMode === "trading";
  const executingLabel =
    isExecuting && execProgress.total > 0
      ? `Executing… ${execProgress.done}/${execProgress.total}`
      : isExecuting
        ? "Executing…"
        : null;

  return (
    <section
      className={`view is-active view-scanner cs-locked-hud${useTrapResult ? " cs-i2-portal" : ""}`}
      hidden={!active ? true : undefined}
      aria-hidden={!active ? true : undefined}
    >
      <header className="cs-head">
        <div className="cs-head-main">
          <p className="cs-kicker">{activeBot?.name || "ApexEA"}</p>
          <h2 className="cs-title">Chart Scanner</h2>
          <p className="cs-tagline">Scan · Analyze · Trade Smarter</p>
        </div>
        <div className="cs-head-meta">
          <button
            className="cs-settings-btn"
            type="button"
            aria-label="Switch interface"
            title="Switch interface"
            onClick={toggleInterface}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 7h10M4 12h16M4 17h12"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
              <circle cx="16" cy="7" r="2.2" fill="currentColor" />
              <circle cx="8" cy="12" r="2.2" fill="currentColor" />
              <circle cx="14" cy="17" r="2.2" fill="currentColor" />
            </svg>
          </button>
          <span className="cs-scans-left">
            <span className="cs-scans-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="12" r="2.2" fill="currentColor" />
              </svg>
            </span>
            {`${scansLeft} scans left`}
          </span>
          <span className={`cs-mt-pill${connected ? " is-on" : ""}`}>
            {connected ? (
              <BrokerMark
                broker={{
                  company: mt5Session?.company || mt5Session?.server || "Broker",
                  name: mt5Session?.server || "",
                }}
                className="cs-mt-broker"
                size={18}
              />
            ) : (
              <>
                <span className="cs-mt-dot" aria-hidden="true" />
                MT5 offline
              </>
            )}
          </span>
        </div>
      </header>

      <div className={`cs-stage${engineActive ? " is-running" : ""}${preview ? " has-chart" : ""}`}>
        <div className="cs-stage-main">
          <div className="cs-viewport" aria-label="Chart preview">
            {preview ? (
              <div className="cs-chart-frame">
                <img
                  className="cs-chart"
                  src={preview}
                  alt="Chart to scan"
                  decoding="async"
                />
              </div>
            ) : (
              <div className="cs-empty">
                {useTrapResult ? (
                  <div className="cs-v2-portal" aria-hidden="true">
                    <span className="cs-v2-portal-aura" />
                    <span className="cs-v2-portal-orbit cs-v2-portal-orbit--a" />
                    <span className="cs-v2-portal-orbit cs-v2-portal-orbit--b" />
                    <span className="cs-v2-portal-spark cs-v2-portal-spark--1" />
                    <span className="cs-v2-portal-spark cs-v2-portal-spark--2" />
                    <span className="cs-v2-portal-spark cs-v2-portal-spark--3" />
                    <span className="cs-v2-portal-core">
                      <BotAvatar
                        className="cs-v2-portal-photo"
                        bot={activeBot}
                        fallback="/zeta-fire-portal.jpg"
                        width="160"
                        height="160"
                      />
                      <span className="cs-v2-portal-sweep" />
                      <span className="cs-v2-portal-shine" />
                    </span>
                    <span className="cs-v2-portal-label">
                      <i />
                      SCAN LOCK
                    </span>
                  </div>
                ) : (
                  <>
                    <span className="cs-particle-field" aria-hidden="true">
                      <span className="stop-energy cs-particle-field-energy">
                        {Array.from({ length: SCANNER_PARTICLE_COUNT }, (_, i) => (
                          <span key={`in-${i}`} className={`stop-particle stop-particle-${i + 1}`} />
                        ))}
                      </span>
                      {SCANNER_OUTER_PARTICLES > 0 ? (
                        <span className="stop-energy cs-particle-field-energy is-outer">
                          {Array.from({ length: SCANNER_OUTER_PARTICLES }, (_, i) => (
                            <span key={`out-${i}`} className={`stop-particle stop-particle-${i + 1}`} />
                          ))}
                        </span>
                      ) : null}
                    </span>
                    <div className="cs-robot-frame">
                      <span className="cs-robot-glow" aria-hidden="true" />
                      <span className="cs-empty-orb cs-robot-orb" aria-hidden="true">
                        <BotAvatar
                          className="cs-robot-photo"
                          bot={activeBot}
                          fallback="/zeta-fire-portal.jpg"
                          width="160"
                          height="160"
                        />
                        <span className="stop-energy cs-robot-orb-energy">
                          {Array.from({ length: SCANNER_PARTICLE_COUNT }, (_, i) => (
                            <span key={i} className={`stop-particle stop-particle-${i + 1}`} />
                          ))}
                        </span>
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
            <div
              className={`cs-scan-grid${engineActive ? " is-on" : ""}`}
              aria-hidden="true"
            />
            {engineActive ? (
              <div className="cs-engine-chip">
                <span className="cs-engine-pulse" />
                <span>{engineMode === "scanning" ? "Scanning" : "Trading"}</span>
              </div>
            ) : null}
            {engineMode === "scanning" ? (
              <div
                className={`cs-scan-eye-stage${useTrapResult ? " is-sniper" : ""}`}
                aria-live="polite"
              >
                {useTrapResult ? (
                  <>
                    <SniperScan size="lg" label="Robot sniper scanning" />
                    <span className="cs-scan-eye-caption">Sniper lock · hunting signal</span>
                  </>
                ) : (
                  <>
                    <ScanEye size="lg" label="Looking for a signal" />
                    <span className="cs-scan-eye-caption">Looking for signal</span>
                  </>
                )}
              </div>
            ) : null}
          </div>

          <div className={`cs-capture-row${engineActive ? " is-scanning" : ""}`}>
            <button
              className="cs-capture-btn is-primary is-camera"
              type="button"
              onClick={openCamera}
              disabled={busy || !connected}
            >
              <span className="cs-capture-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 8.5A2.5 2.5 0 0 1 6.5 6h2l1.2-1.8A1.5 1.5 0 0 1 10.9 3.5h2.2a1.5 1.5 0 0 1 1.2.7L15.5 6h2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              <span className="cs-capture-text">
                <strong>Shoot</strong>
                <em>Live camera</em>
              </span>
              <span className="cs-capture-shutter" aria-hidden="true" />
            </button>
            <button
              className="cs-capture-btn is-ghost is-upload"
              type="button"
              onClick={openUpload}
              disabled={busy || !connected}
            >
              <span className="cs-capture-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 16V7.5M12 7.5 8.8 10.6M12 7.5l3.2 3.1"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5.5 14.5v2A2.5 2.5 0 0 0 8 19h8a2.5 2.5 0 0 0 2.5-2.5v-2"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span className="cs-capture-text">
                <strong>Import</strong>
                <em>From gallery</em>
              </span>
            </button>
          </div>
        </div>

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={onFile}
        />
        <input
          ref={uploadRef}
          type="file"
          accept="image/*"
          hidden
          onChange={onFile}
        />
      </div>


        <div
          className={`cs-engine${engineActive ? " is-open" : ""}${setupReady ? " is-locked" : ""}${
            useTrapResult ? " is-desk" : ""
          }`}
          aria-live="polite"
        >
          {useTrapResult ? (
            <>
              <div
                className={`cs-engine-ring${engineMode === "scanning" ? " is-hunting" : ""}${
                  setupReady && !engineActive ? " is-confidence" : ""
                }`}
                style={{
                  ["--cs-engine-ring"]: `${
                    engineActive
                      ? engineProgress
                      : setupReady
                        ? Math.max(
                            0,
                            Math.min(100, Math.round(Number(signal?.confidence) || 100))
                          )
                        : 0
                  }`,
                }}
                aria-hidden="true"
              >
                {engineMode === "scanning" ? (
                  <SniperScan size="sm" label="Robot sniper scanning" />
                ) : (
                  <>
                    <strong>
                      {engineActive
                        ? `${engineProgress}`
                        : setupReady
                          ? `${Math.max(
                              0,
                              Math.min(100, Math.round(Number(signal?.confidence) || 100))
                            )}`
                          : "0"}
                    </strong>
                    <em>%</em>
                  </>
                )}
              </div>
              <div className="cs-engine-copy">
                <p className="cs-engine-kicker">
                  <i aria-hidden="true" />
                  Trading Engine
                </p>
                <p className="cs-engine-status">
                  {engineActive
                    ? activeStepLabel
                    : setupReady
                      ? "Setup ready — waiting for Execute Trade"
                      : "Armed and ready"}
                </p>
                {engineActive && engineLogs.length ? (
                  <p className="cs-engine-log">{engineLogs[engineLogs.length - 1]}</p>
                ) : null}
              </div>
              <span className="cs-engine-wave" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
            </>
          ) : (
            <>
              <div className="cs-engine-top">
                <div className="cs-engine-label">
                  <span className="cs-engine-gear" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <rect
                        x="4.5"
                        y="4.5"
                        width="15"
                        height="15"
                        rx="2.2"
                        stroke="currentColor"
                        strokeWidth="1.6"
                      />
                      <path
                        d="M8 8h3.2v3.2H8V8Zm4.8 0H16v3.2h-3.2V8ZM8 12.8h3.2V16H8v-3.2Zm4.8 0H16V16h-3.2v-3.2Z"
                        fill="currentColor"
                      />
                    </svg>
                  </span>
                  <div>
                    <p className="cs-engine-kicker">Trading Engine</p>
                    <p className="cs-engine-status">
                      {engineActive
                        ? activeStepLabel
                        : setupReady
                          ? "Setup ready — waiting for Execute Trade"
                          : "Armed and ready"}
                    </p>
                  </div>
                </div>
                <span className="cs-engine-pct">
                  {engineActive ? `${engineProgress}%` : setupReady ? "100%" : "0%"}
                </span>
              </div>
              <div className="cs-engine-track">
                <span
                  className="cs-engine-fill"
                  style={{
                    width: `${engineActive ? engineProgress : setupReady ? 100 : 0}%`,
                  }}
                />
              </div>
              {engineActive && engineLogs.length ? (
                <p className="cs-engine-log">{engineLogs[engineLogs.length - 1]}</p>
              ) : null}
            </>
          )}
        </div>

        <div className="cs-controls">
          <label
            className={`cs-field${symbolSource === "scanner" ? " is-from-scanner" : ""}`}
          >
            <span>
              Symbol
              {detectingSymbol
                ? " · scanner reading…"
                : symbolSource === "scanner"
                  ? " · from scanner"
                  : symbol
                    ? " · edit if needed"
                    : " · auto from chart"}
            </span>
            <input
              className="cs-lot cs-symbol-auto"
              value={detectingSymbol ? "" : symbol}
              disabled={busy || detectingSymbol}
              placeholder={detectingSymbol ? "Analyzing image…" : "Symbol (e.g. US30)"}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => {
                const next = normalizeBrokerSymbol(
                  String(e.target.value || "").replace(/\s+/g, "")
                );
                setSymbol(next);
                setSymbolSource(next ? "manual" : "");
                if (next) {
                  setDetectionStatus(CHART_DETECTION_STATUS.SYMBOL_DETECTED);
                  setDetectionMessage(`Symbol: ${next}`);
                  setDetectionHint("");
                }
              }}
            />
          </label>

          <label className="cs-field">
            <span>Trades</span>
            <div className="cs-stepper">
              <button
                type="button"
                aria-label="Fewer trades"
                disabled={busy || trades <= 1}
                onClick={() => {
                  const next = clampTrades(trades - 1);
                  setTrades(next);
                  persistTradeSettings(next, lotSize);
                }}
              >
                −
              </button>
              <input
                type="number"
                min="1"
                max="20"
                value={trades}
                disabled={busy}
                onChange={(e) => setTrades(clampTrades(e.target.value))}
                onBlur={() => persistTradeSettings(trades, lotSize)}
              />
              <button
                type="button"
                aria-label="More trades"
                disabled={busy || trades >= 20}
                onClick={() => {
                  const next = clampTrades(trades + 1);
                  setTrades(next);
                  persistTradeSettings(next, lotSize);
                }}
              >
                +
              </button>
            </div>
          </label>

          <label className="cs-field">
            <span>Lot size</span>
            <input
              className="cs-lot"
              type="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="0.01"
              value={lotSize}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value.replace(/[^\d.,]/g, "");
                setLotSize(next);
              }}
              onBlur={() => {
                const next = clampLot(lotSize);
                setLotSize(String(next));
                persistTradeSettings(trades, next);
              }}
            />
          </label>
        </div>

        <div className="cs-tp-config" aria-label="Take-profit risk reward ratios">
          <p className="cs-tp-config-label">
            <span className="cs-tp-config-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.7" />
                <circle cx="12" cy="12" r="1.2" fill="currentColor" />
              </svg>
            </span>
            TP targets
          </p>
          <div className="cs-tp-config-row" role="group" aria-label="Fixed TP ratios">
            <div className="cs-tp-ratio">
              <span>TP1</span>
              <strong>1:1</strong>
            </div>
            <div className="cs-tp-ratio">
              <span>TP2</span>
              <strong>1:2</strong>
            </div>
            <div className="cs-tp-ratio">
              <span>TP3</span>
              <strong>1:3</strong>
            </div>
          </div>
          <label className="cs-tp-toggle">
            <input
              type="checkbox"
              checked
              readOnly
              aria-checked="true"
            />
            <span>Move SL to breakeven after TP1</span>
          </label>
          <label className="cs-tp-toggle">
            <input
              type="checkbox"
              checked
              readOnly
              aria-checked="true"
            />
            <span>Protect profit after TP2</span>
          </label>
        </div>
        

      {detectionMessage &&
      !detectingSymbol &&
      detectionStatus !== CHART_DETECTION_STATUS.SYMBOL_DETECTED &&
      detectionStatus !== CHART_DETECTION_STATUS.SETUP_READY ? (
        <p
          className={`cs-detection-status${
            detectionStatus === CHART_DETECTION_STATUS.SYMBOL_UNCLEAR
              ? " is-warn"
              : " is-error"
          }`}
          aria-live="polite"
        >
          <span>{detectionMessage}</span>
          {detectionHint && detectionHint !== detectionMessage ? (
            <span className="cs-detection-hint">{detectionHint}</span>
          ) : null}
        </p>
      ) : null}

      {!setupReady ? (
        <button
          className="cs-run-btn"
          type="button"
          onClick={runScan}
          disabled={busy || detectingSymbol || !canScan}
        >
          {busy && engineMode === "scanning"
            ? "Building trade setup…"
            : detectingSymbol
              ? "Analyzing chart…"
              : !connected
                ? "Connect MT5 to Scan"
                : detectionStatus === CHART_DETECTION_STATUS.NO_CHART
                  ? "Upload a trading chart"
                  : !symbol
                    ? detectionStatus === CHART_DETECTION_STATUS.SYMBOL_UNCLEAR
                      ? "Type symbol, then Scan"
                      : "Waiting for symbol…"
                    : "Scan Chart"}
        </button>
      ) : (
        <div className="cs-post-scan-actions">
          <button
            className="cs-run-btn cs-scan-again"
            type="button"
            onClick={runScan}
            disabled={
              busy ||
              detectingSymbol ||
              !connected ||
              !preview ||
              !symbol ||
              scansLeft <= 0
            }
          >
            {busy && engineMode === "scanning"
              ? "Scanning again…"
              : scansLeft <= 0
                ? "No scans left today"
                : "Scan Again"}
          </button>
          {!useTrapResult ? (
            <button
              className={`cs-run-btn${isExecuting ? " is-executing" : ""}`}
              type="button"
              onClick={executeTrade}
              disabled={busy || !connected}
            >
              {executingLabel
                ? executingLabel
                : !connected
                  ? "Connect MT5 to Execute"
                  : "Execute Trade"}
            </button>
          ) : null}
        </div>
      )}

      {setupReady && useTrapResult ? (
        <TrapScannerResult
          activeBot={activeBot}
          signal={signal}
          connected={connected}
          busy={busy}
          executeTrade={executeTrade}
          fills={fills}
          executingLabel={executingLabel}
        />
      ) : null}

      {setupReady && !useTrapResult ? (
        <div className={`cs-result cs-result--${String(signal.side).toLowerCase()}`}>
          <p className="cs-result-kicker">Trade Signal</p>
          <strong>
            {signal.side} {signal.symbol}
          </strong>
          <span className="cs-result-meta">
            Confidence {signal.confidence}% · {signal.timeframe || "M15"}
          </span>

          <div className="cs-setup-grid">
            <span>
              <em>Entry</em>
              {formatSetupPrice(signal.entry)}
            </span>
            <span>
              <em>Stop Loss</em>
              {formatSetupPrice(signal.stopLoss)}
            </span>
            <span className="cs-tp cs-tp--1">
              <em>TP1 · 1:1</em>
              {formatSetupPrice(signal.takeProfit1)}
            </span>
            <span className="cs-tp cs-tp--2">
              <em>TP2 · 1:2</em>
              {formatSetupPrice(signal.takeProfit2)}
            </span>
            <span className="cs-tp cs-tp--3">
              <em>TP3 · 1:3</em>
              {formatSetupPrice(signal.takeProfit3)}
            </span>
            <span>
              <em>Risk / Reward</em>
              1:1 · 1:2 · 1:3
            </span>
          </div>

          <span className="cs-setup-analysis">
            {signal.analysis || signal.reasons?.[0] || "Setup from chart structure"}
          </span>
          <span className="cs-setup-plan">TP targets · 1:1 · 1:2 · 1:3</span>

          {fills.length ? (
            <span>
              {fills.filter((f) => f.ok !== false).length}/{fills.length} trades filled
              {fills
                .filter((f) => f.ok !== false && f.target)
                .map((f) => ` · T${f.tradeNo || "?"} ${f.target}`)
                .join("") ||
                (fills.some((f) => f.ok === false)
                  ? ` · ${fills.find((f) => f.ok === false)?.error || "failed"}`
                  : "")}
            </span>
          ) : (
            <span className="cs-setup-wait">Waiting for Execute Trade</span>
          )}
        </div>
      ) : null}

      {!connected ? (
        <button
          className="cs-connect-link"
          type="button"
          onClick={() => {
            setZetaView("metatrader");
            setV2View("metatrader");
          }}
        >
          Connect a trading account to unlock the scanner →
        </button>
      ) : null}
    </section>
  );
}
