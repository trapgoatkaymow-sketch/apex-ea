import { useEffect, useRef, useState } from "react";
import {
  capturePaypalOrder,
  fetchPaypalConfig,
  renderLifetimeCardButton,
} from "./paypalApi.js";
import {
  hasPaidOnThisDevice,
  isAccountPaidOrBypassed,
  isLicenseBoundToThisDevice,
  rememberDeviceAccess,
} from "./deviceAccess.js";
import {
  claimInviteLicenseRemote,
  fetchInvitePreview,
  fetchLicensesByEmail,
  isLicenseExpired,
} from "./licensesApi.js";
import {
  fetchSignups,
  submitSignup,
  updateSignupAccessPaid,
} from "./signupsApi.js";
import { useApp } from "./store.jsx";

const PAYPAL_EMAIL_KEY = "apexea-paypal-email";
const PAYPAL_ORDER_KEY = "apexea-paypal-order";

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function readPaypalReturnFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    if (params.get("paypal_cancel") === "1") {
      return { cancelled: true, orderId: "" };
    }
    const orderId = String(params.get("token") || params.get("orderId") || "").trim();
    const payerId = String(params.get("PayerID") || params.get("payerId") || "").trim();
    const flagged = params.get("paypal_return") === "1";
    if (orderId && (flagged || payerId)) {
      return { cancelled: false, orderId, payerId };
    }
    return null;
  } catch {
    return null;
  }
}

function clearPaypalReturnFromUrl() {
  try {
    const url = new URL(window.location.href);
    [
      "paypal_return",
      "paypal_cancel",
      "token",
      "orderId",
      "PayerID",
      "payerId",
    ].forEach((key) => url.searchParams.delete(key));
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  } catch {
    // ignore
  }
}

function readInviteFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const rawHash = String(window.location.hash || "").replace(/^#/, "");
    // Support ?invite=… and #invite=… (and #/invite?code=…)
    const hashQuery = rawHash.includes("?")
      ? rawHash.slice(rawHash.indexOf("?") + 1)
      : rawHash;
    const hashParams = new URLSearchParams(hashQuery);
    if (!hashParams.get("invite") && hashParams.get("code")) {
      hashParams.set("invite", hashParams.get("code"));
    }
    const invite = String(
      params.get("invite") ||
        params.get("code") ||
        hashParams.get("invite") ||
        hashParams.get("code") ||
        ""
    )
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!invite) return null;
    const migrateRaw = String(
      params.get("migrate") || hashParams.get("migrate") || "1"
    )
      .trim()
      .toLowerCase();
    return {
      invite,
      botId: String(params.get("bot") || hashParams.get("bot") || "").trim(),
      botName: String(
        params.get("botName") || hashParams.get("botName") || "Bot"
      ).trim(),
      duration: String(
        params.get("duration") || hashParams.get("duration") || "lifetime"
      )
        .trim()
        .toLowerCase(),
      // Invite links are for migrating old clients — free access by default.
      migrate: migrateRaw !== "0" && migrateRaw !== "false" && migrateRaw !== "no",
      until: Number(params.get("until") || hashParams.get("until") || 0) || 0,
      sig: String(params.get("sig") || hashParams.get("sig") || "")
        .trim()
        .toLowerCase(),
    };
  } catch {
    return null;
  }
}

function clearInviteFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    url.searchParams.delete("code");
    url.searchParams.delete("bot");
    url.searchParams.delete("botName");
    url.searchParams.delete("duration");
    url.searchParams.delete("migrate");
    url.searchParams.delete("until");
    url.searchParams.delete("sig");
    // Drop hash invite payload too.
    if (/invite|bot=/i.test(url.hash || "")) {
      url.hash = "";
    }
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  } catch {
    // ignore
  }
}

function licenseStillValid(row) {
  // Lifetime keys must never be treated as expired (stale expiresAt happens).
  const duration = String(row?.duration || "").toLowerCase();
  if (duration === "lifetime") return true;
  return !isLicenseExpired(row);
}

