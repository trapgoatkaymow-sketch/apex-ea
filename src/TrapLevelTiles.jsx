import { useRef, useState } from "react";
import { useApp } from "./store.jsx";

const DOUBLE_TAP_MS = 340;

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

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  document.body.removeChild(area);
}

/**
 * TP1 / TP2 / TP3 / SL tiles — double-tap (or double-click) copies the price.
 */
export default function TrapLevelTiles({ levels }) {
  const { showToast } = useApp();
  const lastTapRef = useRef({ key: null, at: 0 });
  const [copiedKey, setCopiedKey] = useState(null);
  const copiedTimerRef = useRef(0);

  async function copyLevel(row) {
    const text = formatPrice(row.price);
    if (!text || text === "—") return;
    try {
      await writeClipboard(text);
      setCopiedKey(row.key);
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopiedKey(null), 900);
      showToast(`${row.label} copied`);
    } catch {
      showToast(text);
    }
  }

  function handleTap(row, event) {
    if (event.pointerType === "mouse" && event.button != null && event.button !== 0) {
      return;
    }
    const now = Date.now();
    const last = lastTapRef.current;
    if (last.key === row.key && now - last.at <= DOUBLE_TAP_MS) {
      lastTapRef.current = { key: null, at: 0 };
      event.preventDefault();
      copyLevel(row);
      return;
    }
    lastTapRef.current = { key: row.key, at: now };
  }

  return (
    <div className="tg-levels" aria-label="Price levels. Double tap to copy.">
      {levels.map((row) => (
        <button
          key={row.key}
          type="button"
          className={`tg-level is-${row.tone}${copiedKey === row.key ? " is-copied" : ""}`}
          onPointerUp={(event) => handleTap(row, event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              copyLevel(row);
            }
          }}
          title={`Double tap to copy ${row.label}`}
          aria-label={`${row.label} ${formatPrice(row.price)}. Double tap to copy`}
        >
          <span className="tg-level-tag">
            <i aria-hidden="true" />
            {row.label}
          </span>
          <strong>{formatPrice(row.price)}</strong>
          <em>{row.pct || "—"}</em>
        </button>
      ))}
    </div>
  );
}
