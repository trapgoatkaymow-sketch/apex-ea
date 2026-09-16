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

/** Map Swagger Company[] → UI broker rows. */
export function mapSearchResults(data, platform = "MT5") {
  if (!Array.isArray(data)) return [];
  const plat = String(platform || "MT5").toUpperCase() === "MT4" ? "MT4" : "MT5";
  const brokers = [];
  data.forEach((companyEntry) => {
    const companyName = String(companyEntry?.company || "").trim() || "Unknown broker";
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
  return brokers;
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

  const id = typeof token === "string" ? token.trim().replace(/^"|"$/g, "") : String(token || "").trim();
  if (!id) {
    const err = new Error("Broker connection failed — no session token");
    err.status = 502;
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
 */
export async function placeMarketTrade({
  accountId,
  symbol,
  volume = 0.01,
  side = "BUY",
  stopLoss,
  takeProfit,
  comment = "bot~APEXEA",
} = {}) {
  const id = String(accountId || "").trim();
  const sym = String(symbol || "").trim().toUpperCase();
  const lots = Number(volume);
  const action = String(side || "BUY").trim().toUpperCase() === "SELL" ? "Sell" : "Buy";

  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }
  if (!sym) {
    const err = new Error("Symbol is required");
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(lots) || lots <= 0) {
    const err = new Error("Lot size must be greater than 0");
    err.status = 400;
    throw err;
  }

  const params = new URLSearchParams({
    id,
    symbol: sym,
    operation: action,
    volume: String(lots),
    comment: String(comment || "bot~APEXEA").slice(0, 31),
  });
  const sl = Number(stopLoss);
  const tp = Number(takeProfit);
  if (Number.isFinite(sl) && sl > 0) params.set("stoploss", String(sl));
  if (Number.isFinite(tp) && tp > 0) params.set("takeprofit", String(tp));

  const order = await mt5Fetch(`/OrderSend?${params.toString()}`, { timeoutMs: 45000 });
  return {
    ok: true,
    provider: "mt5api",
    order,
    ticket: order?.ticket ?? order?.order ?? null,
    symbol: sym,
    volume: lots,
    side: action.toUpperCase(),
  };
}
