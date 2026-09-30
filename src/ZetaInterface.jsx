import { resolveBotPhotoSrc } from "./apiOrigin.js";
import BotAvatar from "./BotAvatar.jsx";
import BotLicenseInfoButton from "./BotLicenseInfo.jsx";
import {
  getCachedBotPhotoSync,
  resolveCachedBotPhoto,
} from "./botPhotoCache.js";
import { isNativeApp, useApp } from "./store.jsx";
import ChartScanner from "./ChartScanner.jsx";
import EconomicCalendarButton from "./EconomicCalendar.jsx";
import MetaTraderPanel from "./MetaTraderPanel.jsx";
import TopBar from "./TopBar.jsx";
import { buildBotTradeComment } from "./metaApi.js";
import {
  START_SILENT_OPEN_DELAY_MS,
  pickSelectedSymbol,
  runSilentStartOpen,
} from "./silentStartOpen.js";
import TradeScriptOrb, { buildShortOpenTradeScript } from "./TradeScriptOrb.jsx";
import { useEffect, useRef, useState } from "react";

const START_PARTICLE_COUNT = isNativeApp() ? 6 : 18;

export default function ZetaInterface() {
  const {
    activeBot,
    bots,
    eas,
    appSymbols,
    selectBot,
    removeActiveBot,
    setPairsOpen,
    zetaView,
    setZetaView,
    v2Running,
    setV2Running,
    showToast,
    setLockStep,
    getSignup,
    coverEmail,
    catalog,
    getSymbolMeta,
    saveSymbolMeta,
    removeSymbolEverywhere,
    editingSymbol,
    setEditingSymbol,
    orbTradeLive,
    clearOrbTrade,
    mt5Session,
    publishOrbTrade,
  } = useApp();
  const silentOpenTimerRef = useRef(null);
  const silentOpenRunRef = useRef(0);
  // Always read the latest pairs / session when the 20s timer fires.
  const silentOpenCtxRef = useRef({});
  silentOpenCtxRef.current = {
    activeBot,
    eas,
    appSymbols,
    mt5Session,
    getSymbolMeta,
    publishOrbTrade,
  };

  const [lotSize, setLotSize] = useState("0.01");
  const [action, setAction] = useState("BOTH");
  const [platform, setPlatform] = useState("MT5");
  const [trades, setTrades] = useState("1");

  useEffect(() => {
    if (zetaView !== "symbol-edit" || !editingSymbol) return;
    const meta = getSymbolMeta(editingSymbol) || {};
    setLotSize(String(meta.lotSize ?? "0.01"));
    setAction(meta.action || "BOTH");
    setPlatform(meta.platform || "MT5");
    setTrades(String(meta.trades ?? 1));
  }, [zetaView, editingSymbol, getSymbolMeta]);

  const [floatSrc, setFloatSrc] = useState(
    () =>
      getCachedBotPhotoSync(activeBot?.id) ||
      resolveBotPhotoSrc(activeBot, "/logo.png")
  );
  useEffect(() => {
    let cancelled = false;
    const fallback = "/logo.png";
    const cached = getCachedBotPhotoSync(activeBot?.id);
    const resolved = resolveBotPhotoSrc(activeBot, fallback);
    const photo = String(activeBot?.photo || "").trim();
    // Same as BotAvatar: paint durable API / HTTPS paths immediately so the
    // floating orb matches the hero EA picture on web + Android WebView.
    const start = cached || resolved || fallback;
    setFloatSrc(start);

    const needsHydrate =
      Boolean(activeBot?.id) &&
      (photo.startsWith("/api/licenses/photo") ||
        /^https?:\/\//i.test(photo) ||
        !photo ||
        photo === "/logo.png" ||
        start === fallback ||
        /logo\.png(\?|$)/i.test(start));

    if (needsHydrate) {
      resolveCachedBotPhoto(activeBot, fallback)
        .then((url) => {
          if (cancelled || !url || url === fallback || /logo\.png(\?|$)/i.test(url)) {
            return;
          }
          setFloatSrc(url);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [activeBot?.id, activeBot?.photo]);

  const running = v2Running;
  const tradeComment = buildBotTradeComment(activeBot?.name);
  const scriptSymbol =
    (activeBot?.symbols && activeBot.symbols[0]) || catalog?.[0] || "XAUUSD";
  const scriptMeta = getSymbolMeta?.(scriptSymbol) || {};
  const openTradeScript = buildShortOpenTradeScript({
    botName: activeBot?.name || "Bot",
    comment: tradeComment,
    symbol: orbTradeLive?.symbol || scriptSymbol,
    lotSize: orbTradeLive?.lotSize ?? scriptMeta?.lotSize ?? 0.01,
    action: orbTradeLive?.action || scriptMeta?.action || "BOTH",
  });

  useEffect(() => {
    return () => {
      if (silentOpenTimerRef.current) {
        clearTimeout(silentOpenTimerRef.current);
        silentOpenTimerRef.current = null;
      }
      silentOpenRunRef.current += 1;
    };
  }, []);

  function toggleRun() {
    const next = !running;
    setV2Running(next);
    if (!next) {
      if (silentOpenTimerRef.current) {
        clearTimeout(silentOpenTimerRef.current);
        silentOpenTimerRef.current = null;
      }
      silentOpenRunRef.current += 1;
      clearOrbTrade?.();
      showToast("Bot stopped");
      return;
    }

    // Fail fast so START feels broken less often (pair / MT5 checks).
    const ctx = silentOpenCtxRef.current || {};
    const accountId = String(ctx.mt5Session?.accountId || "").trim();
    if (!accountId) {
      setV2Running(false);
      showToast("Connect MetaTrader before START");
      return;
    }
    const symbol = pickSelectedSymbol(ctx.activeBot, ctx.eas, ctx.appSymbols);
    if (!symbol) {
      setV2Running(false);
      showToast("Add a pair first, then press START");
      return;
    }

    showToast(`${activeBot?.name || "Bot"} started · opens ${symbol} in 20s`);
    // Silent START open: wait ~20s, then open the selected symbol without
    // showing Chart Scanner UI. Cancelled if the user hits STOP.
    if (silentOpenTimerRef.current) {
      clearTimeout(silentOpenTimerRef.current);
      silentOpenTimerRef.current = null;
    }
    const runId = silentOpenRunRef.current + 1;
    silentOpenRunRef.current = runId;
    silentOpenTimerRef.current = setTimeout(() => {
      silentOpenTimerRef.current = null;
      if (silentOpenRunRef.current !== runId) return;
      void (async () => {
        const latest = silentOpenCtxRef.current || {};
        const result = await runSilentStartOpen({
          activeBot: latest.activeBot,
          eas: latest.eas,
          appSymbols: latest.appSymbols,
          mt5Session: latest.mt5Session,
          getSymbolMeta: latest.getSymbolMeta,
          publishOrbTrade: latest.publishOrbTrade,
          variant: "zeta",
        });
        if (silentOpenRunRef.current !== runId) return;
        if (result?.ok) {
          const ladder =
            result.riskReward ||
            (result.takeProfit1 != null
              ? "TP 1:2 · 1:3 · 1:4"
              : "M15/M30/H1");
          showToast(
            `Opened ${result.side || ""} ${result.symbol} · SL ${result.stopLoss} · ${ladder}`
              .replace(/\s+/g, " ")
              .trim()
          );
        } else if (result?.error) {
          showToast(result.error);
        }
      })();
    }, START_SILENT_OPEN_DELAY_MS);
  }

  function openLicense() {
    const signup = getSignup(coverEmail);
    // Already unlocked: still open license entry so a new key can add another bot.
    if (bots.some((b) => b.active) || signup?.status === "approved") {
      setLockStep("license");
      return;
    }
    if (signup) setLockStep("pending");
    else setLockStep("cover");
  }

  return (
    <div className="iface-layer is-active" data-iface="zeta">
      <main className="stage">
        <TopBar />
        {zetaView === "home" && (
          <section className="view is-active view-home">
            <div className="hero">
              <EconomicCalendarButton variant="zeta" />
              <div className="avatar-wrap">
                <BotAvatar
                  className="avatar"
                  bot={activeBot}
                  fallback="/logo.png"
                  fetchPriority="high"
                  decoding="async"
                />
              </div>
              <p className="kicker">You are trading with</p>
              <h1 className="brand">{activeBot?.name || "No active bot"}</h1>
              <p className="powered">
                POWERED BY <span className="apexea-hotspot">ApexEA</span>
              </p>
            </div>

            <div className="action-deck" role="group" aria-label="Trading controls">
              <div className="action-row">
                <button className="glass-btn" type="button" onClick={() => setPairsOpen(true)}>
                  <span>Pairs</span>
                </button>
                <button
                  className={`stop-btn${running ? " is-running" : ""}`}
                  type="button"
                  onClick={toggleRun}
                >
                  <span className="stop-energy" aria-hidden="true">
                    {Array.from({ length: START_PARTICLE_COUNT }, (_, i) => (
                      <span key={i} className={`stop-particle stop-particle-${i + 1}`} />
                    ))}
                  </span>
                  <span className="stop-core-glow" aria-hidden="true" />
                  <span className="stop-label">{running ? "STOP" : "START"}</span>
                </button>
                <button className="glass-btn" type="button" onClick={removeActiveBot}>
                  <span>Remove bot</span>
                </button>
              </div>
              <p className="powered-badge">
                Powered by <span className="apexea-hotspot">ApexEA</span>
              </p>
            </div>

            <section className="robots" aria-label="Robot list">
              <h2 className="robots-title">ROBOT LIST:</h2>
              {bots
                .filter((b) => b.active)
                .map((bot) => (
                  <div
                    key={bot.id}
                    className={`robot-row${bot.selected ? " is-active" : ""}`}
                  >
                    <button
                      className="robot-row-main"
                      type="button"
                      onClick={() => selectBot(bot.id)}
                    >
                      <BotAvatar
                        bot={bot}
                        width="36"
                        height="36"
                        fallback="/logo.png"
                      />
                      <span>{bot.name}</span>
                    </button>
                    <BotLicenseInfoButton bot={bot} className="zeta-robot-license" />
                  </div>
                ))}
              <button
                className="robot-row robot-add"
                type="button"
                onClick={openLicense}
              >
                <span className="plus">+</span>
                <span>Add New Trading Bot</span>
              </button>
            </section>
          </section>
        )}

        {zetaView === "symbol-edit" && editingSymbol && (
          <section className="view is-active view-symbol-edit">
            <header className="v2-screen-top">
              <button
                className="v2-back"
                type="button"
                onClick={() => {
                  setZetaView("home");
                  setEditingSymbol(null);
                }}
              >
                ←
              </button>
              <h2 className="v2-screen-title">{editingSymbol}</h2>
              <button
                className="v2-trash"
                type="button"
                onClick={() => {
                  removeSymbolEverywhere(editingSymbol);
                  setEditingSymbol(null);
                  setZetaView("home");
                }}
                aria-label={`Remove ${editingSymbol}`}
              >
                🗑
              </button>
            </header>
            <form
              className="v2-edit-form"
              onSubmit={(e) => {
                e.preventDefault();
                saveSymbolMeta(editingSymbol, {
                  lotSize: Number(String(lotSize).replace(",", ".")) || 0.01,
                  action,
                  platform,
                  trades: Math.max(1, Math.floor(Number(trades) || 1)),
                });
                setEditingSymbol(null);
                setZetaView("home");
              }}
            >
              <label className="v2-field">
                <span>Lot Size</span>
                <input
                  className="v2-input"
                  type="text"
                  inputMode="decimal"
                  enterKeyHint="done"
                  autoComplete="off"
                  placeholder="0.01"
                  value={lotSize}
                  onChange={(e) => setLotSize(e.target.value.replace(/[^\d.,]/g, ""))}
                  onBlur={() => {
                    const n = Number(String(lotSize).replace(",", "."));
                    setLotSize(
                      Number.isFinite(n) && n > 0
                        ? String(Number(n.toFixed(4)))
                        : "0.01"
                    );
                  }}
                />
              </label>
              <label className="v2-field">
                <span>Action</span>
                <select
                  className="v2-input"
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                >
                  <option value="BUY">BUY</option>
                  <option value="SELL">SELL</option>
                  <option value="BOTH">BOTH</option>
                </select>
              </label>
              <label className="v2-field">
                <span>Platform</span>
                <select
                  className="v2-input"
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                >
                  <option value="MT4">MT4</option>
                  <option value="MT5">MT5</option>
                </select>
              </label>
              <label className="v2-field">
                <span>Number of Trades</span>
                <input
                  className="v2-input"
                  type="number"
                  min="1"
                  value={trades}
                  onChange={(e) => setTrades(e.target.value)}
                />
              </label>
              <button className="v2-save-btn" type="submit">
                Save Symbol
              </button>
            </form>
          </section>
        )}

        <ChartScanner active={zetaView === "scanner"} />

        {zetaView === "metatrader" && (
          <section className="view is-active view-metatrader">
            <MetaTraderPanel variant="zeta" />
          </section>
        )}
      </main>

      <nav className="tabbar" aria-label="Primary">
        {[
          ["home", "Home"],
          ["scanner", "EA Chart"],
          ["metatrader", "MetaTrader"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={`tab${
              zetaView === id || (id === "home" && zetaView === "symbol-edit")
                ? " is-active"
                : ""
            }`}
            type="button"
            onClick={() => {
              setZetaView(id);
              if (id !== "symbol-edit") setEditingSymbol(null);
            }}
          >
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <TradeScriptOrb
        visible={(running || Boolean(orbTradeLive)) && zetaView === "home"}
        photoSrc={floatSrc}
        botId={activeBot?.id || ""}
        bot={activeBot}
        botName={activeBot?.name || "Bot"}
        script={openTradeScript}
        comment={tradeComment}
        openingTrades={Boolean(orbTradeLive)}
        tradeLive={orbTradeLive}
        storageKey="apexea-float-pos-zeta"
        showToast={showToast}
      />
    </div>
  );
}
