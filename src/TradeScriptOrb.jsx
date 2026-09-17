import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clearTradeHistory,
  formatHistoryPrice,
  formatRelativeTradeTime,
  formatTradeHistoryLines,
  loadTradeHistory,
} from "./dailyTradeHistory.js";
import {
  ensureFloatOverlayPermission,
  hideFloatOverlay,
  showFloatOverlay,
  updateFloatOverlay,
} from "./floatOverlay.js";
import { buildBotTradeComment } from "./metaApi.js";
import { isNativeApp } from "./store.jsx";

const FLOAT_SIZE = 58;
const DRAG_THRESHOLD = 8;
const TYPE_MS = 22;
const POPOVER_GAP = 10;
const POPOVER_WIDTH = 300;
const WELCOME_TEXT = "Welcome back\ntaken trades will show here";

function loadFloatPos(storageKey) {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      return { x: raw.x, y: raw.y };
    }
  } catch {
    // ignore
  }
  return null;
}

function saveFloatPos(storageKey, pos) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(pos));
  } catch {
    // ignore
  }
}

/** Short open-trade script — typewriter-friendly. */
export function buildShortOpenTradeScript({ botName, comment, symbol, lotSize, action }) {
  const name = String(botName || "Bot").trim() || "Bot";
  const tag = String(comment || buildBotTradeComment(name)).trim();
  const sym = String(symbol || "XAUUSD").trim().toUpperCase() || "XAUUSD";
  const lot = Number(lotSize) > 0 ? Number(lotSize) : 0.01;
  const mode = String(action || "BOTH").toUpperCase();
  return [
    `// ApexEA open trade`,
    `Bot     ${name}`,
    `Comment ${tag}`,
    `Symbol  ${sym}`,
    `Lot     ${lot}`,
    `Action  ${mode}`,
  ].join("\n");
}

