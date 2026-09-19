import { useEffect, useMemo, useRef, useState } from "react";
import EnginePanel from "./EnginePanel.jsx";
import { CONNECT_ENGINE_STEPS, sleep } from "./chartScanner.js";
import { brokerInitials, resolveBrokerLogoCandidates } from "./brokerLogos.js";
import { connectAccount, disconnectAccount, getAccountStatus, searchBrokers, checkBrokerApiHealth } from "./metaApi.js";
import { removeMt5Account, upsertMt5Account } from "./mt5AccountsApi.js";
import { useApp } from "./store.jsx";

const emptyLogin = { login: "", password: "", server: "" };

function BrokerLogo({ broker }) {
  const candidates = useMemo(() => resolveBrokerLogoCandidates(broker), [broker]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [candidates]);
  const src = candidates[index] || "";
  const initials = brokerInitials(broker?.company || broker?.name || "?");

  if (!src) {
    return (
      <span className="mt-broker-logo is-fallback" aria-hidden="true">
        {initials}
      </span>
    );
  }

  return (
    <img
      className="mt-broker-logo"
      src={src}
      alt=""
      width="32"
      height="32"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        setIndex((v) => v + 1);
      }}
    />
  );
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function formatMoney(value, currency = "USD") {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const code = String(currency || "USD").trim().toUpperCase() || "USD";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    const sign = amount < 0 ? "-" : "";
    return `${sign}${code} ${Math.abs(amount).toFixed(2)}`;
  }
}

