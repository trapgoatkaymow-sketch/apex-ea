import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCorsHeaders } from "../_cors.js";

/** Self-hosted MT5API RESTful — http://159.203.191.196/swagger/index.html */
export const MT5_API_BASE = (
  process.env.MT5_API_BASE ||
  process.env.MT5_API_TARGET ||
  "http://159.203.191.196"
).replace(/\/$/, "");

let brokerLogoCatalogCache = null;

function getBrokerLogoCatalog() {
  if (brokerLogoCatalogCache) return brokerLogoCatalogCache;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(
      join(here, "../../data/broker-logo-catalog.json"),
      "utf8"
    );
    brokerLogoCatalogCache = JSON.parse(raw);
  } catch {
    brokerLogoCatalogCache = { byServer: {}, byCompanyServer: {} };
  }
  return brokerLogoCatalogCache;
}

/** Attach official logo/site when the live MT5REST Search omits them. */
function enrichBrokerLogo(broker) {
  if (!broker) return broker;
  if (broker.logoUrl && broker.site) return broker;
  const catalog = getBrokerLogoCatalog();
  const serverKey = String(broker.name || "")
    .trim()
    .toLowerCase();
  const companyKey = String(broker.company || "")
    .trim()
    .toLowerCase();
  const row =
    (companyKey &&
      serverKey &&
      catalog.byCompanyServer?.[`${companyKey}::${serverKey}`]) ||
    catalog.byServer?.[serverKey] ||
    null;
  if (!row) return broker;
  return {
    ...broker,
    logoUrl: broker.logoUrl || String(row.logoUrl || "").trim(),
    site: broker.site || String(row.site || "").trim(),
  };
}

export function sendJson(res, status, payload) {
  applyCorsHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

/** MT5REST often returns ExceptionResult with HTTP 201 (still "ok" for fetch). */
function isMt5ExceptionResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const code = String(data.code || "").trim();
  if (!code) return false;
  // Real account payloads have balance/equity/currency — exceptions do not.
  if (
    data.balance != null ||
    data.equity != null ||
    data.currency ||
    data.login != null ||
    data.accountNumber != null
  ) {
    return false;
  }
  return data.message != null || data.stackTrace != null || Boolean(code);
}