export default function TradeScriptOrb({
  visible,
  photoSrc,
  botName = "Bot",
  script,
  comment,
  openingTrades = false,
  tradeLive = null,
  storageKey = "apexea-float-pos",
  showToast,
}) {
  const [floatPos, setFloatPos] = useState(() => loadFloatPos(storageKey));
  const [scriptOpen, setScriptOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [typingDone, setTypingDone] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tradeHistory, setTradeHistory] = useState(() => loadTradeHistory());
  const [popoverPos, setPopoverPos] = useState({ left: 8, top: 80, arrowLeft: 28 });
  const floatRef = useRef(null);
  const panelRef = useRef(null);
  const dragRef = useRef({
    active: false,
    moved: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
  });
  const wasOpeningRef = useRef(false);
  const lastRecordedAtRef = useRef(0);

  const live = tradeLive && typeof tradeLive === "object" ? tradeLive : null;
  const isOpening = Boolean(openingTrades || live);
  const displayName = String(live?.botName || botName || "Bot").trim() || "Bot";
  const tradeComment =
    String(live?.comment || comment || buildBotTradeComment(displayName)).trim() ||
    buildBotTradeComment(displayName);
  const historyText = formatTradeHistoryLines(tradeHistory);
  const fullScript = historyOpen
    ? historyText
    : isOpening
      ? live
        ? buildShortOpenTradeScript({
            botName: displayName,
            comment: tradeComment,
            symbol: live.symbol,
            lotSize: live.lotSize,
            action: live.action || live.side || "BOTH",
          })
        : script || ""
      : WELCOME_TEXT;

  // History is recorded by Chart Scanner / Economic Calendar fills (persistent).
  // Refresh the list when a live trade pulse arrives so History stays current.
  useEffect(() => {
    if (!live?.at) return;
    if (live.at === lastRecordedAtRef.current) return;
    lastRecordedAtRef.current = live.at;
    setTradeHistory(loadTradeHistory());
  }, [live]);

  // Android: keep the robot bubble over MetaTrader when the app is backgrounded.
  useEffect(() => {
    if (!isNativeApp()) return undefined;
    let cancelled = false;
    let appHandle = null;
    let armed = false;

    const payload = () => ({
      photoSrc,
      x: floatPos?.x ?? -1,
      y: floatPos?.y ?? -1,
      label: displayName,
    });

    async function armOverlay() {
      if (!visible) {
        armed = false;
        await hideFloatOverlay();
        return;
      }
      const ok = await ensureFloatOverlayPermission(showToast);
      if (cancelled || !ok) return;
      armed = true;
      await updateFloatOverlay(payload());
    }

    async function onState(isActive) {
      if (!armed || !visible) return;
      if (isActive) {
        await hideFloatOverlay();
      } else {
        await showFloatOverlay(payload());
      }
    }

    void armOverlay();

    import("@capacitor/app")
      .then(({ App }) => {
        if (cancelled) return;
        appHandle = App.addListener("appStateChange", ({ isActive }) => {
          void onState(Boolean(isActive));
        });
      })
      .catch(() => {});

    const onVis = () => {
      void onState(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      try {
        appHandle?.remove?.();
      } catch {
        // ignore
      }
      void hideFloatOverlay();
    };
  }, [visible, photoSrc, floatPos, displayName, showToast]);

  useEffect(() => {
    if (!scriptOpen) {
      setHistoryOpen(false);
      return;
    }
    setTradeHistory(loadTradeHistory());
  }, [scriptOpen]);

  function measurePopover() {
    const orb = floatRef.current;
    const layer = orb?.offsetParent;
    if (!orb || !layer) return;
    const layerRect = layer.getBoundingClientRect();
    const orbRect = orb.getBoundingClientRect();
    const panelWidth = Math.min(POPOVER_WIDTH, layer.clientWidth - 16);
    const panelHeight = panelRef.current?.offsetHeight || 260;

    // Prefer centered under the orb.
    let left = orbRect.left - layerRect.left + orbRect.width / 2 - panelWidth / 2;
    left = Math.min(layer.clientWidth - panelWidth - 8, Math.max(8, left));

    let top = orbRect.bottom - layerRect.top + POPOVER_GAP;
    const maxTop = Math.max(8, layer.clientHeight - panelHeight - 8);
    if (top > maxTop) {
      // Flip above if not enough room below.
      top = Math.max(8, orbRect.top - layerRect.top - panelHeight - POPOVER_GAP);
    }

    const arrowLeft = Math.min(
      panelWidth - 18,
      Math.max(16, orbRect.left - layerRect.left + orbRect.width / 2 - left)
    );

    setPopoverPos({ left, top, arrowLeft, width: panelWidth });
  }

  useLayoutEffect(() => {
    if (!scriptOpen) return undefined;
    measurePopover();
    const onResize = () => measurePopover();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [scriptOpen, floatPos, typed, visible, isOpening, historyOpen, tradeHistory]);

  useEffect(() => {
    if (!scriptOpen) {
      setTyped("");
      setTypingDone(false);
      return undefined;
    }
    if (historyOpen) {
      setTyped("");
      setTypingDone(true);
      return undefined;
    }
    setTyped("");
    setTypingDone(false);
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setTyped(fullScript.slice(0, i));
      if (i >= fullScript.length) {
        window.clearInterval(id);
        setTypingDone(true);
      }
    }, TYPE_MS);
    return () => window.clearInterval(id);
  }, [scriptOpen, fullScript, historyOpen]);

  // When the robot starts opening trades, open the panel and type the trade script.
  useEffect(() => {
    if (isOpening && !wasOpeningRef.current && visible) {
      setScriptOpen(true);
    }
    wasOpeningRef.current = isOpening;
  }, [isOpening, visible]);

  useEffect(() => {
    if (!scriptOpen) return undefined;
    function onKey(event) {
      if (event.key === "Escape") setScriptOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scriptOpen]);

  function clampFloatPos(x, y) {
    const layer = floatRef.current?.offsetParent;
    const width = layer?.clientWidth || window.innerWidth;
    const height = layer?.clientHeight || window.innerHeight;
    const maxX = Math.max(8, width - FLOAT_SIZE - 8);
    const maxY = Math.max(8, height - FLOAT_SIZE - 8);
    return {
      x: Math.min(maxX, Math.max(8, x)),
      y: Math.min(maxY, Math.max(8, y)),
    };
  }

  function onFloatPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const node = floatRef.current;
    if (!node) return;
    const parent = node.offsetParent;
    const parentRect = parent?.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const current = floatPos || {
      x: rect.left - (parentRect?.left || 0),
      y: rect.top - (parentRect?.top || 0),
    };
    dragRef.current = {
      active: true,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: current.x,
      origY: current.y,
    };
    node.setPointerCapture?.(event.pointerId);
  }

  function onFloatPointerMove(event) {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    setFloatPos(clampFloatPos(drag.origX + dx, drag.origY + dy));
  }

  function onFloatPointerUp(event) {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) return;
    drag.active = false;
    try {
      floatRef.current?.releasePointerCapture?.(event.pointerId);
    } catch {
      // ignore
    }
    if (drag.moved) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const next = clampFloatPos(drag.origX + dx, drag.origY + dy);
      setFloatPos(next);
      saveFloatPos(storageKey, next);
      return;
    }
    setScriptOpen(true);
  }

  async function copyScript() {
    if (historyOpen) {
      if (!historyText) return;
      try {
        await navigator.clipboard.writeText(historyText);
        showToast?.("Trade history copied");
      } catch {
        showToast?.("Could not copy history");
      }
      return;
    }
    if (!isOpening || !fullScript) return;
    try {
      await navigator.clipboard.writeText(fullScript);
      showToast?.("Trade script copied");
    } catch {
      showToast?.("Could not copy script");
    }
  }

  function toggleHistory() {
    setHistoryOpen((prev) => {
      const next = !prev;
      if (next) setTradeHistory(loadTradeHistory());
      return next;
    });
  }

  function onClearHistory() {
    setTradeHistory(clearTradeHistory());
    showToast?.("Trade history cleared");
  }

  if (!visible && !scriptOpen) return null;

  return (
    <>
      {visible ? (
        <button
          ref={floatRef}
          className={`trade-float-orb is-on${floatPos ? " is-placed" : ""}${scriptOpen ? " is-open" : ""}${
            isOpening ? " is-trading" : ""
          }`}
          type="button"
          aria-label={isOpening ? `${displayName} opening trades` : `${displayName} welcome`}
          title={isOpening ? "Drag to move · tap for trade script" : "Drag to move · tap to open"}
          style={
            floatPos
              ? { left: `${floatPos.x}px`, top: `${floatPos.y}px`, right: "auto", bottom: "auto" }
              : undefined
          }
          onPointerDown={onFloatPointerDown}
          onPointerMove={onFloatPointerMove}
          onPointerUp={onFloatPointerUp}
          onPointerCancel={onFloatPointerUp}
          onClick={(event) => event.preventDefault()}
        >
          <span className="trade-float-orb-ring" aria-hidden="true" />
          <span className="trade-float-orb-ring trade-float-orb-ring--outer" aria-hidden="true" />
          <img className="trade-float-orb-photo" src={photoSrc} alt="" draggable={false} />
        </button>
      ) : null}

      {scriptOpen ? (
        <div
          className="trade-script-sheet is-anchored"
          role="dialog"
          aria-modal="true"
          aria-label={
            historyOpen ? "Taken trades history" : isOpening ? "Open trade script" : "Welcome back"
          }
        >
          <button
            className="trade-script-backdrop"
            type="button"
            aria-label="Close"
            onClick={() => setScriptOpen(false)}
          />
          <div
            ref={panelRef}
            className={`trade-script-panel is-anchored${
              historyOpen ? " is-history" : isOpening ? " is-opening" : " is-welcome"
            }`}
            style={{
              left: `${popoverPos.left}px`,
              top: `${popoverPos.top}px`,
              width: `${popoverPos.width || POPOVER_WIDTH}px`,
              ["--script-arrow-left"]: `${popoverPos.arrowLeft}px`,
            }}
          >
            <span className="trade-script-arrow" aria-hidden="true" />
            <header className="trade-script-head">
              <div>
                {historyOpen ? (
                  <>
                    <p className="trade-script-kicker">History</p>
                    <h2>Taken trades</h2>
                  </>
                ) : isOpening ? (
                  <>
                    <p className="trade-script-kicker">Opening trades</p>
                    <h2>{displayName} script</h2>
                  </>
                ) : (
                  <>
                    <p className="trade-script-kicker">Ready</p>
                    <h2>{displayName}</h2>
                  </>
                )}
              </div>
              <div className="trade-script-head-actions">
                <button
                  className={`trade-script-history${historyOpen ? " is-active" : ""}`}
                  type="button"
                  onClick={toggleHistory}
                  aria-pressed={historyOpen}
                  title="Saved trade history"
                >
                  History
                  {tradeHistory.length > 0 ? (
                    <span className="trade-script-history-count">{tradeHistory.length}</span>
                  ) : null}
                </button>
                <button className="trade-script-close" type="button" onClick={() => setScriptOpen(false)}>
                  Close
                </button>
              </div>
            </header>
            {historyOpen ? (
              <p className="trade-script-note">Saved on this device · does not reset overnight.</p>
            ) : isOpening ? (
              <p className="trade-script-note">
                Comment tag <strong>{tradeComment}</strong>
              </p>
            ) : (
              <p className="trade-script-note">Your robot is standing by.</p>
            )}
            {historyOpen ? (
              <div className="trade-history-list" role="list">
                {tradeHistory.length === 0 ? (
                  <p className="trade-history-empty">No trades taken yet.</p>
                ) : (
                  tradeHistory.map((row) => {
                    const side = String(row.action || "").toUpperCase();
                    const isBuy = side === "BUY";
                    const isSell = side === "SELL";
                    return (
                      <div
                        key={row.id}
                        className={`trade-history-row${isBuy ? " is-buy" : ""}${isSell ? " is-sell" : ""}`}
                        role="listitem"
                      >
                        <span className="trade-history-dot" aria-hidden="true" />
                        <div className="trade-history-main">
                          <p className="trade-history-title">
                            <span className="trade-history-symbol">
                              {String(row.symbol || "").replace(/[-–—]+$/g, "")}
                            </span>
                            <span className="trade-history-side">{side}</span>
                          </p>
                          {(row.entry != null || row.takeProfit != null || row.stopLoss != null) && (
                            <p className="trade-history-levels">
                              {row.entry != null ? (
                                <span>E {formatHistoryPrice(row.entry)}</span>
                              ) : null}
                              {row.takeProfit != null ? (
                                <span className="is-tp">TP {formatHistoryPrice(row.takeProfit)}</span>
                              ) : null}
                              {row.stopLoss != null ? (
                                <span className="is-sl">SL {formatHistoryPrice(row.stopLoss)}</span>
                              ) : null}
                            </p>
                          )}
                        </div>
                        <span className="trade-history-age">
                          {formatRelativeTradeTime(row.at)}
                        </span>
                      </div>
                    );
                  })
                )}
                {tradeHistory.length > 0 ? (
                  <button
                    className="trade-history-clear"
                    type="button"
                    onClick={onClearHistory}
                  >
                    Clear all
                  </button>
                ) : null}
              </div>
            ) : (
              <pre
                className={`trade-script-code${typingDone ? " is-done" : " is-typing"}${
                  isOpening ? "" : " is-welcome"
                }`}
              >
                {typed}
                <span className="trade-script-caret" aria-hidden="true" />
              </pre>
            )}
            {isOpening || historyOpen ? (
              <div className="trade-script-actions">
                <button className="trade-script-copy" type="button" onClick={copyScript}>
                  {historyOpen ? "Copy history" : "Copy script"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
