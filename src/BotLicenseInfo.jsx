import { useMemo, useState } from "react";
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

/** Pick the client's license for a connected robot. */
export function findLicenseForBot(licenseKeys, botId, coverEmail) {
  const id = String(botId || "").trim();
  if (!id) return null;
  const email = normalizeEmail(coverEmail);
  const keys = Array.isArray(licenseKeys) ? licenseKeys : [];
  const matches = keys.filter((row) => {
    const rowBot = String(row?.botId || row?.bot?.id || "").trim();
    if (rowBot !== id) return false;
    if (!email) return true;
    const rowEmail = normalizeEmail(row?.clientEmail);
    return !rowEmail || rowEmail === email;
  });
  if (!matches.length) return null;
  matches.sort(
    (a, b) =>
      Number(b.usedAt || b.updatedAt || b.createdAt || 0) -
      Number(a.usedAt || a.updatedAt || a.createdAt || 0)
  );
  return matches.find((row) => row?.used) || matches[0] || null;
}

/**
 * Small key icon on a robot row — tap to see license key, duration, created.
 */
export default function BotLicenseInfoButton({ bot, className = "" }) {
  const { licenseKeys, coverEmail, showToast } = useApp();
  const [open, setOpen] = useState(false);

  const license = useMemo(
    () => findLicenseForBot(licenseKeys, bot?.id, coverEmail),
    [licenseKeys, bot?.id, coverEmail]
  );

  if (!license?.key) return null;

  const durationLabel = [
    formatLicenseDuration(license),
    formatLicenseExpiry(license),
  ]
    .filter(Boolean)
    .join(" · ");

  async function copyKey(event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(license.key));
      showToast("License key copied");
    } catch {
      showToast(String(license.key));
    }
  }

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
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
          <path d="M12.5 3.5a4 4 0 0 0-3.5 6.05L3.7 14.85a1.5 1.5 0 0 0-.44 1.06v2.59c0 .83.67 1.5 1.5 1.5h2.59c.4 0 .78-.16 1.06-.44l1.1-1.1v-1.96h1.96l.7-.7V14.3l.55-.55A4 4 0 1 0 12.5 3.5zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4z" />
        </svg>
      </button>

      {open ? (
        <div
          className="bot-license-sheet-backdrop"
          role="presentation"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
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
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
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
                <dd>{durationLabel}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatCreatedAt(license.createdAt)}</dd>
              </div>
            </dl>
          </div>
        </div>
      ) : null}
    </>
  );
}