async function mt5Fetch(path, { method = "GET", signal, timeoutMs = 45000 } = {}) {
  const url = `${MT5_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method,
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Connect returns a bare token string (often quoted).
      data = String(text || "").trim().replace(/^"|"$/g, "");
    }
    // New bridge: errors are often HTTP 201 + { code, message }.
    if (!response.ok || isMt5ExceptionResult(data) || (response.status === 201 && data?.code)) {
      const message =
        (typeof data === "string" && data) ||
        data?.message ||
        data?.title ||
        data?.error ||
        data?.code ||
        `MT5 API error ${response.status}`;
      const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
      err.status =
        response.status >= 400 && response.status < 600
          ? response.status
          : isMt5ExceptionResult(data) || response.status === 201
            ? 400
            : 502;
      err.code = data?.code || "";
      err.data = data;
      throw err;
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      const err = new Error("Broker API timed out — try again");
      err.status = 504;
      throw err;
    }
    if (error?.status) throw error;
    const err = new Error(error?.message || "Broker API unreachable");
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull AccountSummary, retrying briefly until broker snapshot is synced. */
async function fetchAccountSummary(accountId, { timeoutMs = 15000, tries = 8 } = {}) {
  const id = String(accountId || "").trim();
  if (!id) return null;
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      last = await mt5Fetch(`/AccountSummary?id=${encodeURIComponent(id)}`, {
        timeoutMs,
      });
      if (last && typeof last === "object") {
        if (last.synced === true) return last;
        if (
          last.synced !== false &&
          (last.currency ||
            Number.isFinite(Number(last.balance)) ||
            Number.isFinite(Number(last.equity)))
        ) {
          // Usable snapshot even if synced flag is missing on older hosts.
          if (i >= 2 || last.currency) return last;
        }
      }
    } catch {
      last = null;
    }
    await sleep(400);
  }
  return last;
}

/** Lightweight health check — MT5API GET /Ping returns "OK" when online. */
export async function pingBrokerApi() {
  const started = Date.now();
  try {
    const data = await mt5Fetch("/Ping", { timeoutMs: 4000 });
    const raw = typeof data === "string" ? data.trim() : String(data ?? "");
    const online = /^ok$/i.test(raw) || raw.length > 0;
    return {
      online,
      status: online ? "online" : "offline",
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      message: online
        ? "Network is online — you can search and connect."
        : "Network is offline right now. Please wait and try again shortly.",
    };
  } catch (error) {
    return {
      online: false,
      status: "offline",
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      message:
        "Broker connection service is temporarily unavailable. This is not your login — the network is offline. Please wait a few minutes and try again.",
      error: error?.message || "unreachable",
    };
  }
}

/**
 * Brokers clients must not pick — broken / wrong catalog entries.
 * "Razor Markets (Pty) Ltd" (RazorMarkets-Live) fails for clients; keep "Razor Markets".
 */
const BLOCKED_BROKER_COMPANIES = [
  /^razor\s*markets\s*\(pty\)\s*ltd\.?$/i,
];

export function isBlockedBroker(broker) {
  const company = String(broker?.company || "").trim();
  if (!company) return false;
  return BLOCKED_BROKER_COMPANIES.some((re) => re.test(company));
}

/** Map Swagger Company[] → UI broker rows. */
export function mapSearchResults(data, platform = "MT5") {
  if (!Array.isArray(data)) return [];
  const plat = String(platform || "MT5").toUpperCase() === "MT4" ? "MT4" : "MT5";
  const brokers = [];
  data.forEach((companyEntry) => {
    // New MT5REST uses companyName; older hosts used company.
    const companyName =
      String(companyEntry?.company || companyEntry?.companyName || "").trim() ||
      "Unknown broker";
    if (isBlockedBroker({ company: companyName })) return;
    const results = Array.isArray(companyEntry?.results) ? companyEntry.results : [];
    results.forEach((result, index) => {
      const serverName =
        String(result?.name || "").trim() || `${companyName} server`;
      const access = Array.isArray(result?.access)
        ? result.access.map(String).map((v) => v.trim()).filter(Boolean)
        : [];
      brokers.push(
        enrichBrokerLogo({
          id: `${companyName}::${serverName}::${index}`,
          company: companyName,
          name: serverName,
          site: String(result?.site || "").trim(),
          logoUrl: String(result?.logo_url || result?.logoUrl || "").trim(),
          access,
          platform: plat,
          custom: false,
          source: "mt5api",
        })
      );
    });
  });
  return brokers.filter((b) => !isBlockedBroker(b));
}

/** GET /Search?company=… — broker catalog only (no MetaAPI). */
export async function searchBrokers(query, platform = "MT5") {
  const q = String(query || "").trim();
  if (!q) return [];
  const data = await mt5Fetch(`/Search?company=${encodeURIComponent(q)}`, {
    timeoutMs: 20000,
  });
  return mapSearchResults(data, platform);
}

function pickNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickCurrency(...values) {
  for (const value of values) {
    const code = String(value || "")
      .trim()
      .toUpperCase();
    if (code && /^[A-Z]{3}$/.test(code)) return code;
  }
  return "";
}

function sessionFromConnect({
  token,
  login,
  server,
  platform = "MT5",
  company = "",
  summary = null,
  details = null,
  account = null,
}) {
  const id = String(token || "").trim();
  const balance = pickNumber(
    summary?.balance,
    summary?.Balance,
    account?.balance,
    details?.balance
  );
  const equity = pickNumber(
    summary?.equity,
    summary?.Equity,
    account?.equity,
    details?.equity
  );
  const profit = pickNumber(
    summary?.profit,
    summary?.Profit,
    Number.isFinite(balance) && Number.isFinite(equity) ? equity - balance : null
  );
  const currency = pickCurrency(
    summary?.currency,
    summary?.Currency,
    account?.currency,
    details?.currency,
    details?.Currency
  );
  return {
    accountId: id,
    provider: "mt5api",
    login: String(login || details?.accountNumber || details?.login || account?.login || "").trim(),
    server: String(server || details?.serverName || "").trim(),
    platform: String(platform || "MT5").toUpperCase() === "MT4" ? "MT4" : "MT5",
    company: String(company || details?.company || "").trim(),
    region: "",
    state: "DEPLOYED",
    connectionStatus: "CONNECTED",
    pending: false,
    connectedAt: Date.now(),
    // Empty until broker reports currency — never invent USD/$ for ZAR accounts.
    currency,
    balance,
    equity,
    profit,
    leverage: summary?.leverage ?? details?.leverage ?? account?.leverage ?? null,
    synced: summary?.synced === true,
  };
}

/**
 * Connect via GET /ConnectEx?user&password&server
 * Returns a session shaped like the old MetaAPI payload (accountId = MT5 token).
 */
export async function connectAccount({
  login,
  password,
  server,
  platform = "MT5",
  company = "",
} = {}) {
  const userLogin = String(login || "").trim();
  const userPassword = String(password || "");
  const userServer = String(server || "").trim();
  if (!userLogin || !userPassword || !userServer) {
    const err = new Error("Enter login, password, and server");
    err.status = 400;
    throw err;
  }

  const params = new URLSearchParams({
    user: userLogin,
    password: userPassword,
    server: userServer,
  });

  let token;
  try {
    token = await mt5Fetch(`/ConnectEx?${params.toString()}`, { timeoutMs: 60000 });
  } catch (error) {
    const msg = String(error?.message || "");
    if (/password|login|invalid|auth|credential|reject/i.test(msg)) {
      const err = new Error("Broker rejected the login credentials");
      err.status = 400;
      err.data = error.data;
      throw err;
    }
    throw error;
  }

  // Token may be a bare string or { id / token } object depending on host build.
  let id = "";
  if (typeof token === "string") {
    id = token.trim().replace(/^"|"$/g, "");
  } else if (token && typeof token === "object") {
    id = String(token.id || token.token || token.accountId || "").trim();
  } else {
    id = String(token || "").trim();
  }

  // MT5API often returns HTTP 200 with bodies like "[error]:INVALID_ACCOUNT".
  if (!id || /^\[error\]/i.test(id) || /^error[:\s]/i.test(id) || id === "[object Object]") {
    const hint = id.replace(/^\[error\]:?\s*/i, "").trim() || "INVALID_ACCOUNT";
    const friendly =
      /invalid_account|invalid_password|password|login|auth/i.test(hint)
        ? "Broker rejected the login credentials"
        : `Broker connection failed (${hint})`;
    const err = new Error(friendly);
    err.status = 400;
    err.data = { raw: token };
    throw err;
  }

  let summary = null;
  let details = null;
  let account = null;
  try {
    summary = await fetchAccountSummary(id, { timeoutMs: 20000, tries: 10 });
  } catch {
    summary = null;
  }
  try {
    details = await mt5Fetch(`/AccountDetails?id=${encodeURIComponent(id)}`, {
      timeoutMs: 20000,
    });
  } catch {
    details = null;
  }
  try {
    account = await mt5Fetch(`/Account?id=${encodeURIComponent(id)}`, {
      timeoutMs: 20000,
    });
  } catch {
    account = null;
  }

  return sessionFromConnect({
    token: id,
    login: userLogin,
    server: userServer,
    platform,
    company,
    summary,
    details,
    account,
  });
}

export async function getAccountStatus(accountId, { company = "" } = {}) {
  const id = String(accountId || "").trim();
  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }

  const dead = {
    accountId: id,
    provider: "mt5api",
    company: company || "",
    state: "UNDEPLOYED",
    connectionStatus: "DISCONNECTED",
    disconnected: true,
    pending: false,
    balance: null,
    equity: null,
    profit: null,
    currency: "",
  };

  // When the broker host is unreachable, do NOT mark the account disconnected —
  // clients must keep their local session until the API recovers.
  const transient = {
    accountId: id,
    provider: "mt5api",
    company: company || "",
    state: "DEPLOYED",
    connectionStatus: "UNKNOWN",
    disconnected: false,
    transient: true,
    pending: true,
    balance: null,
    equity: null,
    profit: null,
    currency: "",
  };

  try {
    const live = await mt5Fetch(`/CheckConnect?id=${encodeURIComponent(id)}`, {
      timeoutMs: 15000,
    });
    const raw =
      typeof live === "string"
        ? live.trim()
        : live == null
          ? ""
          : typeof live === "object"
            ? JSON.stringify(live)
            : String(live);
    const ok =
      live === true ||
      /^ok$/i.test(raw) ||
      /^true$/i.test(raw) ||
      (typeof live === "object" &&
        live &&
        !/^\[error\]/i.test(raw) &&
        live.connected !== false &&
        live.ok !== false &&
        !live.code);
    if (!ok || /^\[error\]/i.test(raw) || live === false || raw === "false") {
      // Broker host flaky / gateway errors — keep the session sticky.
      if (
        /timeout|unreachable|network|econn|temporar|offline|502|503|504|gateway/i.test(
          raw
        )
      ) {
        return transient;
      }
      return dead;
    }
  } catch (error) {
    const msg = String(error?.message || error?.code || "");
    if (/INVALID_TOKEN|not found|CLIENT|session/i.test(msg)) return dead;
    return transient;
  }

  let summary = null;
  let details = null;
  let account = null;
  try {
    summary = await fetchAccountSummary(id, { timeoutMs: 15000, tries: 6 });
  } catch {
    summary = null;
  }
  try {
    details = await mt5Fetch(`/AccountDetails?id=${encodeURIComponent(id)}`, {
      timeoutMs: 15000,
    });
  } catch {
    details = null;
  }
  try {
    account = await mt5Fetch(`/Account?id=${encodeURIComponent(id)}`, {
      timeoutMs: 15000,
    });
  } catch {
    account = null;
  }

  return sessionFromConnect({
    token: id,
    login: details?.accountNumber || details?.login || account?.login || "",
    server: details?.serverName || "",
    platform: "MT5",
    company: company || details?.company || "",
    summary,
    details,
    account,
  });
}

export async function disconnectAccount(accountId) {
  const id = String(accountId || "").trim();
  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }
  try {
    await mt5Fetch(`/Disconnect?id=${encodeURIComponent(id)}`, { timeoutMs: 15000 });
  } catch {
    // Best-effort — client still clears local session.
  }
  return {
    accountId: id,
    provider: "mt5api",
    state: "UNDEPLOYED",
    connectionStatus: "DISCONNECTED",
    disconnected: true,
  };
}

/**
 * Market order via GET /OrderSend
 * operation: Buy | Sell
 * Optional `count` opens multiple market orders (same size each).
 * Optional `takeProfits` maps thread 1→TP1, 2→TP2, 3+→TP3.
 */
export async function placeMarketTrade({
  accountId,
  symbol,
  volume = 0.01,
  side = "BUY",
  stopLoss,
  takeProfit,
  takeProfits,
  comment = "bot~APEXEA",
  count = 1,
} = {}) {
  const id = String(accountId || "").trim();
  const requested = String(symbol || "").trim().toUpperCase();
  const lots = Number(volume);
  const action = String(side || "BUY").trim().toUpperCase() === "SELL" ? "Sell" : "Buy";
  const times = Math.max(1, Math.min(20, Math.floor(Number(count) || 1)));

  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }
  if (!requested) {
    const err = new Error("Symbol is required");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(lots) || lots <= 0) {
    const err = new Error("Lot size must be greater than 0");
    err.status = 400;
    throw err;
  }

  // Ensure the MT5API session is still alive before trading.
  try {
    const live = await mt5Fetch(`/CheckConnect?id=${encodeURIComponent(id)}`, {
      timeoutMs: 12000,
    });
    const raw =
      typeof live === "string"
        ? live.trim()
        : live == null
          ? ""
          : typeof live === "object"
            ? JSON.stringify(live)
            : String(live);
    const ok =
      live === true ||
      live == null ||
      /^ok$/i.test(raw) ||
      /^true$/i.test(raw) ||
      (typeof live === "object" &&
        live &&
        !/^\[error\]/i.test(raw) &&
        live.connected !== false &&
        live.ok !== false);
    if (
      !ok ||
      /^\[error\]/i.test(raw) ||
      live === false ||
      /not\s*found|not\s*connect|disconnect|invalid/i.test(raw)
    ) {
      const err = new Error(
        "Client MetaTrader session expired — open the app and reconnect the broker"
      );
      err.status = 409;
      err.code = "SESSION_EXPIRED";
      throw err;
    }
  } catch (error) {
    if (error?.code === "SESSION_EXPIRED") throw error;
    const msg = String(error?.message || "");
    if (/not\s*connect|disconnect|invalid|token|session|expire|404|401|403|not\s*found/i.test(msg)) {
      const err = new Error(
        "Client MetaTrader session expired — open the app and reconnect the broker"
      );
      err.status = 409;
      err.code = "SESSION_EXPIRED";
      err.data = error.data;
      throw err;
    }
    // Soft-fail check — still attempt OrderSend (some builds return odd CheckConnect bodies)
  }

  const sym = await resolveTradeSymbol(id, requested);

  let price = null;
  try {
    const quote = await mt5Fetch(
      `/GetQuote?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(sym)}`,
      { timeoutMs: 12000 }
    );
    const bid = Number(quote?.bid ?? quote?.Bid ?? quote?.bidPrice);
    const ask = Number(quote?.ask ?? quote?.Ask ?? quote?.askPrice);
    const mid = Number(quote?.price ?? quote?.last ?? quote?.Last);
    if (action === "Buy" && Number.isFinite(ask) && ask > 0) price = ask;
    else if (action === "Sell" && Number.isFinite(bid) && bid > 0) price = bid;
    else if (Number.isFinite(mid) && mid > 0) price = mid;
  } catch {
    price = null;
  }

  const tpList = Array.isArray(takeProfits)
    ? takeProfits.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const defaultTp = Number(takeProfit);

  const fills = [];
  for (let i = 0; i < times; i += 1) {
    // Cycle TP1 → TP2 → TP3 for every thread (T1=TP1, T2=TP2, T3=TP3, T4=TP1, …).
    let tpForThread = null;
    const slot = i % 3;
    if (tpList.length) {
      tpForThread =
        tpList[slot] ?? tpList[Math.min(slot, tpList.length - 1)] ?? null;
    } else if (Number.isFinite(defaultTp) && defaultTp > 0) {
      tpForThread = defaultTp;
    }

    const threadLabel = slot === 0 ? "TP1" : slot === 1 ? "TP2" : "TP3";
    const baseComment = String(comment || "bot~APEXEA").replace(/\|TP[123]\b/gi, "");
    const threadComment = `${baseComment}|${threadLabel}`.slice(0, 31);

    const params = new URLSearchParams({
      id,
      symbol: sym,
      operation: action,
      volume: String(lots),
      slippage: "100",
      comment: threadComment,
    });
    if (Number.isFinite(price) && price > 0) params.set("price", String(price));
    const sl = Number(stopLoss);
    if (Number.isFinite(sl) && sl > 0) params.set("stoploss", String(sl));
    if (Number.isFinite(tpForThread) && tpForThread > 0) {
      params.set("takeprofit", String(tpForThread));
    }

    const order = await mt5Fetch(`/OrderSend?${params.toString()}`, { timeoutMs: 45000 });
    const raw =
      typeof order === "string"
        ? order.trim()
        : order && typeof order === "object"
          ? JSON.stringify(order)
          : String(order ?? "");
    if (/^\[error\]/i.test(raw) || (order && order.error) || /invalid|not\s*exist|market\s*closed|trade\s*disabled|no\s*prices/i.test(raw)) {
      const hint =
        typeof order === "string"
          ? order.replace(/^\[error\]:?\s*/i, "").trim()
          : order?.message || order?.error || raw;
      const err = new Error(
        String(hint || "Broker rejected the order").slice(0, 180)
      );
      err.status = 400;
      err.data = order;
      throw err;
    }
    fills.push(
      order && typeof order === "object"
        ? { ...order, target: threadLabel, tradeNo: i + 1 }
        : { order, target: threadLabel, tradeNo: i + 1 }
    );
  }

  const last = fills[fills.length - 1];
  return {
    ok: true,
    provider: "mt5api",
    order: last,
    orders: fills,
    tickets: fills.map((o) => o?.ticket ?? o?.order ?? null).filter((v) => v != null),
    count: fills.length,
    ticket: last?.ticket ?? last?.order ?? null,
    symbol: sym,
    volume: lots,
    side: action.toUpperCase(),
  };
}

/** Pick the broker's real symbol name for a requested pair (XAUUSD → XAUUSD.mic, etc.). */
async function resolveTradeSymbol(accountId, requested) {
  const want = String(requested || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "");
  if (!want) return requested;

  let symbols = [];
  try {
    const data = await mt5Fetch(`/Symbols?id=${encodeURIComponent(accountId)}`, {
      timeoutMs: 20000,
    });
    if (Array.isArray(data)) symbols = data.map(String);
    else if (Array.isArray(data?.symbols)) symbols = data.symbols.map(String);
    else if (typeof data === "string") {
      symbols = data
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } catch {
    return want;
  }

  const upper = symbols.map((s) => ({ raw: s, u: String(s).toUpperCase() }));
  const exact = upper.find((s) => s.u === want);
  if (exact) return exact.raw;

  const base = want.replace(/\.(MIC|M|I|PRO|RAW|ECN|STD)$/i, "");
  const candidates = upper.filter(
    (s) =>
      s.u === base ||
      s.u.startsWith(base) ||
      s.u.includes(base) ||
      (base === "XAUUSD" && /XAU|GOLD/i.test(s.u)) ||
      (base === "XAGUSD" && /XAG|SILVER/i.test(s.u))
  );
  if (!candidates.length) return want;

  // Prefer common broker suffixes for gold/FX.
  const rank = (u) => {
    if (u === base) return 0;
    if (u === `${base}.MIC`) return 1;
    if (u === `${base}M` || u === `${base}.M`) return 2;
    if (u.startsWith(base)) return 3;
    return 4;
  };
  candidates.sort((a, b) => rank(a.u) - rank(b.u) || a.u.length - b.u.length);
  return candidates[0].raw;
}
