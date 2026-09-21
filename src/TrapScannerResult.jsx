import BotAvatar from "./BotAvatar.jsx";
import { normalizeBrokerSymbol } from "./brokerSymbol.js";

function formatPrice(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 100) return n.toFixed(3);
  if (abs >= 10) return n.toFixed(4);
  return n.toFixed(5);
}

function levelPct(entry, level, side, kind) {
  const e = Number(entry);
  const l = Number(level);
  if (!Number.isFinite(e) || !Number.isFinite(l) || e === 0) return null;
  const isSell = String(side).toUpperCase() === "SELL";
  let pct;
  if (kind === "tp") {
    pct = isSell ? ((e - l) / e) * 100 : ((l - e) / e) * 100;
  } else {
    pct = isSell ? ((l - e) / e) * 100 : ((e - l) / e) * 100;
  }
  if (!Number.isFinite(pct)) return null;
  const sign = kind === "sl" ? "-" : "+";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/**
 * Interface 2 setup result card — keep this layout when restoring the ZETA scanner chrome.
 */
export default function TrapScannerResult({
  activeBot,
  signal,
  connected,
  busy,
  executeTrade,
  tradeManagement,
  updateTradeManagement,
  fills,
  executingLabel = null,
}) {
  const side = String(signal?.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const displaySymbol = normalizeBrokerSymbol(signal?.symbol || "");
  const confidence = Math.max(
    0,
    Math.min(100, Math.round(Number(signal?.confidence) || 0))
  );

  const levels = [
    {
      key: "tp1",
      label: "TP1",
      tone: "tp",
      price: signal?.takeProfit1,
      pct: levelPct(signal?.entry, signal?.takeProfit1, side, "tp"),
    },
    {
      key: "tp2",
      label: "TP2",
      tone: "tp",
      price: signal?.takeProfit2,
      pct: levelPct(signal?.entry, signal?.takeProfit2, side, "tp"),
    },
    {
      key: "tp3",
      label: "TP3",
      tone: "tp",
      price: signal?.takeProfit3,
      pct: levelPct(signal?.entry, signal?.takeProfit3, side, "tp"),
    },
    {
      key: "sl",
      label: "SL",
      tone: "sl",
      price: signal?.stopLoss,
      pct: levelPct(signal?.entry, signal?.stopLoss, side, "sl"),
    },
  ];

  return (
    <div className={`tg-result tg-result--${side.toLowerCase()}`}>
      <div className="tg-result-head">
        <div className="tg-result-sym">
          <BotAvatar
            className="tg-result-ea"
            bot={activeBot}
            fallback="/logo.png"
            width="28"
            height="28"
          />
          <div>
            <strong>{displaySymbol || "SETUP"}</strong>
            <em>
              {signal?.timeframe || "M15"} · Entry {formatPrice(signal?.entry)}
            </em>
          </div>
        </div>
        <span className={`tg-side-pill is-${side.toLowerCase()}`}>
          {side === "BUY" ? "↑" : "↓"} {side}
        </span>
        <div
          className="tg-confidence"
          style={{ ["--tg-conf"]: confidence }}
          aria-label={`Confidence ${confidence}%`}
          title={`Confidence ${confidence}%`}
        >
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle className="tg-conf-track" cx="18" cy="18" r="15" />
            <circle className="tg-conf-val" cx="18" cy="18" r="15" />
          </svg>
          <span className="tg-conf-in">
            <strong>{confidence}</strong>
            <em>%</em>
          </span>
        </div>
      </div>

      <div className="tg-levels">
        {levels.map((row) => (
          <div key={row.key} className={`tg-level is-${row.tone}`}>
            <span className="tg-level-tag">
              <i aria-hidden="true" />
              {row.label}
            </span>
            <strong>{formatPrice(row.price)}</strong>
            <em>{row.pct || "—"}</em>
          </div>
        ))}
      </div>

      <div className="tg-manage">
        <label>
          <input
            type="checkbox"
            checked={tradeManagement.moveSlToBreakevenAfterTp1}
            disabled={busy}
            onChange={(e) =>
              updateTradeManagement({ moveSlToBreakevenAfterTp1: e.target.checked })
            }
          />
          <span>SL → BE after TP1</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={tradeManagement.protectProfitAfterTp2}
            disabled={busy}
            onChange={(e) =>
              updateTradeManagement({ protectProfitAfterTp2: e.target.checked })
            }
          />
          <span>Protect after TP2</span>
        </label>
      </div>

      <button
        type="button"
        className={`tg-execute${executingLabel ? " is-executing" : ""}`}
        onClick={executeTrade}
        disabled={busy || !connected}
      >
        <span className="tg-execute-fx" aria-hidden="true">
          <i className="tg-execute-fx-ripple" />
          <i className="tg-execute-fx-ripple" />
          <i className="tg-execute-fx-shine" />
          <i className="tg-execute-fx-spark tg-execute-fx-spark--1" />
          <i className="tg-execute-fx-spark tg-execute-fx-spark--2" />
          <i className="tg-execute-fx-spark tg-execute-fx-spark--3" />
          <i className="tg-execute-fx-spark tg-execute-fx-spark--4" />
        </span>
        <span className="tg-execute-icon" aria-hidden="true">
          {executingLabel ? "…" : "✈"}
        </span>
        <span className="tg-execute-copy">
          <strong>
            {executingLabel
              ? executingLabel
              : !connected
                ? "Connect MT5"
                : "Execute"}
          </strong>
          <em>{executingLabel ? "Opening trades…" : "Manual execution only"}</em>
        </span>
      </button>

      {fills.length ? (
        <p className="tg-fills">
          {fills.filter((f) => f.ok !== false).length}/{fills.length} trades filled
        </p>
      ) : (
        <p className="tg-note">TP1 / TP2 / TP3 will be set after execution.</p>
      )}
    </div>
  );
}