export default function MetaTraderPanel({ variant = "zeta" }) {
  const {
    showToast,
    mt5Session,
    setMt5Session,
    coverEmail,
    engineMode,
    setEngineMode,
    engineStep,
    setEngineStep,
    engineLogs,
    setEngineLogs,
    pushEngineLog,
  } = useApp();
  const [platform, setPlatform] = useState("MT5");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [selectedBroker, setSelectedBroker] = useState(null);
  const [step, setStep] = useState("browse");
  const [creds, setCreds] = useState(emptyLogin);
  const [connecting, setConnecting] = useState(false);
  const [accountMetrics, setAccountMetrics] = useState(null);
  const [apiHealth, setApiHealth] = useState(null);
  const [apiChecking, setApiChecking] = useState(true);
  const searchRef = useRef(0);

  const hasQuery = query.trim().length > 0;
  const session = mt5Session;
  const apiOnline = apiHealth?.online === true;
  const apiOffline = apiHealth?.online === false;

  async function syncHostedAccount(sessionRow, email = coverEmail) {
    const accountEmail = normalizeEmail(email);
    const accountId = String(sessionRow?.accountId || "").trim();
    if (!accountEmail || !accountEmail.includes("@") || !accountId) return;
    try {
      await upsertMt5Account({
        email: accountEmail,
        accountId,
        login: sessionRow.login || "",
        server: sessionRow.server || "",
        company: sessionRow.company || "",
        platform: sessionRow.platform || "MT5",
        region: sessionRow.region || "",
        connectedAt: sessionRow.connectedAt || Date.now(),
      });
    } catch {
      // Hosting registry is best-effort; local session still works for scanner.
    }
  }

  useEffect(() => {
    if (!session?.accountId) return;
    void syncHostedAccount(session, coverEmail);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync when session or cover email changes
  }, [session?.accountId, coverEmail]);

  // Keep MT5API session warm and re-register for mentor Self Hosting.
  useEffect(() => {
    if (!session?.accountId) return undefined;
    let cancelled = false;
    async function heartbeat() {
      // While the broker network is offline, keep the local session armed.
      if (apiHealth?.online === false) return;
      try {
        const status = await getAccountStatus(session.accountId, {
          company: session.company || "",
        });
        if (cancelled) return;
        if (status?.transient) return;
        const disconnected =
          status?.disconnected === true ||
          String(status?.connectionStatus || "").toUpperCase().includes("DISCONNECT") ||
          String(status?.state || "").toUpperCase() === "UNDEPLOYED";
        if (disconnected) {
          showToast("Broker session expired — reconnect MetaTrader");
          setMt5Session(null);
          const accountEmail = normalizeEmail(coverEmail);
          if (accountEmail) {
            try {
              await removeMt5Account(accountEmail);
            } catch {
              /* best-effort */
            }
          }
          return;
        }
        await syncHostedAccount(session, coverEmail);
      } catch {
        // ignore transient heartbeat failures — keep local session
      }
    }
    void heartbeat();
    const timer = setInterval(() => void heartbeat(), 45000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- heartbeat tied to live session
  }, [session?.accountId, session?.company, coverEmail, apiHealth?.online]);

  // Broker API on/off — poll so clients see when 159.203.191.196 is down.
  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function check(showSpinner = false) {
      if (showSpinner) setApiChecking(true);
      try {
        const health = await checkBrokerApiHealth();
        if (cancelled) return;
        setApiHealth(health);
      } catch {
        if (cancelled) return;
        setApiHealth({
          online: false,
          status: "offline",
          checkedAt: Date.now(),
          message:
            "Broker connection service is temporarily unavailable. This is not your login — the network is offline. Your account stays connected; please wait a few minutes and try again.",
        });
      } finally {
        if (!cancelled) setApiChecking(false);
      }
    }

    void check(true);
    timer = setInterval(() => void check(false), 20000);
    const onVisible = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void check(false);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Keep connected session fresh and pull live balance.
  useEffect(() => {
    if (!session?.accountId) {
      setAccountMetrics(null);
      return undefined;
    }
    let cancelled = false;

    async function reconcile() {
      // API offline → keep session; metrics stay as last known / dashes.
      if (apiHealth?.online === false) return;
      try {
        const status = await getAccountStatus(session.accountId, {
          company: session.company || "",
        });
        if (cancelled) return;
        if (status?.transient) return;
        const state = String(status?.state || "").toUpperCase();
        const connection = String(status?.connectionStatus || "").toUpperCase();
        if (
          status?.disconnected === true ||
          state === "UNDEPLOYED" ||
          connection.includes("DISCONNECTED")
        ) {
          setMt5Session(null);
          setAccountMetrics(null);
          const accountEmail = normalizeEmail(coverEmail);
          if (accountEmail) {
            try {
              await removeMt5Account(accountEmail);
            } catch {
              // ignore
            }
          }
          showToast("MetaTrader session ended");
          return;
        }
        if (
          status &&
          (status.balance != null || status.profit != null || status.equity != null)
        ) {
          const balance = status.balance;
          const equity = status.equity;
          let profit = status.profit;
          const balN = Number(balance);
          const eqN = Number(equity);
          // Client-side safety: floating P/L = equity − balance (matches MT5).
          if (Number.isFinite(balN) && Number.isFinite(eqN)) {
            profit = Number((eqN - balN).toFixed(8));
          }
          setAccountMetrics({
            balance,
            equity,
            profit,
            currency: status.currency || "USD",
          });
        }
      } catch {
        // keep local session if status check fails transiently
      }
    }

    void reconcile();
    const timer = setInterval(() => {
      void reconcile();
    }, 12000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when account / network changes
  }, [session?.accountId, apiHealth?.online]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearchError("");
      setSearching(false);
      return undefined;
    }

    const requestId = ++searchRef.current;
    const controller = new AbortController();
    setSearching(true);
    setSearchError("");

    const timer = setTimeout(async () => {
      try {
        const brokers = await searchBrokers(q, platform, { signal: controller.signal });
        if (requestId !== searchRef.current) return;
        setResults(brokers);
        if (!brokers.length) setSearchError("No brokers match that search.");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (requestId !== searchRef.current) return;
        setResults([]);
        setSearchError(error.message || "Broker search failed");
      } finally {
        if (requestId === searchRef.current) setSearching(false);
      }
    }, 350);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, platform]);

  const customBroker = useMemo(() => {
    if (!hasQuery) return null;
    const exact = results.some(
      (broker) => broker.name.toLowerCase() === query.trim().toLowerCase()
    );
    if (exact) return null;
    return {
      id: `custom-${query.trim().toLowerCase()}`,
      company: query.trim(),
      name: query.trim(),
      site: "",
      logoUrl: "",
      access: [],
      platform,
      custom: true,
    };
  }, [hasQuery, query, results, platform]);

  function pickBroker(broker) {
    setSelectedBroker(broker);
    const server =
      broker.local || broker.custom ? "" : String(broker.name || "").trim();
    setCreds({
      login: "",
      password: "",
      server,
    });
    setStep("login");
  }

  function backToBrokers() {
    setStep("browse");
    setCreds(emptyLogin);
    setConnecting(false);
    if (engineMode === "connecting") setEngineMode("idle");
  }

  function updateCred(field, value) {
    setCreds((prev) => ({ ...prev, [field]: value }));
  }

  async function onConnect(event) {
    event.preventDefault();
    const login = creds.login.trim();
    const password = creds.password;
    const server = creds.server.trim();

    if (!login || !password || !server) {
      showToast("Enter login, password, and server");
      return;
    }

    if (apiOffline) {
      showToast(
        apiHealth?.message ||
          "Network is offline right now — please wait and try again"
      );
      return;
    }

    setConnecting(true);
    setEngineLogs([]);
    setEngineMode("connecting");
    setEngineStep(0);
    pushEngineLog(CONNECT_ENGINE_STEPS[0].label);

    const advance = async (index) => {
      setEngineStep(index);
      pushEngineLog(CONNECT_ENGINE_STEPS[index].label);
      await sleep(380);
    };

    try {
      await advance(0);
      await advance(1);
      // Do not send client email on connect — MetaAPI allows max 3 account keywords
      // and email tag would exceed the limit on some deployments. Email is registered
      // after connect via syncHostedAccount (mt5-accounts registry).
      const connected = await connectAccount({
        login,
        password,
        server,
        platform,
        company: selectedBroker?.company || "",
        onProgress: async () => {
          setEngineStep((prev) => Math.min(2, Math.max(1, prev)));
        },
      });
      await advance(2);
      await advance(3);

      const nextSession = {
        accountId: connected.accountId,
        login: connected.login,
        server: connected.server,
        company: connected.company || selectedBroker?.company || server,
        platform: connected.platform || platform,
        connectionStatus: connected.connectionStatus,
        subscribed: connected.subscribed,
        strategyId: connected.strategyId,
        subscriptionError: connected.subscriptionError,
        region: connected.region || null,
        connectedAt: Date.now(),
      };
      setMt5Session(nextSession);
      await syncHostedAccount(nextSession, coverEmail);
      pushEngineLog("Trading engine armed · MT5 connected");
      showToast(`Connected ${nextSession.company}`);
      setStep("browse");
      setQuery("");
      setResults([]);
      setCreds(emptyLogin);
      await sleep(700);
      setEngineMode("idle");
    } catch (error) {
      setEngineMode("idle");
      showToast(error.message || "Connection failed");
    } finally {
      setConnecting(false);
    }
  }

  async function clearSession() {
    const accountId = session?.accountId;
    const accountEmail = normalizeEmail(coverEmail);
    setMt5Session(null);
    setAccountMetrics(null);
    if (accountId) {
      try {
        await disconnectAccount(accountId, { email: accountEmail });
      } catch {
        // local disconnect still ok
      }
    }
    if (accountEmail) {
      try {
        await removeMt5Account(accountEmail);
      } catch {
        // registry cleanup is best-effort
      }
    }
    showToast("Disconnected MetaTrader session");
  }

  const rootClass = variant === "v2" ? "mt-panel mt-panel--v2" : "mt-panel";

  if (connecting || engineMode === "connecting") {
    return (
      <div className={rootClass}>
        <EnginePanel
          mode="connecting"
          stepIndex={engineStep}
          logs={engineLogs}
          subtitle={`${selectedBroker?.company || "Broker"} · ${creds.server || "server"}`}
        />
      </div>
    );
  }

  if (step === "login" && selectedBroker) {
    return (
      <div className={rootClass}>
        <header className="mt-panel-head">
          <button className="mt-back-btn" type="button" onClick={backToBrokers}>
            ← Brokers
          </button>
          <p className="mt-panel-kicker">{platform}</p>
          <h2 className="mt-panel-title">{selectedBroker.company}</h2>
          <p className="mt-panel-sub">
            {selectedBroker.custom
              ? "Enter your MetaTrader account details to connect."
              : `Server ${selectedBroker.name}. Enter login details to connect.`}
          </p>
        </header>

        <form className="mt-login-form" onSubmit={onConnect}>
          <label className="mt-field">
            <span>Login</span>
            <input
              className="mt-search-input"
              type="text"
              inputMode="numeric"
              autoComplete="username"
              placeholder="Enter login"
              value={creds.login}
              onChange={(e) => updateCred("login", e.target.value)}
              required
            />
          </label>

          <label className="mt-field">
            <span>Password</span>
            <input
              className="mt-search-input"
              type="password"
              autoComplete="current-password"
              placeholder="Enter password"
              value={creds.password}
              onChange={(e) => updateCred("password", e.target.value)}
              required
            />
          </label>

          <label className="mt-field">
            <span>Server</span>
            <input
              className="mt-search-input"
              type="text"
              autoComplete="off"
              placeholder="Exact MT server name (from MT5)"
              value={creds.server}
              onChange={(e) => updateCred("server", e.target.value)}
              required
            />
          </label>

          <button
            className="mt-connect-btn"
            type="submit"
            disabled={connecting || apiOffline}
          >
            {connecting
              ? "Starting connecting engine…"
              : apiOffline
                ? "API offline — try later"
                : "Connect"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={rootClass}>
      <header className="mt-panel-head">
        <p className="mt-panel-kicker">MetaTrader</p>
        <h2 className="mt-panel-title">Brokers</h2>
        <p className="mt-panel-sub">
          Search brokers, connect MT5, then arm the ApexEA trading engine.
        </p>
      </header>

      <div
        className={`mt-api-status${apiOnline ? " is-on" : ""}${apiOffline ? " is-off" : ""}${apiChecking && !apiHealth ? " is-checking" : ""}`}
        role="status"
        aria-live="polite"
      >
        <div className="mt-api-status-row">
          <button
            type="button"
            className="mt-api-status-btn"
            onClick={() => {
              setApiChecking(true);
              void checkBrokerApiHealth()
                .then((health) => setApiHealth(health))
                .catch(() =>
                  setApiHealth({
                    online: false,
                    status: "offline",
                    checkedAt: Date.now(),
                    message:
                      "Broker connection service is temporarily unavailable. Please wait a few minutes and try again.",
                  })
                )
                .finally(() => setApiChecking(false));
            }}
            aria-pressed={apiOnline}
          >
            <span className="mt-api-status-dot" aria-hidden="true" />
            <span className="mt-api-status-label">
              {apiChecking && !apiHealth
                ? "Checking network…"
                : apiOnline
                  ? "Network On"
                  : "Network Off"}
            </span>
          </button>
          <span className="mt-api-status-hint">
            {apiOnline ? "Broker service ready" : "Service issue"}
          </span>
        </div>
        {apiOffline ? (
          <p className="mt-api-status-msg">
            {apiHealth?.message ||
              "Broker connection service is temporarily unavailable. This is not your login — the network is offline. Your account stays connected; wait a few minutes and try again."}
          </p>
        ) : null}
      </div>

      {session?.accountId ? (
        <div className="mt-session">
          <div className="mt-session-body">
            <div className="mt-session-row">
              <div className="mt-session-copy">
                <strong>{session.company || session.server}</strong>
                <span>
                  {session.server} · login {session.login}
                  {session.subscribed ? " · copying" : ""} · engine armed
                </span>
              </div>
              <button type="button" className="mt-session-btn" onClick={clearSession}>
                Disconnect
              </button>
            </div>
            <div className="mt-session-metrics" aria-label="Account balance">
              <div className="mt-metric">
                <span className="mt-metric-label">Balance</span>
                <strong className="mt-metric-value">
                  {formatMoney(accountMetrics?.balance, accountMetrics?.currency)}
                </strong>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-platform-row" role="group" aria-label="MetaTrader platform">
        {["MT5", "MT4"].map((id) => (
          <button
            key={id}
            type="button"
            className={`mt-platform-btn${platform === id ? " is-active" : ""}`}
            onClick={() => setPlatform(id)}
            aria-pressed={platform === id}
          >
            <span className="mt-platform-label">{id}</span>
            <span className="mt-platform-hint">
              {id === "MT5" ? "MetaTrader 5" : "MetaTrader 4"}
            </span>
          </button>
        ))}
      </div>

      <section className="mt-find" aria-label="Find broker">
        <h3 className="mt-find-title">Find broker</h3>
        <label className="mt-search">
          <span className="sr-only">Search for your broker</span>
          <input
            className="mt-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              apiOffline ? "Network offline — try again soon" : "Search for your broker"
            }
            autoComplete="off"
            inputMode="search"
            disabled={apiOffline}
          />
        </label>

        <ul className="mt-broker-list">
          {!hasQuery ? (
            <li className="mt-broker-empty">Search for your broker</li>
          ) : searching ? (
            <li className="mt-broker-empty">Searching brokers…</li>
          ) : (
            <>
              {results.map((broker) => (
                <li key={broker.id}>
                  <button
                    type="button"
                    className="mt-broker-item"
                    onClick={() => pickBroker(broker)}
                  >
                    <span className="mt-broker-main">
                      <BrokerLogo broker={broker} />
                      <span className="mt-broker-text">
                        <span className="mt-broker-name">{broker.company}</span>
                        <span className="mt-broker-server">{broker.name}</span>
                      </span>
                    </span>
                    <span className="mt-broker-meta">{platform}</span>
                  </button>
                </li>
              ))}
              {customBroker ? (
                <li key={customBroker.id}>
                  <button
                    type="button"
                    className="mt-broker-item"
                    onClick={() => pickBroker(customBroker)}
                  >
                    <span className="mt-broker-main">
                      <BrokerLogo broker={customBroker} />
                      <span className="mt-broker-text">
                        <span className="mt-broker-name">Use “{customBroker.name}”</span>
                      </span>
                    </span>
                    <span className="mt-broker-meta">{platform}</span>
                  </button>
                </li>
              ) : null}
              {!results.length && searchError ? (
                <li className="mt-broker-empty">{searchError}</li>
              ) : null}
            </>
          )}
        </ul>
      </section>
    </div>
  );
}
