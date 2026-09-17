import { useEffect, useMemo, useState } from "react";
import { useApp } from "./store";
import { fetchLicensesByEmail } from "./licensesApi";

function formatUsedAt(value) {
  const ts = Number(value) || 0;
  if (!ts) return "Not used yet";
  try {
    return new Date(ts).toLocaleString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/**
 * Small info control on a robot row — shows client email, when the key was
 * used, and the license key (with copy). Works for users who already unlocked
 * without seeing their key, using local licenseKeys or a by-email refresh.
 */
export default function RobotLicenseInfo({ bot, variant = "v2" }) {
  const { coverEmail, licenseKeys, normalizeEmail, showToast, ingestLicenses } =
    useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const botId = String(bot?.id || "").trim();

  const license = useMemo(() => {
    const keys = Array.isArray(licenseKeys) ? licenseKeys : [];
    const account = normalizeEmail(coverEmail);
    const forBot = keys.filter(
      (row) =>
        String(row.botId || row.bot?.id || "").trim() === botId ||
        String(row.key || "") === String(bot?.licenseKey || "").trim()
    );
    forBot.sort(
      (a, b) =>
        Number(b.usedAt || b.updatedAt || 0) -
        Number(a.usedAt || a.updatedAt || 0)
    );
    if (account) {
      const mine = forBot.find(
        (row) => normalizeEmail(row.clientEmail) === account
      );
      if (mine) return mine;
    }
    const used = forBot.find((row) => row.used) || forBot[0] || null;
    if (used) return used;
    // Stamps written onto the bot at activate time (survives older sessions).
    if (bot?.licenseKey) {
      return {
        key: bot.licenseKey,
        clientEmail: bot.clientEmail || account || "",
        usedAt: bot.licenseUsedAt || null,
        used: Boolean(bot.licenseUsedAt),
      };
    }
    return null;
  }, [bot, botId, coverEmail, licenseKeys, normalizeEmail]);

  useEffect(() => {
    if (!open || license?.key) return;
    const email = normalizeEmail(coverEmail);
    if (!email.includes("@") || !botId) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const remote = await fetchLicensesByEmail(email);
        if (cancelled || !Array.isArray(remote) || !remote.length) return;
        ingestLicenses?.(remote);
      } catch {
        // keep local miss
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, license?.key, coverEmail, botId, normalizeEmail, ingestLicenses]);

  async function copyKey() {
    const key = String(license?.key || "").trim();
    if (!key) {
      showToast("No license key found for this robot yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(key);
      showToast("License key copied — save it somewhere safe");
    } catch {
      showToast(key);
    }
  }

  const email =
    String(license?.clientEmail || coverEmail || bot?.clientEmail || "").trim() ||
    "—";
  const key = String(license?.key || bot?.licenseKey || "").trim();
  const usedLabel = formatUsedAt(
    license?.usedAt || license?.boundAt || bot?.licenseUsedAt
  );

  return (
    <>
      <button
        type="button"
        className={
          variant === "zeta"
            ? "robot-info-btn"
            : "v2-robot-info-btn"
        }
        aria-label={`License info for ${bot?.name || "robot"}`}
        title="License info"
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          setOpen(true);
        }}
      >
        i
      </button>

      {open ? (
        <div
          className="robot-license-sheet"
          role="dialog"
          aria-modal="true"
          aria-label="Robot license info"
          onClick={() => setOpen(false)}
        >
          <div
            className="robot-license-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="robot-license-header">
              <h3>{bot?.name || "Robot"}</h3>
              <button
                type="button"
                className="robot-license-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </header>
            <dl className="robot-license-dl">
              <div>
                <dt>Email</dt>
                <dd>{email}</dd>
              </div>
              <div>
                <dt>Key used</dt>
                <dd>{busy && !key ? "Loading…" : usedLabel}</dd>
              </div>
              <div>
                <dt>License key</dt>
                <dd className="robot-license-key">
                  {busy && !key ? "Loading…" : key || "Not found on this device"}
                </dd>
              </div>
            </dl>
            <div className="robot-license-actions">
              <button
                type="button"
                className="admin-btn admin-btn-solid admin-btn-block"
                disabled={!key}
                onClick={copyKey}
              >
                Copy license key
              </button>
              <p className="robot-license-hint">
                Save this key somewhere safe. You need it again after reinstall.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
