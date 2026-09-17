import { applyCorsHeaders } from "../_cors.js";

/** Self-hosted MT5API RESTful — https://66.23.225.158/swagger/index.html */
export const MT5_API_BASE = (
  process.env.MT5_API_BASE ||
  process.env.MT5_API_TARGET ||
  "http://66.23.225.158"
).replace(/\/$/, "");

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
    if (!response.ok) {
      const message =
        (typeof data === "string" && data) ||
        data?.message ||
        data?.title ||
        data?.error ||
        `MT5 API error ${response.status}`;
      const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
      err.status = response.status >= 400 && response.status < 600 ? response.status : 502;
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
    const companyName = String(companyEntry?.company || "").trim() || "Unknown broker";
    if (isBlockedBroker({ company: companyName })) return;
    const results = Array.isArray(companyEntry?.results) ? companyEntry.results : [];
    results.forEach((result, index) => {
      const serverName =
        String(result?.name || "").trim() || `${companyName} server`;
      const access = Array.isArray(result?.access)
        ? result.access.map(String).map((v) => v.trim()).filter(Boolean)
        : [];
      brokers.push({
        id: `${companyName}::${serverName}::${index}`,
        company: companyName,
        name: serverName,
        site: String(result?.site || "").trim(),
        logoUrl: String(result?.logo_url || result?.logoUrl || "").trim(),
        access,
        platform: plat,
        custom: false,
        source: "mt5api",
      });
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

function sessionFromConnect({
  token,
  login,
  server,
  platform = "MT5",
  company = "",
  summary = null,
  details = null,
}) {
  const id = String(token || "").trim();
  const balance = summary?.balance;
  const equity = summary?.equity;
  const profit =
    summary?.profit != null
      ? Number(summary.profit)
      : Number.isFinite(Number(balance)) && Number.isFinite(Number(equity))
        ? Number(equity) - Number(balance)
        : null;
  return {
    accountId: id,
    provider: "mt5api",
    login: String(login || details?.accountNumber || details?.login || "").trim(),
    server: String(server || details?.serverName || "").trim(),
    platform: String(platform || "MT5").toUpperCase() === "MT4" ? "MT4" : "MT5",
    company: String(company || details?.company || "").trim(),
    region: "",
    state: "DEPLOYED",
    connectionStatus: "CONNECTED",
    pending: false,
    connectedAt: Date.now(),
    currency: summary?.currency || details?.currency || "USD",
    balance: Number.isFinite(Number(balance)) ? Number(balance) : null,
    equity: Number.isFinite(Number(equity)) ? Number(equity) : null,
    profit: Number.isFinite(Number(profit)) ? Number(profit) : null,
    leverage: summary?.leverage ?? details?.leverage ?? null,
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

  const id =
    typeof token === "string"
      ? token.trim().replace(/^"|"$/g, "")
      : String(token || "").trim();

  // MT5API often returns HTTP 200 with bodies like "[error]:INVALID_ACCOUNT".
  if (!id || /^\[error\]/i.test(id) || /^error[:\s]/i.test(id)) {
    const hint = id.replace(/^\[error\]:?\s*/i, "").trim() || "INVALID_ACCOUNT";
    const friendly =
      /invalid_account|invalid_password|password|login|auth/i.test(hint)
        ? "Broker rejected the login credentials"
        : `Broker connection failed (${hint})`;
    const err = new Error(friendly);
    err.status = 400;
    err.data = { raw: id };
    throw err;
  }

  let summary = null;
  let details = null;
  try {
    summary = await mt5Fetch(`/AccountSummary?id=${encodeURIComponent(id)}`, {
      timeoutMs: 20000,
    });
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

  return sessionFromConnect({
    token: id,
    login: userLogin,
    server: userServer,
    platform,
    company,
    summary,
    details,
  });
}

export async function getAccountStatus(accountId, { company = "" } = {}) {
  const id = String(accountId || "").trim();
  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }

  try {
    await mt5Fetch(`/CheckConnect?id=${encodeURIComponent(id)}`, { timeoutMs: 15000 });
  } catch (error) {
    // Token dead / disconnected
    return {
      accountId: id,
      provider: "mt5api",
      company: company || "",
      state: "UNDEPLOYED",
      connectionStatus: "DISCONNECTED",
      pending: false,
      balance: null,
      equity: null,
      profit: null,
      currency: "USD",
    };
  }

  let summary = null;
  let details = null;
  try {
    summary = await mt5Fetch(`/AccountSummary?id=${encodeURIComponent(id)}`, {
      timeoutMs: 15000,
    });
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

  return sessionFromConnect({
    token: id,
    login: details?.accountNumber || details?.login || "",
    server: details?.serverName || "",
    platform: "MT5",
    company: company || details?.company || "",
    summary,
    details,
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
 */
export async function placeMarketTrade({
  accountId,
  symbol,
  volume = 0.01,
  side = "BUY",
  stopLoss,
  takeProfit,
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
    const ok =
      live == null ||
      live === true ||
      /^ok$/i.test(String(live).trim()) ||
      (typeof live === "object" && !/^\[error\]/i.test(JSON.stringify(live)));
    if (!ok || /^\[error\]/i.test(String(live || ""))) {
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
    if (/not\s*connect|disconnect|invalid|token|session|expire|404|401|403/i.test(msg)) {
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

  const fills = [];
  for (let i = 0; i < times; i += 1) {
    const params = new URLSearchParams({
      id,
      symbol: sym,
      operation: action,
      volume: String(lots),
      slippage: "100",
      comment: String(comment || "bot~APEXEA").slice(0, 31),
    });
    if (Number.isFinite(price) && price > 0) params.set("price", String(price));
    const sl = Number(stopLoss);
    const tp = Number(takeProfit);
    if (Number.isFinite(sl) && sl > 0) params.set("stoploss", String(sl));
    if (Number.isFinite(tp) && tp > 0) params.set("takeprofit", String(tp));

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
    fills.push(order);
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
