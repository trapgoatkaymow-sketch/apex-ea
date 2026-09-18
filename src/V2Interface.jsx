import { useEffect, useState } from "react";
import { resolveBotPhotoSrc } from "./apiOrigin.js";
import BotAvatar from "./BotAvatar.jsx";
import {
  getCachedBotPhotoSync,
  resolveCachedBotPhoto,
} from "./botPhotoCache.js";
import ChartScanner from "./ChartScanner.jsx";
import EconomicCalendarButton from "./EconomicCalendar.jsx";
import { buildBotTradeComment } from "./metaApi.js";
import { isNativeApp, useApp } from "./store.jsx";
import MetaTraderPanel from "./MetaTraderPanel.jsx";
import TopBar from "./TopBar.jsx";
import TradeScriptOrb, { buildShortOpenTradeScript } from "./TradeScriptOrb.jsx";
import V2ScannerPaywall from "./V2ScannerPaywall.jsx";

const START_PARTICLE_COUNT = isNativeApp() ? 6 : 18;

export default function V2Interface() {
  const {
    activeBot,
    bots,
    selectBot,
    removeActiveBot,
    v2View,
    setV2View,
    v2Running,
    setV2Running,
    v2SymTab,
    setV2SymTab,
    catalog,
    appSymbols,
    getSymbolMeta,
    saveSymbolMeta,
    removeSymbolEverywhere,
    editingSymbol,
    setEditingSymbol,
    showToast,
    setLockStep,
    getSignup,
    coverEmail,
    v2ScannerPremium,
    orbTradeLive,
    clearOrbTrade,
  } = useApp();

  const [lotSize, setLotSize] = useState(0.01);
  const [action, setAction] = useState("BOTH");
  const [platform, setPlatform] = useState("MT5");
  const [trades, setTrades] = useState(1);
  const [floatCycle, setFloatCycle] = useState(false);
  const [floatSrc, setFloatSrc] = useState(
    () =>
      getCachedBotPhotoSync(activeBot?.id) ||
      resolveBotPhotoSrc(activeBot, "/logo.png")
  );

  useEffect(() => {
    let cancelled = false;
    const fallback = "/logo.png";
    const preferred =
      getCachedBotPhotoSync(activeBot?.id) ||
      resolveBotPhotoSrc(activeBot, fallback);
    setFloatSrc(preferred);
    if (activeBot?.id) {
      resolveCachedBotPhoto(activeBot, fallback)
        .then((url) => {
          if (!cancelled && url && url !== fallback) setFloatSrc(url);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [activeBot?.id, activeBot?.photo]);

  const allowed = catalog.filter((s) => appSymbols.has(s));
  const list = v2SymTab === "allowed" ? allowed : catalog;
  const activeRobots = bots.filter((b) => b.active);
  const tradeComment = buildBotTradeComment(activeBot?.name);
  const scriptSymbol =
    editingSymbol ||
    (activeBot?.symbols && activeBot.symbols[0]) ||
    catalog[0] ||
    "XAUUSD";
  const scriptMeta = getSymbolMeta(scriptSymbol);
  const openTradeScript = buildShortOpenTradeScript({
    botName: activeBot?.name || "Bot",
    comment: tradeComment,
    symbol: orbTradeLive?.symbol || scriptSymbol,
    lotSize: orbTradeLive?.lotSize ?? scriptMeta?.lotSize ?? lotSize,
    action: orbTradeLive?.action || scriptMeta?.action || action,
  });

  function openLicense() {
    const signup = getSignup(coverEmail);
    if (activeRobots.length > 0 || signup?.status === "approved") {
      setLockStep("license");
      return;
    }
    if (signup) setLockStep("pending");
    else setLockStep("cover");
  }

  function openEdit(symbol) {
    const meta = getSymbolMeta(symbol);
    setEditingSymbol(symbol);
    setLotSize(meta.lotSize);
    setAction(meta.action);
    setPlatform(meta.platform);
    setTrades(meta.trades);
    setV2View("symbol-edit");
  }

  return (
    <div className="iface-layer is-active" data-iface="v2">
      <main className="v2-stage">
        {v2View !== "scanner" ? <TopBar /> : null}
        {v2View === "home" && (
          <section className="v2-view is-active v2-view-home">
            <div className="v2-home-header">
              <div className="v2-home-hero">
                <EconomicCalendarButton variant="v2" />
                <div className="v2-home-hero-media" aria-hidden="true">
                  <BotAvatar
                    className="v2-home-hero-img"
                    bot={activeBot}
                    fallback="/zeta-scalper-hero.jpg"
                    fetchPriority="high"
                    decoding="async"
                  />
                </div>
                <div className="v2-home-hero-copy">
                  <p className="v2-home-hero-kicker">You are trading with</p>
                  <h1 className="v2-home-hero-name">{activeBot?.name || "No active bot"}</h1>
                </div>
              </div>

              <div className="v2-pill-bar">
              <button
                className="v2-pill-btn"
                type="button"
                onClick={() => {
                  setV2SymTab("allowed");
                  setV2View("quotes");
                }}
              >
                <span className="v2-pill-icon is-quotes" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2.2 13.7 7l4.8.4-3.7 3.1 1.2 4.7L12 12.8 8 15.2l1.2-4.7L5.5 7.4 10.3 7 12 2.2z" />
                    <path d="M18.2 11.2 19.1 13.6l2.5.2-1.9 1.6.6 2.4-2.1-1.2-2.1 1.2.6-2.4-1.9-1.6 2.5-.2 0.9-2.4z" />
                  </svg>
                </span>
                <span className="v2-pill-label">QUOTES</span>
              </button>
              <button
                className={`v2-pill-btn${v2Running ? " is-running" : ""}`}
                type="button"
                id="v2-trade-btn"
                onClick={() => {
                  const next = !v2Running;
                  setV2Running(next);
                  setFloatCycle(next);
                  if (!next) clearOrbTrade?.();
                  showToast(next ? `${activeBot?.name || "Bot"} started` : "Bot stopped");
                }}
              >
                <span className="stop-energy" aria-hidden="true">
                  {Array.from({ length: START_PARTICLE_COUNT }, (_, i) => (
                    <span key={i} className={`stop-particle stop-particle-${i + 1}`} />
                  ))}
                </span>
                <span className="stop-core-glow" aria-hidden="true" />
                <span className="v2-pill-icon is-trade" aria-hidden="true">
                  {v2Running ? (
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <rect x="5" y="4.5" width="5.5" height="15" rx="1.3" />
                      <rect x="13.5" y="4.5" width="5.5" height="15" rx="1.3" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M7.2 4.2v15.6L19.8 12 7.2 4.2z" />
                    </svg>
                  )}
                </span>
                <span className="v2-pill-label">{v2Running ? "STOP" : "TRADE"}</span>
              </button>
              <button className="v2-pill-btn" type="button" onClick={removeActiveBot}>
                <span className="v2-pill-icon is-remove" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9.2 3.5h5.6c.5 0 .9.4.9.9V6h3.1v2H5.2V6h3.1V4.4c0-.5.4-.9.9-.9zm1.2 2.5h3.2V5.5h-3.2V6z" />
                    <path d="M7.2 9h9.6l-.7 10.2a1.8 1.8 0 0 1-1.8 1.6H9.7a1.8 1.8 0 0 1-1.8-1.6L7.2 9z" />
                    <path d="M10.2 12.2h1.4v5.2h-1.4zm2.2 0h1.4v5.2h-1.4z" fill="#0a0a0c" />
                  </svg>
                </span>
                <span className="v2-pill-label">REMOVE</span>
              </button>
              </div>
            </div>

            <p className="v2-powered-by" aria-label="Powered by apexEA">
              Powered by <span>apexEA</span>
            </p>

            <section className="v2-robots">
              <h2 className="v2-robots-title">ROBOT LIST:</h2>
              <div className="v2-robot-list">
                {activeRobots.length === 0 ? (
                  <p className="v2-robot-empty">No connected robots</p>
                ) : (
                  activeRobots.map((bot) => (
                    <button
                      key={bot.id}
                      className={`v2-robot-row${bot.id === activeBot?.id ? " is-active" : ""}`}
                      type="button"
                      onClick={() => {
                        selectBot(bot.id);
                        setFloatCycle(true);
                      }}
                    >
                      <BotAvatar
                        bot={bot}
                        width="40"
                        height="40"
                        fallback="/logo.png"
                      />
                      <span>{bot.name}</span>
                    </button>
                  ))
                )}
                <button className="v2-robot-row v2-robot-add" type="button" onClick={openLicense}>
                  <span className="v2-robot-add-icon" aria-hidden="true">
                    +
                  </span>
                  <span>Add New Trading Bot</span>
                </button>
              </div>
            </section>
          </section>
        )}

        {v2View === "quotes" && (
          <section className="v2-view is-active">
            <header className="v2-screen-top">
              <button className="v2-back" type="button" onClick={() => setV2View("home")}>
                ←
              </button>
              <h2 className="v2-screen-title">{activeBot?.name || "Quotes"}</h2>
              <span className="v2-screen-spacer" />
            </header>
            <div className="v2-sym-tabs">
              <button
                className={`v2-sym-tab${v2SymTab === "allowed" ? " is-active" : ""}`}
                type="button"
                onClick={() => setV2SymTab("allowed")}
              >
                Allowed Symbols
              </button>
              <button
                className={`v2-sym-tab${v2SymTab === "all" ? " is-active" : ""}`}
                type="button"
                onClick={() => setV2SymTab("all")}
              >
                All Symbols
              </button>
            </div>
            <p className="v2-sym-help">
              {v2SymTab === "allowed"
                ? "These are Symbols you have selected for your EA to trade."
                : "All available symbols. Tap one to configure it for your EA."}
            </p>
            <div className="v2-sym-card">
              {list.length === 0 ? (
                <p className="v2-sym-empty">No symbols yet — choose them in Manage EA</p>
              ) : (
                list.map((symbol) => {
                  const meta = getSymbolMeta(symbol);
                  return (
                    <button
                      key={symbol}
                      className="v2-sym-row"
                      type="button"
                      onClick={() => openEdit(symbol)}
                    >
                      <strong>{symbol}</strong>
                      <span className="v2-sym-chevron">›</span>
                      <div className="v2-sym-meta">
                        <span>Lot Size {meta.lotSize}</span>
                        <span>Action {meta.action}</span>
                        <span>{meta.platform}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        )}

        {v2View === "symbol-edit" && (
          <section className="v2-view is-active">
            <header className="v2-screen-top">
              <button className="v2-back" type="button" onClick={() => setV2View("quotes")}>
                ←
              </button>
              <h2 className="v2-screen-title">{editingSymbol}</h2>
              <button
                className="v2-trash"
                type="button"
                onClick={() => {
                  removeSymbolEverywhere(editingSymbol);
                  setV2View("quotes");
                }}
              >
                🗑
              </button>
            </header>
            <form
              className="v2-edit-form"
              onSubmit={(e) => {
                e.preventDefault();
                saveSymbolMeta(editingSymbol, {
                  lotSize: Number(lotSize) || 0.01,
                  action,
                  platform,
                  trades: Math.max(1, Math.floor(Number(trades) || 1)),
                });
                setV2View("quotes");
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
                    setLotSize(Number.isFinite(n) && n > 0 ? String(Number(n.toFixed(4))) : "0.01");
                  }}
                />
              </label>
              <label className="v2-field">
                <span>Action</span>
                <select className="v2-input" value={action} onChange={(e) => setAction(e.target.value)}>
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

        {v2ScannerPremium ? (
          <ChartScanner variant="v2" active={v2View === "scanner"} />
        ) : v2View === "scanner" ? (
          <section className="v2-view is-active">
            <V2ScannerPaywall onClose={() => setV2View("home")} />
          </section>
        ) : null}

        {v2View === "metatrader" && (
          <section className="v2-view is-active v2-view-metatrader">
            <MetaTraderPanel variant="v2" />
          </section>
        )}
      </main>

      <nav className="v2-tabbar" aria-label="V2 primary">
        <button
          className={`v2-tab${v2View === "home" || v2View === "quotes" || v2View === "symbol-edit" ? " is-active" : ""}`}
          type="button"
          onClick={() => setV2View("home")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M4.5 11.2 12 4.8l7.5 6.4v8.5a1.3 1.3 0 0 1-1.3 1.3h-4.1v-5.2h-4.2v5.2H5.8A1.3 1.3 0 0 1 4.5 19.7v-8.5z" />
          </svg>
          <span>HOME</span>
        </button>
        <button
          className={`v2-tab${v2View === "scanner" ? " is-active" : ""}`}
          type="button"
          onClick={() => setV2View("scanner")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3.5" y="5" width="17" height="14" rx="2.2" />
            <path d="M7 15.5 10.2 11l2.6 2.8L16.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>CHART SCANNER</span>
        </button>
        <button
          className={`v2-tab${v2View === "metatrader" ? " is-active" : ""}`}
          type="button"
          onClick={() => setV2View("metatrader")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="9" r="3.6" />
            <path d="M5.2 19.2c.7-3.2 3.3-5 6.8-5s6.1 1.8 6.8 5" />
          </svg>
          <span>METATRADER</span>
        </button>
      </nav>

      <TradeScriptOrb
        visible={(floatCycle || v2Running || Boolean(orbTradeLive)) && v2View === "home"}
        photoSrc={floatSrc}
        botName={activeBot?.name || "Bot"}
        script={openTradeScript}
        comment={tradeComment}
        openingTrades={Boolean(orbTradeLive)}
        tradeLive={orbTradeLive}
        storageKey="apexea-float-pos-v2"
        showToast={showToast}
      />
    </div>
  );
}