async function emailOwnsLicense(email) {
  const key = normalizeEmail(email);
  if (!key.includes("@")) return [];
  try {
    const rows = await fetchLicensesByEmail(key);
    return (rows || []).filter(
      (row) =>
        normalizeEmail(row.clientEmail) === key &&
        licenseStillValid(row) &&
        String(row.key || "").trim()
    );
  } catch {
    return [];
  }
}

export default function CoverLock() {
  const {
    hasActiveBot,
    lockStep,
    setLockStep,
    coverEmail,
    setCoverEmail,
    requestSignup,
    getSignup,
    activateLicense,
    showToast,
    openAdmin,
    refreshSignups,
    ingestSignup,
    licenseKeys,
  } = useApp();

  const [email, setEmail] = useState(coverEmail || "");
  const [licenseKey, setLicenseKey] = useState("");
  const [paying, setPaying] = useState(false);
  const [checkingPaid, setCheckingPaid] = useState(false);
  const [paypalError, setPaypalError] = useState("");
  const [cardReady, setCardReady] = useState(false);
  const [inviteMeta, setInviteMeta] = useState(() => readInviteFromUrl());
  const [inviteMentorName, setInviteMentorName] = useState("");
  const [inviteClientName, setInviteClientName] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [claimedKey, setClaimedKey] = useState("");
  const [claimedLicense, setClaimedLicense] = useState(null);
  const hotspotRef = useRef({ count: 0, first: 0 });
  const payEmailRef = useRef(coverEmail || email || "");
  const cardButtonsRef = useRef(null);
  const cardRenderedRef = useRef(false);
  const paypalReturnHandledRef = useRef(false);
  const showToastRef = useRef(showToast);
  const refreshSignupsRef = useRef(refreshSignups);
  const ingestSignupRef = useRef(ingestSignup);
  const setLockStepRef = useRef(setLockStep);
  const requestSignupRef = useRef(requestSignup);

  useEffect(() => {
    setEmail(coverEmail || "");
  }, [coverEmail]);

  useEffect(() => {
    payEmailRef.current = String(coverEmail || email || "")
      .trim()
      .toLowerCase();
  }, [coverEmail, email]);

  useEffect(() => {
    showToastRef.current = showToast;
    refreshSignupsRef.current = refreshSignups;
    ingestSignupRef.current = ingestSignup;
    setLockStepRef.current = setLockStep;
    requestSignupRef.current = requestSignup;
  }, [showToast, refreshSignups, ingestSignup, setLockStep, requestSignup]);

  // After PayPal hosted checkout, capture the order and unlock.
  useEffect(() => {
    if (paypalReturnHandledRef.current) return undefined;
    const returned = readPaypalReturnFromUrl();
    if (!returned) return undefined;
    paypalReturnHandledRef.current = true;
    clearPaypalReturnFromUrl();

    if (returned.cancelled) {
      setLockStep("pay");
      showToast("Payment cancelled — try again");
      return undefined;
    }

    let cancelled = false;
    setPaying(true);
    setLockStep("pay");
    (async () => {
      try {
        let paidEmail = "";
        let storedOrder = "";
        try {
          paidEmail = String(sessionStorage.getItem(PAYPAL_EMAIL_KEY) || "")
            .trim()
            .toLowerCase();
          storedOrder = String(sessionStorage.getItem(PAYPAL_ORDER_KEY) || "").trim();
        } catch {
          // ignore
        }
        if (paidEmail) {
          setEmail(paidEmail);
          await requestSignupRef.current?.(paidEmail);
        }
        const orderId = returned.orderId || storedOrder;
        if (!orderId) throw new Error("Missing PayPal order — tap Pay again");
        const result = await capturePaypalOrder(orderId, paidEmail, "access");
        const confirmed = String(result?.email || paidEmail || "")
          .trim()
          .toLowerCase();
        if (!confirmed.includes("@")) {
          throw new Error("Payment ok, but email was missing — tap I have paid");
        }
        rememberDeviceAccess(confirmed, { paid: true, bypassed: true });
        ingestSignupRef.current?.({
          email: confirmed,
          status: "approved",
          accessPaid: true,
          accessPaidAt: Date.now(),
        });
        void refreshSignupsRef.current?.();
        try {
          sessionStorage.removeItem(PAYPAL_EMAIL_KEY);
          sessionStorage.removeItem(PAYPAL_ORDER_KEY);
        } catch {
          // ignore
        }
        if (cancelled) return;
        setLockStepRef.current("license");
        showToastRef.current(`Payment received — ${confirmed} approved`);
      } catch (error) {
        if (!cancelled) {
          setPaypalError(error.message || "Could not confirm PayPal payment");
          setLockStep("pay");
          showToastRef.current(error.message || "Payment capture failed");
        }
      } finally {
        if (!cancelled) setPaying(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setLockStep, showToast]);

  // Mentor invite link → clients claim their own key (no CSV / no mentor typing).
  // Re-assert when the normal unlock resolver tries to overwrite lockStep.
  useEffect(() => {
    const meta = readInviteFromUrl();
    if (!meta?.invite) return undefined;
    // Don't steal focus during PayPal return capture.
    if (readPaypalReturnFromUrl()) return undefined;
    setInviteMeta(meta);
    if (lockStep !== "invite" && lockStep !== "license" && lockStep !== "pay") {
      setLockStep("invite");
    }
    let cancelled = false;
    void fetchInvitePreview(meta.invite)
      .then((invite) => {
        if (cancelled || !invite) return;
        setInviteMentorName(String(invite.mentorName || "").trim());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lockStep, setLockStep]);

  // Warm license lookup — only treat as paid if the key is already bound to THIS phone.
  useEffect(() => {
    const key = normalizeEmail(coverEmail || email);
    if (!key.includes("@")) return undefined;
    if (lockStep !== "pending" && lockStep !== "pay" && lockStep !== "cover") {
      return undefined;
    }
    let cancelled = false;
    void emailOwnsLicense(key).then((owned) => {
      if (cancelled || !owned?.length) return;
      const onThisPhone = owned.filter((row) => isLicenseBoundToThisDevice(row));
      if (!onThisPhone.length) return;
      rememberDeviceAccess(key, { paid: true, bypassed: true });
    });
    return () => {
      cancelled = true;
    };
  }, [lockStep, coverEmail, email]);

  // Auto-restore paid/bypassed emails on the paywall without waiting for a second tap.
  useEffect(() => {
    if (lockStep !== "pending") return undefined;
    const key = normalizeEmail(coverEmail || email);
    if (!key.includes("@")) return undefined;
    let cancelled = false;
    void (async () => {
      const { entitled, current } = await resolveReturningAccess(key, { waitMs: 8000 });
      if (cancelled || !entitled) return;
      await grantAccessForEmail(key, current);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when paywall email changes
  }, [lockStep, coverEmail]);

  // In-app Debit/Credit Card button — no redirect to PayPal login.
  useEffect(() => {
    if (lockStep !== "pay") return undefined;
    let cancelled = false;

    async function mountCard() {
      const buyer = String(payEmailRef.current || "")
        .trim()
        .toLowerCase();
      if (!buyer.includes("@")) {
        setPaypalError("Enter your account email before paying.");
        setCardReady(false);
        return;
      }
      if (cardRenderedRef.current && cardButtonsRef.current?.childElementCount) {
        setCardReady(true);
        return;
      }

      setPaypalError("");
      setCardReady(false);
      try {
        await requestSignupRef.current?.(buyer);
        const config = await fetchPaypalConfig();
        if (cancelled) return;
        if (!config?.clientId || !config.ready) {
          throw new Error(
            "Payments are not ready yet. Ask admin to set PAYPAL_CLIENT_SECRET on Vercel."
          );
        }
        if (!cardButtonsRef.current) return;

        await renderLifetimeCardButton({
          container: cardButtonsRef.current,
          clientId: config.clientId,
          purpose: "access",
          getEmail: () => payEmailRef.current,
          onPaying: (busy) => {
            if (!cancelled) setPaying(Boolean(busy));
          },
          onPaid: async (result, paidEmail) => {
            const confirmed = String(result?.email || paidEmail || "")
              .trim()
              .toLowerCase();
            if (!confirmed.includes("@")) {
              throw new Error("Payment ok, but email was missing — tap I have paid");
            }
            rememberDeviceAccess(confirmed, { paid: true, bypassed: true });
            ingestSignupRef.current?.({
              email: confirmed,
              status: "approved",
              accessPaid: true,
              accessPaidAt: Date.now(),
            });
            void refreshSignupsRef.current?.();
            setEmail(confirmed);
            setLockStepRef.current("license");
            showToastRef.current("Payment confirmed — enter your license key");
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
        cardRenderedRef.current = true;
        if (!cancelled) setCardReady(true);
      } catch (error) {
        cardRenderedRef.current = false;
        if (!cancelled) {
          setPaypalError(error.message || "Card checkout unavailable");
          setCardReady(false);
        }
      }
    }

    void mountCard();
    return () => {
      cancelled = true;
    };
  }, [lockStep, coverEmail]);

  // Keep return-URL capture for any leftover old checkout sessions.
  useEffect(() => {
    if (lockStep !== "pending") return undefined;
    let cancelled = false;
    void fetchPaypalConfig()
      .then((config) => {
        if (cancelled) return;
        if (!config?.ready) {
          setPaypalError(
            "Payments are not ready yet. Ask admin to set PAYPAL_CLIENT_SECRET on Vercel."
          );
        } else {
          setPaypalError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setPaypalError(error.message || "Checkout unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [lockStep]);

  // Allow license entry while unlocked so "Add New Trading Bot" can activate
  // another robot without wiping the ones already on the home screen.
  // Invite claim must also show even if this phone already has bots (mentor
  // testing their own link, or a client adding via invite).
  const addingBot = hasActiveBot && lockStep === "license";
  const claimingInvite = lockStep === "invite";
  if (hasActiveBot && !addingBot && !claimingInvite) return null;

  const signup = getSignup(coverEmail || email);
  const declined = signup?.status === "declined";

  function onHotspotClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - hotspotRef.current.first > 600) {
      hotspotRef.current = { count: 1, first: now };
    } else {
      hotspotRef.current.count += 1;
    }
    if (hotspotRef.current.count >= 3) {
      hotspotRef.current = { count: 0, first: 0 };
      openAdmin("dashboard");
      showToast("Admin portal");
    }
  }

  async function grantAccessForEmail(key, current) {
    rememberDeviceAccess(key, {
      paid: true,
      bypassed: true,
    });
    // Stamp local signup immediately so resolveLockStep cannot bounce back to paywall.
    const paidRow = persistPaidLocally(key, current);
    ingestSignup?.(paidRow);
    // Returning clients skip payment, but must type their license key again.
    // Same phone: key works. Different phone: key stays locked.
    setLockStep("license");
    showToast("Access restored — enter your license key");
    // Persist paid flag in the background — never block the unlock UI on it.
    void updateSignupAccessPaid(key)
      .then((remote) => {
        if (remote) ingestSignup?.(remote);
        else refreshSignups?.();
      })
      .catch(() => {});
    return true;
  }

  function persistPaidLocally(key, current) {
    return {
      ...(current || { email: key }),
      email: key,
      status: "approved",
      accessPaid: true,
      accessPaidAt: Date.now(),
    };
  }

  function localLicensesForEmail(key) {
    return (Array.isArray(licenseKeys) ? licenseKeys : []).filter(
      (row) =>
        normalizeEmail(row?.clientEmail) === key &&
        licenseStillValid(row) &&
        String(row?.key || "").trim()
    );
  }

  function withDeadline(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise((resolve) => {
        window.setTimeout(() => resolve(fallback), Math.max(0, ms));
      }),
    ]);
  }

  async function loadSignupsFast(ms = 900) {
    const fetchRemote = async () => {
      try {
        const merged = await refreshSignups?.();
        if (Array.isArray(merged)) return merged;
      } catch {
        // fall through
      }
      try {
        return await fetchSignups();
      } catch {
        return null;
      }
    };
    return withDeadline(fetchRemote(), ms, null);
  }

  /** Paid / bypassed accounts restore instantly; brand-new emails still must pay. */
  async function resolveReturningAccess(key, { waitMs = 900 } = {}) {
    const started = Date.now();
    const BUDGET_MS = Math.max(400, Number(waitMs) || 900);
    let current = getSignup(key);

    // Instant: this phone already paid / bypassed for this email.
    if (hasPaidOnThisDevice(key)) {
      void refreshSignups?.().catch(() => {});
      return {
        entitled: true,
        current: current || persistPaidLocally(key, null),
        owned: localLicensesForEmail(key).filter((row) => isLicenseBoundToThisDevice(row)),
      };
    }

    // Instant: local signup already shows paid / admin bypass / approved.
    if (isAccountPaidOrBypassed(current)) {
      rememberDeviceAccess(key, { paid: true, bypassed: true });
      void refreshSignups?.().catch(() => {});
      return {
        entitled: true,
        current: persistPaidLocally(key, current),
        owned: localLicensesForEmail(key),
      };
    }

    const localBound = localLicensesForEmail(key).filter((row) =>
      isLicenseBoundToThisDevice(row)
    );
    if (localBound.length) {
      rememberDeviceAccess(key, { paid: true, bypassed: true });
      void refreshSignups?.().catch(() => {});
      return {
        entitled: true,
        current: current || persistPaidLocally(key, null),
        owned: localBound,
      };
    }

    // Network (authoritative): POST upsert returns THIS email's paid/bypass flags
    // without depending on a full signups list sync (which can lag on Android).
    // Also pull any licenses already issued to this email.
    const remaining = () => Math.max(0, BUDGET_MS - (Date.now() - started));
    const [remoteSignup, owned, merged] = await Promise.all([
      withDeadline(
        submitSignup(key).catch(() => null),
        remaining(),
        null
      ),
      withDeadline(emailOwnsLicense(key), remaining(), []),
      withDeadline(loadSignupsFast(remaining()), remaining(), null),
    ]);

    if (remoteSignup) {
      ingestSignup?.(remoteSignup);
      current = remoteSignup;
    } else {
      current =
        (Array.isArray(merged)
          ? merged.find((s) => normalizeEmail(s.email) === key)
          : null) ||
        getSignup(key) ||
        current;
    }

    if (isAccountPaidOrBypassed(current)) {
      rememberDeviceAccess(key, { paid: true, bypassed: true });
      const paid = persistPaidLocally(key, current);
      ingestSignup?.(paid);
      return {
        entitled: true,
        current: paid,
        owned: Array.isArray(owned) ? owned : [],
      };
    }

    const remoteOwned = Array.isArray(owned) ? owned : [];
    const remoteBound = remoteOwned.filter((row) => isLicenseBoundToThisDevice(row));
    if (remoteBound.length) {
      rememberDeviceAccess(key, { paid: true, bypassed: true });
      const paid = persistPaidLocally(key, current);
      ingestSignup?.(paid);
      return {
        entitled: true,
        current: paid,
        owned: remoteBound,
      };
    }

    // Already issued a license for this email (paid/bypass before) → restore access.
    if (remoteOwned.length) {
      rememberDeviceAccess(key, { paid: true, bypassed: true });
      const paid = persistPaidLocally(key, current);
      ingestSignup?.(paid);
      return {
        entitled: true,
        current: paid,
        owned: remoteOwned,
      };
    }

    return { entitled: false, current };
  }

  async function submitEmail(event) {
    event.preventDefault();
    if (!email.trim() || !event.currentTarget.checkValidity()) {
      showToast("Enter a valid email");
      return;
    }
    const key = await requestSignup(email);
    if (!key) return;
    const { entitled, current } = await resolveReturningAccess(key, { waitMs: 6000 });
    if (entitled) {
      await grantAccessForEmail(key, current);
      return;
    }
    setLockStep("pending");
    showToast(
      current?.status === "declined"
        ? "Resubmitted — payment required for first-time access"
        : "Email saved — pay lifetime access to continue"
    );
  }

  async function checkPaidStatus() {
    const key = normalizeEmail(coverEmail || email);
    if (!key.includes("@")) {
      setLockStep("cover");
      showToast("Submit your email first");
      return;
    }
    if (checkingPaid) return;
    setCheckingPaid(true);
    try {
      // Explicit tap — wait for POST upsert + license lookup so bypassed/paid restore.
      const { entitled, current } = await resolveReturningAccess(key, { waitMs: 8000 });
      if (entitled) {
        await grantAccessForEmail(key, current);
        return;
      }

      if (!current) {
        setLockStep("cover");
        showToast("Submit your email first");
        return;
      }
      if (current.status === "declined") {
        setLockStep("pending");
        showToast("Still declined — change email or complete lifetime payment");
        return;
      }
      setLockStep("pending");
      showToast("No payment found yet — pay lifetime access of $35.60 to continue");
    } finally {
      setCheckingPaid(false);
    }
  }

  async function submitLicense(event) {
    event.preventDefault();
    const ok = await activateLicense(licenseKey, {
      license:
        claimedLicense &&
        String(claimedLicense.key || "").toUpperCase() ===
          String(licenseKey || "").trim().toUpperCase()
          ? claimedLicense
          : null,
    });
    if (ok) {
      setLicenseKey("");
      setClaimedKey("");
      setClaimedLicense(null);
      // Close the overlay after a successful add/activate.
      setLockStep("cover");
    }
  }

  function openLifetimePayStep() {
    const buyer = normalizeEmail(coverEmail || email || payEmailRef.current);
    if (!buyer.includes("@")) {
      showToast("Enter a valid email before paying");
      setLockStep("cover");
      return;
    }
    cardRenderedRef.current = false;
    setPaypalError("");
    setLockStep("pay");
  }

  async function submitInviteClaim(event) {
    event.preventDefault();
    if (!inviteMeta?.invite || !inviteMeta?.botId) {
      showToast("This invite link is missing the bot — ask your mentor for a new link");
      return;
    }
    if (inviteMeta.until && Date.now() > inviteMeta.until) {
      showToast("This free migrate link expired — ask your mentor for a new one");
      return;
    }
    const clientEmail = normalizeEmail(email);
    const clientName = String(inviteClientName || "").trim();
    if (!clientName || !clientEmail.includes("@")) {
      showToast("Enter your name and a valid email");
      return;
    }
    if (inviteBusy) return;
    setInviteBusy(true);
    try {
      // One link does both: payment bypass + license key claim.
      setCoverEmail?.(clientEmail);
      const result = await claimInviteLicenseRemote({
        inviteCode: inviteMeta.invite,
        botId: inviteMeta.botId,
        botName: inviteMeta.botName || "Bot",
        duration: inviteMeta.duration || "lifetime",
        clientName,
        clientEmail,
        photo: "/logo.png",
        migrate: true,
        until: inviteMeta.until || undefined,
        sig: inviteMeta.sig || undefined,
      });
      const key = String(result?.license?.key || "").trim();
      if (!key) {
        showToast("Could not create your license key");
        return;
      }
      rememberDeviceAccess(clientEmail, { paid: false, bypassed: true });
      ingestSignup?.({
        email: clientEmail,
        status: "approved",
        accessPaid: false,
        accessBypassed: true,
        accessBypassedAt: Date.now(),
        createdAt: Date.now(),
      });
      setClaimedKey(key);
      setClaimedLicense(result.license || null);
      setLicenseKey(key);
      setInviteMentorName(result.mentorName || inviteMentorName);
      clearInviteFromUrl();

      // Show the key with copy — do not auto-jump into the robot so clients
      // (e.g. Sam) can save the key somewhere safe before Unlock.
      setLockStep("license");
      showToast("License ready — copy your key, then tap Unlock app");
    } catch (error) {
      showToast(error.message || "Invite claim failed");
    } finally {
      setInviteBusy(false);
    }
  }

  return (
    <div className="app-lock">
      <div className="app-lock-glow" aria-hidden="true" />
      <div className="app-lock-content">
        <div className="app-lock-orb" onClick={onHotspotClick}>
          <img src="/logo.png" alt="ApexEA" width="96" height="96" />
        </div>

        {lockStep === "invite" && (
          <section className="cover-step is-active">
            <p className="app-lock-eyebrow">One invite · bypass + license</p>
            <h2 className="app-lock-title">
              {inviteMentorName
                ? `Join ${inviteMentorName} · free`
                : "Free migrate access"}
            </h2>
            <p className="app-lock-sub">
              This single link does both: <strong>bypasses the $35.60 email
              payment</strong> and <strong>gives you a license key</strong> for{" "}
              <strong>{inviteMeta?.botName || "bot"}</strong>. Enter your details
              once — new clients without this link still pay.
              {inviteMeta?.until ? (
                <>
                  {" "}
                  Link expires{" "}
                  <strong>
                    {new Date(inviteMeta.until).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </strong>
                  .
                </>
              ) : null}
            </p>
            <form className="app-lock-form" onSubmit={submitInviteClaim}>
              <label className="ea-field">
                <span>Your name</span>
                <input
                  className="admin-input"
                  value={inviteClientName}
                  onChange={(e) => setInviteClientName(e.target.value)}
                  placeholder="e.g. Sam Smith"
                  required
                />
              </label>
              <label className="ea-field">
                <span>Email</span>
                <input
                  className="admin-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <button
                className="admin-btn admin-btn-solid admin-btn-block"
                type="submit"
                disabled={inviteBusy || !inviteMeta?.botId}
              >
                {inviteBusy
                  ? "Unlocking…"
                  : "Bypass payment + get license key"}
              </button>
            </form>
            {!inviteMeta?.botId ? (
              <p className="ea-hint" style={{ marginTop: 10 }}>
                This invite is missing the bot. Ask your mentor to copy a fresh
                invite link from License Keys.
              </p>
            ) : (
              <p className="ea-hint" style={{ marginTop: 10 }}>
                No PayPal · no $35.60 · for migrating clients only.
              </p>
            )}
            <button
              className="cover-back"
              type="button"
              onClick={() => {
                clearInviteFromUrl();
                setInviteMeta(null);
                setLockStep("cover");
              }}
            >
              ← New client? Use normal unlock (payment required)
            </button>
          </section>
        )}

        {lockStep === "cover" && (
          <section className="cover-step is-active">
            <h2 className="app-lock-title cover-title">Unlock ApexEA</h2>
            <p className="app-lock-sub">
              Enter your email to continue. First-time users must pay lifetime
              access of <strong>$35.60</strong> before activating a license key.
            </p>
            <form className="app-lock-form" onSubmit={submitEmail}>
              <label className="ea-field">
                <span>Email</span>
                <input
                  className="admin-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <button className="admin-btn admin-btn-solid admin-btn-block" type="submit">
                Continue
              </button>
            </form>
          </section>
        )}

        {lockStep === "pay" && (
          <section className="cover-step is-active">
            <p className="app-lock-eyebrow">Lifetime access</p>
            <h2 className="app-lock-title">Pay for lifetime access</h2>
            <p className="app-lock-sub">
              Mandatory one-time payment of <strong>$35.60 USD</strong> for{" "}
              <strong>{coverEmail || email || "your email"}</strong>. Enter your
              debit or credit card below — you stay in the app.
            </p>
            <div className="paypal-panel">
              {paypalError ? (
                <p className="ea-hint" style={{ color: "#ffb4b4" }}>
                  {paypalError}
                </p>
              ) : null}
              {!cardReady && !paypalError ? (
                <p className="ea-hint" style={{ textAlign: "center" }}>
                  Loading checkout…
                </p>
              ) : null}
              <div
                className="paypal-buttons"
                ref={cardButtonsRef}
                aria-label="Pay for lifetime access with debit or credit card"
              />
              {paying ? (
                <p className="ea-hint" style={{ marginTop: 10, textAlign: "center" }}>
                  Confirming payment…
                </p>
              ) : (
                <p className="ea-hint" style={{ marginTop: 10, textAlign: "center" }}>
                  Tap the black card button and enter your card details. No PayPal
                  login required.
                </p>
              )}
            </div>
            <button
              className="admin-btn admin-btn-outline admin-btn-block"
              type="button"
              onClick={checkPaidStatus}
              disabled={checkingPaid || paying}
              style={{ marginTop: 12 }}
            >
              {checkingPaid ? "Checking…" : "I have paid"}
            </button>
            <p className="ea-hint" style={{ marginTop: 10, textAlign: "center" }}>
              Already paid or bypassed? Tap <strong>I have paid</strong> to restore
              access, then enter your license key.
            </p>
            <button
              className="cover-back"
              type="button"
              onClick={() => {
                cardRenderedRef.current = false;
                setLockStep("cover");
              }}
              disabled={paying}
            >
              ← Change email
            </button>
          </section>
        )}

        {lockStep === "pending" && (
          <section className="cover-step is-active">
            <p className="app-lock-eyebrow">
              {declined ? "Access declined" : "Lifetime access required"}
            </p>
            <h2 className="app-lock-title">
              {declined ? "Request declined" : "Pay to unlock"}
            </h2>
            <p className="app-lock-sub">
              {declined
                ? `${coverEmail || "Your account"} was declined by a super admin. Change email to request again, or complete lifetime payment if you already paid.`
                : `First-time users must pay lifetime access of $35.60 for ${coverEmail || "your account"}. This payment is mandatory before you can use the app.`}
            </p>
            <div className="pending-status-card">
              <span className={`admin-badge ${declined ? "is-declined" : "is-pending"}`}>
                {declined ? "Declined" : "Payment required"}
              </span>
              <strong>{coverEmail || "—"}</strong>
            </div>
            <button
              className="admin-btn admin-btn-solid admin-btn-block"
              type="button"
              onClick={() => openLifetimePayStep()}
            >
              Pay for lifetime access · $35.60
            </button>
            <button
              className="admin-btn admin-btn-outline admin-btn-block"
              type="button"
              onClick={checkPaidStatus}
              disabled={checkingPaid}
              style={{ marginTop: 10 }}
            >
              {checkingPaid ? "Checking…" : "I have paid"}
            </button>
            <p className="ea-hint" style={{ marginTop: 12, textAlign: "center" }}>
              Already paid or bypassed? Tap <strong>I have paid</strong> to restore
              access, then enter your license key.
            </p>
            <button
              className="cover-back"
              type="button"
              onClick={() => setLockStep("cover")}
            >
              ← Change email
            </button>
          </section>
        )}

        {lockStep === "license" && (
          <section className="cover-step is-active">
            <p className="app-lock-eyebrow">ApexEA</p>
            <h2 className="app-lock-title">
              {addingBot ? "Add another trading bot" : "Activate license key"}
            </h2>
            <p className="app-lock-sub">
              {addingBot
                ? "Enter a new license key to add another robot. Your current bots stay on the home screen."
                : claimedKey
                  ? "Copy your license key and save it somewhere safe, then tap Unlock app."
                  : coverEmail
                    ? `Approved · ${coverEmail}. Enter your license key to unlock — type it again after reinstall.`
                    : "Enter your license key to unlock the app."}
            </p>
            {claimedKey ? (
              <div className="claimed-key-box">
                <p className="claimed-key-value">{claimedKey}</p>
                <button
                  type="button"
                  className="admin-btn admin-btn-block claimed-key-copy"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(claimedKey);
                      showToast("License key copied — save it somewhere safe");
                    } catch {
                      showToast(claimedKey);
                    }
                  }}
                >
                  Copy license key
                </button>
              </div>
            ) : null}
            <form className="app-lock-form" onSubmit={submitLicense}>
              <label className="ea-field">
                <span>License key</span>
                <input
                  className="admin-input"
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  placeholder="APEX-XXXX-XXXX"
                  autoCapitalize="characters"
                  required
                />
              </label>
              <button className="admin-btn admin-btn-solid admin-btn-block" type="submit">
                {addingBot ? "Add trading bot" : "Unlock app"}
              </button>
            </form>
            <button
              className="cover-back"
              type="button"
              onClick={() => setLockStep("cover")}
            >
              {addingBot ? "← Cancel" : "← Change email"}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
