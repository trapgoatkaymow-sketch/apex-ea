import { useEffect, useRef, useState } from "react";
import {
  fetchPaypalConfig,
  renderLifetimeCardButton,
} from "./paypalApi.js";
import { useApp } from "./store.jsx";

export default function V2ScannerPaywall({ onClose }) {
  const {
    coverEmail,
    setCoverEmail,
    unlockV2ScannerPremium,
    getSignup,
    showToast,
    refreshSignups,
  } = useApp();

  const [email, setEmail] = useState(coverEmail || "");
  const [amount, setAmount] = useState("35.60");
  const [paying, setPaying] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showAlreadyPaid, setShowAlreadyPaid] = useState(false);
  const [paidEmail, setPaidEmail] = useState(coverEmail || "");
  const [paypalReady, setPaypalReady] = useState(false);
  const [paypalError, setPaypalError] = useState("");
  const paypalButtonsRef = useRef(null);
  const paypalRenderedRef = useRef(false);
  const payEmailRef = useRef(coverEmail || email || "");
  const showToastRef = useRef(showToast);
  const refreshSignupsRef = useRef(refreshSignups);
  const unlockScannerRef = useRef(unlockV2ScannerPremium);

  useEffect(() => {
    setEmail(coverEmail || "");
    if (!showAlreadyPaid) setPaidEmail(coverEmail || "");
  }, [coverEmail, showAlreadyPaid]);

  useEffect(() => {
    payEmailRef.current = String(coverEmail || email || "")
      .trim()
      .toLowerCase();
  }, [coverEmail, email]);

  useEffect(() => {
    showToastRef.current = showToast;
    refreshSignupsRef.current = refreshSignups;
    unlockScannerRef.current = unlockV2ScannerPremium;
  }, [showToast, refreshSignups, unlockV2ScannerPremium]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const buyer = String(payEmailRef.current || "")
        .trim()
        .toLowerCase();
      if (!buyer || !buyer.includes("@")) {
        setPaypalError("Enter your account email before paying.");
        setPaypalReady(false);
        return;
      }
      if (paypalRenderedRef.current && paypalButtonsRef.current?.childElementCount) {
        setPaypalReady(true);
        return;
      }

      setPaypalError("");
      setPaypalReady(false);
      try {
        const config = await fetchPaypalConfig();
        if (cancelled) return;
        if (config?.amount) setAmount(String(config.amount));
        if (!config?.clientId) throw new Error("Checkout is not configured");
        if (!config.ready) {
          throw new Error(
            "Payments are not ready yet. Add PAYPAL_CLIENT_SECRET on Vercel, then retry."
          );
        }
        if (!paypalButtonsRef.current) return;

        await renderLifetimeCardButton({
          container: paypalButtonsRef.current,
          clientId: config.clientId,
          purpose: "scanner",
          getEmail: () => payEmailRef.current,
          onPaying: (busy) => {
            if (!cancelled) setPaying(Boolean(busy));
          },
          onPaid: async (result, activeBuyer) => {
            await refreshSignupsRef.current?.();
            if (result?.purpose === "scanner" || result?.premiumScanner) {
              unlockScannerRef.current?.(result?.email || activeBuyer);
              showToastRef.current("Premium chart unlocked — 20 charts per day");
            } else {
              showToastRef.current(
                "That payment was for app access only. Chart Setup needs its own payment."
              );
            }
          },
          onError: (error) => {
            const msg =
              error?.message ||
              (typeof error === "string" ? error : "Card payment failed");
            if (!cancelled) {
              setPaypalError(msg);
              showToastRef.current(msg);
            }
          },
          onCancel: () => {
            if (!cancelled) showToastRef.current("Payment cancelled");
          },
        });

        paypalRenderedRef.current = true;
        if (!cancelled) setPaypalReady(true);
      } catch (error) {
        paypalRenderedRef.current = false;
        if (!cancelled) {
          setPaypalError(error.message || "Card checkout is unavailable");
          setPaypalReady(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveEmail(event) {
    event.preventDefault();
    const next = String(email || "")
      .trim()
      .toLowerCase();
    if (!next || !next.includes("@")) {
      showToast("Enter a valid email");
      return;
    }
    setCoverEmail?.(next);
    showToast("Email saved — checkout will load");
  }

  async function checkAlreadyPaid(event) {
    event?.preventDefault?.();
    const buyer = String(paidEmail || coverEmail || email || "")
      .trim()
      .toLowerCase();
    if (!buyer || !buyer.includes("@")) {
      showToast("Enter the email you paid with");
      return;
    }
    setChecking(true);
    try {
      setCoverEmail?.(buyer);
      const merged = await refreshSignups?.();
      const fromRemote = Array.isArray(merged)
        ? merged.find((row) => String(row.email || "").toLowerCase() === buyer)
        : null;
      const signup = fromRemote || getSignup?.(buyer);
      if (signup?.premiumScanner) {
        unlockV2ScannerPremium?.(buyer);
        showToast("Premium chart restored for this email");
      } else {
        showToast(
          "No premium chart payment found for this email. App access payment does not unlock Chart Setup — please pay again."
        );
      }
    } catch (error) {
      showToast(error.message || "Could not check payment status");
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="v2-scanner-paywall" aria-label="Premium chart unlock">
      <div className="v2-scanner-paywall-card">
        <p className="v2-scanner-paywall-eyebrow">Premium</p>
        <h2 className="v2-scanner-paywall-title">Unlock Chart Setup</h2>
        <p className="v2-scanner-paywall-copy">
          Interface 2 Chart Setup is a separate premium purchase. Pay{" "}
          <strong>${amount} USD</strong> once with your debit or credit card.
          Premium Chart Setup comes with <strong>20 charts per day</strong>.
        </p>
        <p className="v2-scanner-paywall-note">
          App access / homepage subscription does not unlock Chart Setup — even
          with the same email, you must pay for Chart Setup separately.
        </p>

        {!coverEmail ? (
          <form className="v2-scanner-paywall-form" onSubmit={saveEmail}>
            <label className="ea-field">
              <span>Account email</span>
              <input
                className="admin-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                required
              />
            </label>
            <button className="admin-btn admin-btn-solid admin-btn-block" type="submit">
              Continue
            </button>
          </form>
        ) : (
          <p className="v2-scanner-paywall-email">
            Paying for <strong>{coverEmail}</strong>
          </p>
        )}

        <div className="paypal-panel v2-scanner-paywall-paypal">
          {paypalError ? (
            <p className="ea-hint" style={{ color: "#b42318" }}>
              {paypalError}
            </p>
          ) : null}
          {!paypalReady && !paypalError ? (
            <p className="ea-hint">Loading checkout…</p>
          ) : null}
          <div
            ref={paypalButtonsRef}
            className="paypal-buttons"
            aria-label="Pay with debit or credit card"
          />
          {paying ? <p className="ea-hint">Confirming payment…</p> : null}
        </div>

        {showAlreadyPaid ? (
          <form className="v2-scanner-paywall-form" onSubmit={checkAlreadyPaid}>
            <label className="ea-field">
              <span>Email you paid with</span>
              <input
                className="admin-input"
                type="email"
                value={paidEmail}
                onChange={(e) => setPaidEmail(e.target.value)}
                placeholder="you@email.com"
                required
                autoFocus
              />
            </label>
            <button
              className="admin-btn admin-btn-solid admin-btn-block"
              type="submit"
              disabled={checking}
            >
              {checking ? "Checking…" : "Restore chart access"}
            </button>
            <button
              className="v2-scanner-paywall-already"
              type="button"
              onClick={() => setShowAlreadyPaid(false)}
              disabled={checking}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            className="v2-scanner-paywall-already"
            type="button"
            onClick={() => {
              setPaidEmail(coverEmail || email || "");
              setShowAlreadyPaid(true);
            }}
          >
            Already paid?
          </button>
        )}

        <button
          className="admin-btn admin-btn-outline admin-btn-block"
          type="button"
          onClick={onClose}
        >
          Back to Home
        </button>
      </div>
    </section>
  );
}
