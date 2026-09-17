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
 * Small info control on a robot row — shows THIS signed-in client's email,
 * when their key was used, and their license key (with copy).
 * Never falls back to another client's license for the same shared botId.
 */
export default function RobotLicenseInfo({ bot, variant = "v2" }) {
  const { coverEmail, licenseKeys, normalizeEmail, showToast, ingestLicenses } =
    useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const botId = String(bot?.id || "").trim();
  const account = normalizeEmail(coverEmail);

  const license = useMemo(() => {
    const keys = Array.isArray(licenseKeys) ? licenseKeys : [];
    const stampedKey = String(bot?.licenseKey || "").trim();
    const stampedEmail = normalizeEmail(bot?.clientEmail);

    // Only trust a bot stamp when it belongs to the signed-in account.
    const stampTrusted =
      Boolean(stampedKey) &&
      (!account || !stampedEmail || stampedEmail === account);

    if (account) {
      const mine = keys.filter(
        (row) => normalizeEmail(row.clientEmail) === account
      );
      const forBot = mine.filter(
        (row) =>
          String(row.botId || row.bot?.id || "").trim() === botId ||
          (stampedKey &&
            String(row.key || "").trim().toUpperCase() ===
              stampedKey.toUpperCase())
      );
      forBot.sort(
        (a, b) =>
          Number(b.usedAt || b.updatedAt || 0) -
          Number(a.usedAt || a.updatedAt || 0)
      );
      if (forBot[0]) return forBot[0];

      // Same account, any key for this bot id already handled — try stamp
      // only when the stamp email matches (or stamp has no email).
      if (stampTrusted && stampedKey) {
        return {
          key: stampedKey,
          clientEmail: account,
          usedAt: bot.licenseUsedAt || null,
          used: Boolean(bot.licenseUsedAt),
        };
      }
      return null;
    }

    // No signed-in email — only show an explicit local stamp, never a
    // random used key from the shared bot pool.
    if (stampTrusted && stampedKey) {
      return {
        key: stampedKey,
        clientEmail: stampedEmail || "",
        usedAt: bot.licenseUsedAt || null,
        used: Boolean(bot.licenseUsedAt),
      };
    }
    return null;
  }, [account, bot, botId, licenseKeys, normalizeEmail]);

  useEffect(() => {
    if (!open) return;
    const email = account;
    if (!email.includes("@")) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const remote = await fetchLicensesByEmail(email);
        if (cancelled || !Array.isArray(remote) || !remote.length) return;
        // Only ingest this account's rows — never the global license list.
        ingestLicenses?.(
          remote.filter((row) => normalizeEmail(row.clientEmail) === email)
        );
      } catch {
        // keep local miss
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, account, botId, normalizeEmail, ingestLicenses]);

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

  // Always prefer the signed-in email over any license/bot stamp.
  const email = account || String(license?.clientEmail || "").trim() || "—";
  const key = String(license?.key || "").trim();
  const usedLabel = formatUsedAt(license?.usedAt || license?.boundAt);

  return (
    <>
      <button
        type="button"
        className={variant === "zeta" ? "robot-info-btn" : "v2-robot-info-btn"}
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
                  {busy && !key ? "Loading…" : key || "Not found for your email"}
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
