import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { formatLicenseDuration, formatLicenseExpiry } from "./licensesApi.js";
import { useApp } from "./store.jsx";

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function formatCreatedAt(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** Prefer createdAt, then used/bound timestamps so Created never blanks. */
function resolveCreatedAt(license) {
  if (!license || typeof license !== "object") return null;
  return (
    Number(license.createdAt) ||
    Number(license.usedAt) ||
    Number(license.boundAt) ||
    Number(license.updatedAt) ||
    null
  );
}

/** Pick the client's license for a connected robot. */
export function findLicenseForBot(licenseKeys, botId, coverEmail, botName = "") {
  const id = String(botId || "").trim();
  const name = String(botName || "")
    .trim()
    .toLowerCase();
  const email = normalizeEmail(coverEmail);
  const keys = Array.isArray(licenseKeys) ? licenseKeys : [];
  if (!id && !name) return null;

  const byBot = keys.filter((row) => {
    const rowBot = String(row?.botId || row?.bot?.id || "").trim();
    if (id && rowBot === id) return true;
    if (!name) return false;
    const rowName = String(row?.botName || row?.bot?.name || "")
      .trim()
      .toLowerCase();
    return rowName && rowName === name;
  });

  const preferEmail = email
    ? byBot.filter((row) => {
        const rowEmail = normalizeEmail(row?.clientEmail);
        return !rowEmail || rowEmail === email;
      })
    : byBot;
  const pool = preferEmail.length ? preferEmail : byBot;
  if (!pool.length) return null;
  pool.sort(
    (a, b) =>
      Number(b.usedAt || b.updatedAt || b.createdAt || 0) -
      Number(a.usedAt || a.updatedAt || a.createdAt || 0)
  );
  return pool.find((row) => row?.used) || pool[0] || null;
}

/**
 * Small key icon on a robot row — tap to see license key, duration, created.
 * Sheet is portaled to document.body so phone overflow/contain cannot clip it.
 */
export default function BotLicenseInfoButton({ bot, className = "" }) {
  const { licenseKeys, coverEmail, showToast } = useApp();
  const [open, setOpen] = useState(false);

  const license = useMemo(() => {
    const fromStore = findLicenseForBot(
      licenseKeys,
      bot?.id,
      coverEmail,
      bot?.name
    );
    if (fromStore?.key) return fromStore;
    // Fallback: license stamped onto the bot at activation time.
    if (bot?.licenseKey) {
      return {
        key: bot.licenseKey,
        duration: bot.licenseDuration || "lifetime",
        expiresAt: bot.licenseExpiresAt ?? null,
        createdAt: bot.licenseCreatedAt || null,
        usedAt: bot.licenseUsedAt || null,
      };
    }
    return null;
  }, [licenseKeys, bot, coverEmail]);

  const durationLabel = license
    ? [formatLicenseDuration(license), formatLicenseExpiry(license)]
        .filter(Boolean)
        .join(" · ")
    : "";

  const createdLabel = formatCreatedAt(resolveCreatedAt(license));

  async function copyKey(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!license?.key) return;
    const text = String(license.key);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
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
      showToast("License key copied");
    } catch {
      showToast(text);
    }
  }

  function closeSheet() {
    setOpen(false);
  }

  const sheet =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            className="bot-license-sheet-backdrop"
            role="presentation"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeSheet();
            }}
          >
            <div
              className="bot-license-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="License details"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="bot-license-sheet-head">
                <strong>{bot?.name || "Bot"} license</strong>
                <button
                  type="button"
                  className="bot-license-sheet-close"
                  aria-label="Close"
                  onClick={closeSheet}
                >
                  ×
                </button>
              </div>
              {license?.key ? (
                <dl className="bot-license-sheet-grid">
                  <div>
                    <dt>License key</dt>
                    <dd>
                      <code>{license.key}</code>
                      <button type="button" className="bot-license-copy" onClick={copyKey}>
                        Copy
                      </button>
                    </dd>
                  </div>
                  <div>
                    <dt>Duration</dt>
                    <dd>{durationLabel || "—"}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{createdLabel}</dd>
                  </div>
                </dl>
              ) : (
                <p className="bot-license-sheet-empty">
                  No license key found for this EA on this account yet. Activate with your mentor
                  key first.
                </p>
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        type="button"
        className={`bot-license-info-btn${className ? ` ${className}` : ""}`}
        aria-label={`License info for ${bot?.name || "bot"}`}
        title="License info"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor">
          <path d="M12.5 3.5a4 4 0 0 0-3.5 6.05L3.7 14.85a1.5 1.5 0 0 0-.44 1.06v2.59c0 .83.67 1.5 1.5 1.5h2.59c.4 0 .78-.16 1.06-.44l1.1-1.1v-1.96h1.96l.7-.7V14.3l.55-.55A4 4 0 1 0 12.5 3.5zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z" />
        </svg>
      </button>
      {sheet}
    </>
  );
}
