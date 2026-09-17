import { useEffect, useRef, useState } from "react";
import {
  capturePaypalOrder,
  createPaypalOrder,
  fetchPaypalConfig,
  loadPaypalSdk,
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
      // Keep existing buttons if already mounted — do not restart checkout.
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
        if (!config?.clientId) throw new Error("PayPal client id is missing");
        if (!config.ready) {
          throw new Error(
            "PayPal secret not set yet. Add PAYPAL_CLIENT_SECRET on Vercel, then retry."
          );
        }

        const paypal = await loadPaypalSdk(config.clientId);
        if (cancelled || !paypalButtonsRef.current) return;
        if (paypalRenderedRef.current && paypalButtonsRef.current.childElementCount) {
          if (!cancelled) setPaypalReady(true);
          return;
        }
        paypalButtonsRef.current.innerHTML = "";

        const buttons = paypal.Buttons({
          style: {
            layout: "vertical",
            color: "gold",
            shape: "rect",
            label: "pay",
            height: 48,
          },
          createOrder: async () => {
            const activeBuyer = payEmailRef.current;
            if (!activeBuyer || !activeBuyer.includes("@")) {
              throw new Error("Enter a valid email before paying");
            }
            // Always create a scanner-purpose order — separate from app access.
            const order = await createPaypalOrder(activeBuyer, "scanner");
            if (!order?.id) throw new Error("Could not start PayPal checkout");
            return order.id;
          },
          onApprove: async (data) => {
            setPaying(true);
            try {
              const activeBuyer = payEmailRef.current;
              const result = await capturePaypalOrder(
                data.orderID,
                activeBuyer,
                "scanner"
              );
              await refreshSignupsRef.current?.();
              // Only unlock when this capture was a scanner purchase.
              if (result?.purpose === "scanner" || result?.premiumScanner) {
                unlockScannerRef.current?.(result?.email || activeBuyer);
                showToastRef.current("Premium scanner unlocked — 20 scans per day");
              } else {
                showToastRef.current(
                  "That payment was for app access only. Chart Scanner needs its own payment."
                );
              }
            } catch (error) {
              showToastRef.current(error.message || "Payment capture failed");
            } finally {
              setPaying(false);
            }
          },
          onError: () => {
            showToastRef.current("PayPal checkout error — try again");
          },
          onCancel: () => {
            showToastRef.current("Payment cancelled");
          },
        });
        paypalRenderedRef.current = true;
        await buttons.render(paypalButtonsRef.current);

        if (!cancelled) setPaypalReady(true);
      } catch (error) {
        paypalRenderedRef.current = false;
        if (!cancelled) {
          setPaypalError(error.message || "PayPal is unavailable");
          setPaypalReady(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Mount once on open; email updates are read via payEmailRef.
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
    showToast("Email saved — PayPal will load");
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
        showToast("Premium scanner restored for this email");
      } else {
        showToast(
          "No premium scanner payment found for this email. App access payment does not unlock the scanner — please pay again."
        );
      }
    } catch (error) {
      showToast(error.message || "Could not check payment status");
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="v2-scanner-paywall" aria-label="Premium scanner unlock">
      <div className="v2-scanner-paywall-card">
        <p className="v2-scanner-paywall-eyebrow">Premium</p>
        <h2 className="v2-scanner-paywall-title">Unlock Chart Scanner</h2>
        <p className="v2-scanner-paywall-copy">
          Interface 2 Chart Scanner is a separate premium purchase. Pay{" "}
          <strong>${amount} USD</strong> once to unlock it. You can pay with
          debit/credit card or PayPal — a PayPal account is not required for
          card. The premium scanner comes with <strong>20 scans per day</strong>.
        </p>
        <p className="v2-scanner-paywall-note">
          App access / homepage subscription does not unlock this scanner — even
          with the same email, you must pay for the scanner separately.
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
              Continue to checkout
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
            <p className="ea-hint">Loading PayPal…</p>
          ) : null}
          <div ref={paypalButtonsRef} className="paypal-buttons" />
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
              {checking ? "Checking…" : "Restore scanner access"}
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
