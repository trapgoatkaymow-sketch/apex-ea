import { applyCorsHeaders } from "../_cors.js";
import {
  candidateSymbols,
  normalizeBrokerSymbol,
  pickBestSymbolFromList,
  sameInstrumentFamily,
} from "../_symbolResolve.js";
import { normalizeProtectiveLevels } from "../_tradeLevels.js";

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

/** MT5REST often returns ExceptionResult with HTTP 201 (still "ok" for fetch). */
function isMt5ExceptionResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const code = String(data.code || "").trim();
  if (!code) return false;
  // Real account payloads have balance/equity/currency — exceptions do not.
  // MT5API uses PascalCase (Balance, Equity, Currency) on many hosts.
  if (
    data.balance != null ||
    data.Balance != null ||
    data.equity != null ||
    data.Equity != null ||
    data.currency ||
    data.Currency ||
    data.login != null ||
    data.Login != null ||
    data.accountNumber != null ||
    data.AccountNumber != null ||
    data.freeMargin != null ||
    data.FreeMargin != null
  ) {
    return false;
  }
  return data.message != null || data.stackTrace != null || Boolean(code);
}

function deepPickNumber(root, names = []) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(cur)) {
      if (want.has(String(key).toLowerCase())) {
        if (value == null || value === "") continue;
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return null;
}

function deepPickCurrency(root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(cur)) {
      if (/^currency$/i.test(key)) {
        const code = String(value || "")
          .trim()
          .toUpperCase();
        if (/^[A-Z]{3}$/.test(code)) return code;
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
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
    // Do NOT treat HTTP 201 account snapshots as errors when Balance/Equity exist.
    const exception = isMt5ExceptionResult(data);
    if (!response.ok || exception) {
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
          : exception
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
        if (last.synced === true || last.Synced === true) return last;
        const hasMoney =
          last.currency ||
          last.Currency ||
          Number.isFinite(Number(last.balance)) ||
          Number.isFinite(Number(last.Balance)) ||
          Number.isFinite(Number(last.equity)) ||
          Number.isFinite(Number(last.Equity));
        // Prefer a usable money snapshot even while synced is still false.
        if (hasMoney) {
          if (last.synced === false || last.Synced === false) {
            if (i >= 1) return last;
          } else if (i >= 1 || last.currency || last.Currency) {
            return last;
          }
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

/**
 * List opened orders from MT5API. Returns raw rows (positions + pendings).
 */
async function listOpenedOrders(accountId, { timeoutMs = 12000 } = {}) {
  const id = String(accountId || "").trim();
  if (!id) return [];
  let data = null;
  try {
    data = await mt5Fetch(`/OpenedOrders?id=${encodeURIComponent(id)}`, {
      timeoutMs,
    });
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.orders)
      ? data.orders
      : Array.isArray(data?.OpenedOrders)
        ? data.OpenedOrders
        : [];
  return list.filter((row) => row && typeof row === "object");
}

function isPendingOrderRow(row) {
  const kind = String(row?.kind || row?.Kind || row?.orderType || row?.OrderType || "")
    .trim()
    .toLowerCase();
  const type = String(row?.type || row?.Type || row?.orderType || "")
    .trim()
    .toLowerCase();
  return (
    /pending|limit|stop|stopimit|buystop|sellstop|buylimit|selllimit/.test(kind) ||
    /limit|stop/.test(type)
  );
}

function orderTicket(row) {
  const ticket = pickNumber(row?.ticket, row?.Ticket, row?.order, row?.Order);
  return ticket != null ? Math.trunc(ticket) : null;
}

function orderLots(row) {
  return pickNumber(
    row?.lots,
    row?.Lots,
    row?.volume,
    row?.Volume,
    row?.volumeCurrent,
    row?.VolumeCurrent
  );
}

/**
 * Sum live floating P/L from open market positions (matches MT5 Trade tab).
 * Pending orders are skipped (profit is usually 0).
 */
async function fetchOpenedOrdersProfit(accountId, { timeoutMs = 12000 } = {}) {
  const id = String(accountId || "").trim();
  if (!id) return null;
  let list = [];
  try {
    list = await listOpenedOrders(id, { timeoutMs });
  } catch {
    return null;
  }
  if (!list.length) return 0;
  let total = 0;
  let saw = false;
  for (const row of list) {
    if (isPendingOrderRow(row)) continue;
    const profit = pickNumber(
      row.profit,
      row.Profit,
      row.unrealizedProfit,
      row.floatingProfit
    );
    const swap = pickNumber(row.swap, row.Swap) || 0;
    const commission = pickNumber(row.commission, row.Commission) || 0;
    if (profit == null) continue;
    saw = true;
    total += profit + swap + commission;
  }
  return saw ? Number(total.toFixed(8)) : 0;
}

/** Close one market position (full volume when lots omitted / 0). */
async function closeOpenedPosition(accountId, ticket, lots = 0) {
  const id = String(accountId || "").trim();
  const ticketN = Math.trunc(Number(ticket));
  if (!id || !Number.isFinite(ticketN) || ticketN <= 0) {
    const err = new Error("Valid accountId and ticket are required");
    err.status = 400;
    throw err;
  }
  const params = new URLSearchParams({
    id,
    ticket: String(ticketN),
    slippage: "100",
  });
  const lotsN = Number(lots);
  if (Number.isFinite(lotsN) && lotsN > 0) {
    params.set("lots", String(lotsN));
  } else {
    // 0 = close full remaining volume on most MT5REST builds.
    params.set("lots", "0");
  }
  const order = await mt5Fetch(`/OrderClose?${params.toString()}`, {
    timeoutMs: 45000,
  });
  const raw =
    typeof order === "string"
      ? order.trim()
      : order && typeof order === "object"
        ? JSON.stringify(order)
        : String(order ?? "");
  if (
    /^\[error\]/i.test(raw) ||
    (order && order.error) ||
    /invalid|not\s*exist|market\s*closed|trade\s*disabled|no\s*prices|timeout/i.test(
      raw
    )
  ) {
    const hint =
      typeof order === "string"
        ? order.replace(/^\[error\]:?\s*/i, "").trim()
        : order?.message || order?.error || raw;
    const err = new Error(String(hint || "Could not close position").slice(0, 180));
    err.status = 400;
    err.data = order;
    throw err;
  }
  return order;
}

/**
 * Close every open market position on the connected account.
 * Pending orders are left alone.
 */
export async function closeAllPositions(accountId) {
  const id = String(accountId || "").trim();
  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }

  // Ensure session is still alive before closing.
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
        "Client MetaTrader session expired — reconnect the broker first"
      );
      err.status = 409;
      err.code = "SESSION_EXPIRED";
      throw err;
    }
  } catch (error) {
    if (error?.code === "SESSION_EXPIRED" || error?.status === 409) throw error;
    // Soft-fail check — still attempt closes
  }

  // Fetch open orders hard — do not treat API failure as "nothing to close".
  let opened = [];
  try {
    const data = await mt5Fetch(`/OpenedOrders?id=${encodeURIComponent(id)}`, {
      timeoutMs: 15000,
    });
    opened = Array.isArray(data)
      ? data
      : Array.isArray(data?.orders)
        ? data.orders
        : Array.isArray(data?.OpenedOrders)
          ? data.OpenedOrders
          : [];
    opened = opened.filter((row) => row && typeof row === "object");
  } catch (error) {
    const err = new Error(
      error?.message || "Could not load open positions from the broker"
    );
    err.status = error?.status || 502;
    err.data = error?.data || null;
    throw err;
  }

  const positions = opened.filter((row) => !isPendingOrderRow(row));
  if (!positions.length) {
    return {
      ok: true,
      closedCount: 0,
      failedCount: 0,
      closed: [],
      failed: [],
      message: "No open positions to close",
    };
  }

  const closed = [];
  const failed = [];
  for (const row of positions) {
    const ticket = orderTicket(row);
    if (!ticket) {
      failed.push({ ticket: null, error: "Missing ticket" });
      continue;
    }
    try {
      const result = await closeOpenedPosition(id, ticket, orderLots(row) || 0);
      closed.push({
        ticket,
        symbol: String(row.symbol || row.Symbol || "").trim(),
        lots: orderLots(row),
        result,
      });
    } catch (error) {
      failed.push({
        ticket,
        symbol: String(row.symbol || row.Symbol || "").trim(),
        error: error?.message || "Close failed",
      });
    }
  }

  return {
    ok: failed.length === 0,
    closedCount: closed.length,
    failedCount: failed.length,
    closed,
    failed,
    message:
      failed.length === 0
        ? closed.length === 1
          ? "Closed 1 position"
          : `Closed ${closed.length} positions`
        : `Closed ${closed.length} · ${failed.length} failed`,
  };
}

/**
 * Real MT5 floating = open P/L.
 * Prefer OpenedOrders sum, then AccountSummary.Profit, then equity−balance−credit.
 * Never trust equity−balance alone when Credit exists (that was returning wrong amounts).
 */
function deriveFloatingProfit({
  balance,
  equity,
  credit,
  profit,
  ordersProfit,
} = {}) {
  // null = OpenedOrders fetch failed; 0 = no open positions (real flat floating).
  if (ordersProfit != null && Number.isFinite(Number(ordersProfit))) {
    return Number(Number(ordersProfit).toFixed(8));
  }
  const direct = pickNumber(profit);
  if (direct != null) {
    return Number(direct.toFixed(8));
  }
  const bal = Number(balance);
  const eq = Number(equity);
  const cr = Number(credit);
  const creditN = Number.isFinite(cr) ? cr : 0;
  if (Number.isFinite(bal) && Number.isFinite(eq)) {
    return Number((eq - bal - creditN).toFixed(8));
  }
  return null;
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
  ordersProfit = null,
}) {
  const id = String(token || "").trim();
  // Prefer AccountSummary top-level only — deep-picking nested fields caused
  // wrong equity/profit (showing +R7k while MT5 showed −R2k).
  const balance = pickNumber(
    summary?.balance,
    summary?.Balance,
    account?.balance,
    account?.Balance
  );
  const equity = pickNumber(
    summary?.equity,
    summary?.Equity,
    account?.equity,
    account?.Equity
  );
  const credit = pickNumber(
    summary?.credit,
    summary?.Credit,
    account?.credit,
    account?.Credit
  );
  const summaryProfit = pickNumber(summary?.profit, summary?.Profit);
  const profit = deriveFloatingProfit({
    balance,
    equity,
    credit,
    profit: summaryProfit,
    ordersProfit,
  });
  const currency = pickCurrency(
    summary?.currency,
    summary?.Currency,
    account?.currency,
    account?.Currency,
    details?.currency,
    details?.Currency
  );
  return {
    accountId: id,
    provider: "mt5api",
    login: String(
      login ||
        details?.accountNumber ||
        details?.login ||
        account?.login ||
        account?.Login ||
        ""
    ).trim(),
    server: String(server || details?.serverName || details?.ServerName || "").trim(),
    platform: String(platform || "MT5").toUpperCase() === "MT4" ? "MT4" : "MT5",
    company: String(company || details?.company || details?.Company || "").trim(),
    region: "",
    state: "DEPLOYED",
    connectionStatus: "CONNECTED",
    pending: false,
    connectedAt: Date.now(),
    currency,
    balance,
    equity,
    credit: credit != null ? credit : 0,
    profit,
    leverage:
      summary?.leverage ??
      summary?.Leverage ??
      details?.leverage ??
      account?.leverage ??
      null,
    synced: summary?.synced === true || summary?.Synced === true,
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
  let ordersProfit = null;
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
  try {
    ordersProfit = await fetchOpenedOrdersProfit(id, { timeoutMs: 15000 });
  } catch {
    ordersProfit = null;
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
    ordersProfit,
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
      live == null ||
      raw === "" ||
      /^ok$/i.test(raw) ||
      /^true$/i.test(raw) ||
      (typeof live === "object" &&
        live &&
        !/^\[error\]/i.test(raw) &&
        live.connected !== false &&
        live.ok !== false &&
        !live.code);
    if (!ok || /^\[error\]/i.test(raw) || live === false || raw === "false") {
      // Only hard-kill on explicit session/token loss. Everything else stays sticky.
      if (
        /not\s*found|invalid\s*token|invalid\s*id|unknown\s*id|no\s*such|client\s*not/i.test(
          raw
        )
      ) {
        return dead;
      }
      return transient;
    }
  } catch (error) {
    const msg = String(error?.message || error?.code || "");
    if (/INVALID_TOKEN|not found|unknown id|no such client/i.test(msg)) return dead;
    return transient;
  }

  let summary = null;
  let details = null;
  let account = null;
  let ordersProfit = null;
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
  try {
    ordersProfit = await fetchOpenedOrdersProfit(id, { timeoutMs: 12000 });
  } catch {
    ordersProfit = null;
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
    ordersProfit,
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
  const requested = normalizeBrokerSymbol(symbol);
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

  const requestedNorm = normalizeBrokerSymbol(requested) || String(requested || "").trim();
  const { symbol: resolvedSym, accountSymbols } = await resolveTradeSymbolDetailed(
    id,
    requestedNorm
  );

  async function subscribeSymbol(symbolName) {
    const name = String(symbolName || "").trim();
    if (!name) return;
    try {
      // Many MT5API builds require Subscribe before GetQuote/OrderSend, otherwise
      // clients see "Symbol not found: EURUSD (:login)".
      await mt5Fetch(
        `/Subscribe?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(name)}&interval=0`,
        { timeoutMs: 8000 }
      );
    } catch {
      // Some hosts auto-subscribe on GetQuote — keep probing.
    }
  }

  async function fetchQuotePrice(symbolName) {
    try {
      await subscribeSymbol(symbolName);
      const quote = await mt5Fetch(
        `/GetQuote?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(symbolName)}`,
        { timeoutMs: 12000 }
      );
      const bid = Number(quote?.bid ?? quote?.Bid ?? quote?.bidPrice);
      const ask = Number(quote?.ask ?? quote?.Ask ?? quote?.askPrice);
      const mid = Number(quote?.price ?? quote?.last ?? quote?.Last);
      if (action === "Buy" && Number.isFinite(ask) && ask > 0) return { price: ask, symbol: symbolName };
      if (action === "Sell" && Number.isFinite(bid) && bid > 0) return { price: bid, symbol: symbolName };
      if (Number.isFinite(mid) && mid > 0) return { price: mid, symbol: symbolName };
      if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
        return { price: (bid + ask) / 2, symbol: symbolName };
      }
    } catch {
      // try next candidate
    }
    return null;
  }

  async function symbolParamsExist(symbolName) {
    try {
      const data = await mt5Fetch(
        `/SymbolParams?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(symbolName)}`,
        { timeoutMs: 8000 }
      );
      if (data == null) return false;
      if (typeof data === "string") {
        return !/^\[error\]/i.test(data) && !/not\s*found|unknown/i.test(data);
      }
      if (typeof data === "object") {
        if (isMt5ExceptionResult(data)) return false;
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  // Probe order: exact account catalog match → other family names on account →
  // common broker suffixes (EURUSDm / EURUSD.p / …).
  const probeSymbols = buildTradeSymbolProbe({
    requested: requestedNorm,
    resolved: resolvedSym,
    accountSymbols,
  });

  let price = null;
  let tradeSymbol = "";
  const quoteTried = new Set();
  for (const alt of probeSymbols) {
    const key = String(alt || "").toLowerCase();
    if (!key || quoteTried.has(key)) continue;
    quoteTried.add(key);
    const hit = await fetchQuotePrice(alt);
    if (hit) {
      price = hit.price;
      tradeSymbol = hit.symbol;
      break;
    }
    if (quoteTried.size >= 40) break;
  }

  // No live quote — still accept a spelling that exists in SymbolParams.
  if (!tradeSymbol) {
    for (const alt of probeSymbols.slice(0, 24)) {
      const key = String(alt || "").toLowerCase();
      if (!key || quoteTried.has(`params:${key}`)) continue;
      quoteTried.add(`params:${key}`);
      await subscribeSymbol(alt);
      if (await symbolParamsExist(alt)) {
        tradeSymbol = alt;
        break;
      }
    }
  }

  if (!tradeSymbol) {
    tradeSymbol = resolvedSym || requestedNorm;
    await subscribeSymbol(tradeSymbol);
  }

  const tpList = Array.isArray(takeProfits)
    ? takeProfits.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const defaultTp = Number(takeProfit);

  // Anchor SL/TP to the live fill so stale chart levels cannot sit inside the
  // broker's stop distance (that caused instant self-closes / Invalid stops).
  const fillPrice =
    Number.isFinite(price) && price > 0 ? price : null;
  const tradeSide = action === "Sell" ? "SELL" : "BUY";
  const safeSl = normalizeProtectiveLevels({
    symbol: tradeSymbol || requested,
    side: tradeSide,
    entryPrice: fillPrice,
    stopLoss,
    takeProfit: null,
    ensureStop: true,
  });
  // Always prefer a live-anchored SL — never send a naked market order by default.
  let anchoredSl = safeSl.stopLoss;
  if (
    (!(Number.isFinite(Number(anchoredSl)) && Number(anchoredSl) > 0)) &&
    Number.isFinite(fillPrice) &&
    fillPrice > 0
  ) {
    const pad = Math.max(Number(safeSl.minDist) || 0, fillPrice * 0.001);
    anchoredSl =
      tradeSide === "BUY" ? fillPrice - pad : fillPrice + pad;
  }

  function orderLooksBad(order) {
    const raw =
      typeof order === "string"
        ? order.trim()
        : order && typeof order === "object"
          ? JSON.stringify(order)
          : String(order ?? "");
    return (
      /^\[error\]/i.test(raw) ||
      (order && order.error) ||
      /invalid|not\s*exist|not\s*found|unknown\s*symbol|market\s*closed|trade\s*disabled|no\s*prices/i.test(
        raw
      )
    );
  }

  function orderHint(order) {
    return typeof order === "string"
      ? order.replace(/^\[error\]:?\s*/i, "").trim()
      : order?.message || order?.error || String(order ?? "");
  }

  function isSymbolMissingError(hint) {
    return /symbol\s*not\s*found|unknown\s*symbol|not\s*exist|no\s*symbol|invalid\s*symbol/i.test(
      String(hint || "")
    );
  }

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

    const safeTp = normalizeProtectiveLevels({
      symbol: tradeSymbol || requested,
      side: tradeSide,
      entryPrice: fillPrice,
      stopLoss: anchoredSl,
      takeProfit: tpForThread,
      ensureStop: true,
    });
    tpForThread = safeTp.takeProfit;
    if (Number.isFinite(Number(safeTp.stopLoss)) && Number(safeTp.stopLoss) > 0) {
      anchoredSl = safeTp.stopLoss;
    }

    const threadLabel = slot === 0 ? "TP1" : slot === 1 ? "TP2" : "TP3";
    // Keep |premium for Interface 2; never append |TP1/TP2/TP3.
    const threadComment = String(comment || "bot~APEXEA")
      .replace(/\|TP[123]\b/gi, "")
      .replace(/\|+/g, "|")
      .replace(/\|$/g, "")
      .slice(0, 31) || "bot~APEXEA";

    async function sendOrder({
      symbolName = tradeSymbol,
      slValue,
      tpValue,
      includePrice,
      orderPrice = price,
    }) {
      const params = new URLSearchParams({
        id,
        symbol: symbolName,
        operation: action,
        volume: String(lots),
        slippage: "100",
        comment: threadComment,
      });
      // Market orders: omit price by default — a stale quote + stops often
      // triggers broker "Invalid stops".
      if (includePrice && Number.isFinite(orderPrice) && orderPrice > 0) {
        params.set("price", String(orderPrice));
      }
      if (Number.isFinite(slValue) && slValue > 0) {
        params.set("stoploss", String(slValue));
      }
      if (Number.isFinite(tpValue) && tpValue > 0) {
        params.set("takeprofit", String(tpValue));
      }
      try {
        return await mt5Fetch(`/OrderSend?${params.toString()}`, { timeoutMs: 45000 });
      } catch (error) {
        // Normalize thrown MT5 exceptions into the same shape as soft failures
        // so symbol-not-found can rotate to the next broker spelling.
        return {
          error: true,
          message: error?.message || "OrderSend failed",
          code: error?.code || "",
          data: error?.data || null,
        };
      }
    }

    let order = await sendOrder({
      slValue: Number(anchoredSl),
      tpValue: Number(tpForThread),
      includePrice: false,
    });

    // Wrong broker spelling (EURUSD vs EURUSDm / EURUSD.p) — rotate candidates.
    if (orderLooksBad(order) && isSymbolMissingError(orderHint(order))) {
      const triedSend = new Set([String(tradeSymbol || "").toLowerCase()]);
      for (const alt of probeSymbols) {
        const key = String(alt || "").toLowerCase();
        if (!key || triedSend.has(key)) continue;
        triedSend.add(key);
        await subscribeSymbol(alt);
        const altQuote = await fetchQuotePrice(alt);
        const altPrice = altQuote?.price ?? null;
        order = await sendOrder({
          symbolName: alt,
          slValue: Number(anchoredSl),
          tpValue: Number(tpForThread),
          includePrice: false,
          orderPrice: altPrice,
        });
        if (!orderLooksBad(order) || !isSymbolMissingError(orderHint(order))) {
          tradeSymbol = alt;
          if (Number.isFinite(altPrice) && altPrice > 0) price = altPrice;
          break;
        }
        if (triedSend.size >= 16) break;
      }
    }

    // Retry with wider stops if broker rejects Invalid stops (freeze level).
    if (orderLooksBad(order) && /invalid\s*stops/i.test(orderHint(order))) {
      const liveFill =
        Number.isFinite(price) && price > 0
          ? price
          : fillPrice;
      const pad = Math.max(
        Number(safeSl.minDist) || 0,
        Number(safeTp.minDist) || 0,
        liveFill ? Math.abs(liveFill) * 0.001 : 0
      ) * 1.8;
      // REPLACE bad/tiny SL — never Math.min with a near-zero AI stop (that kept SL invalid).
      let retrySl = null;
      let retryTp = Number(tpForThread);
      if (Number.isFinite(liveFill) && liveFill > 0 && pad > 0) {
        if (tradeSide === "BUY") {
          retrySl = liveFill - pad;
          retryTp = Number.isFinite(retryTp)
            ? Math.max(retryTp, liveFill + pad)
            : liveFill + pad * 2;
          // Keep TP inside a sane band relative to the new SL.
          const maxTp = liveFill + pad * 4;
          if (retryTp > maxTp) retryTp = maxTp;
        } else {
          retrySl = liveFill + pad;
          retryTp = Number.isFinite(retryTp)
            ? Math.min(retryTp, liveFill - pad)
            : liveFill - pad * 2;
          const minTp = liveFill - pad * 4;
          if (retryTp < minTp) retryTp = minTp;
        }
      }
      order = await sendOrder({
        slValue: retrySl,
        tpValue: retryTp,
        includePrice: false,
      });
      if (!orderLooksBad(order)) {
        anchoredSl = retrySl;
        tpForThread = retryTp;
      }
    }

    // Last resort: still try SL-only (no TP), then TP-only — never prefer naked.
    if (orderLooksBad(order) && /invalid\s*stops/i.test(orderHint(order))) {
      const liveFill =
        Number.isFinite(price) && price > 0 ? price : fillPrice;
      const pad = Math.max(
        Number(safeSl.minDist) || 0,
        liveFill ? Math.abs(liveFill) * 0.0015 : 0
      ) * 2.2;
      let soloSl = Number(anchoredSl);
      if (Number.isFinite(liveFill) && liveFill > 0 && pad > 0) {
        soloSl = tradeSide === "BUY" ? liveFill - pad : liveFill + pad;
      }
      order = await sendOrder({
        slValue: soloSl,
        tpValue: null,
        includePrice: false,
      });
      if (!orderLooksBad(order)) {
        order = {
          ...(order && typeof order === "object" ? order : { order }),
          warning: "Opened with SL only after broker rejected paired stops",
        };
      }
    }

    if (orderLooksBad(order) && /invalid\s*stops/i.test(orderHint(order))) {
      order = await sendOrder({
        slValue: null,
        tpValue: null,
        includePrice: false,
      });
      if (!orderLooksBad(order)) {
        order = {
          ...(order && typeof order === "object" ? order : { order }),
          stopsSkipped: true,
          warning: "Opened without SL/TP after broker rejected Invalid stops",
        };
      }
    }

    if (orderLooksBad(order)) {
      const hint = orderHint(order);
      const err = new Error(
        String(
          isSymbolMissingError(hint)
            ? `Symbol not found for ${requestedNorm} on this broker — reconnect MT5 or pick the chart symbol your terminal uses`
            : hint || "Broker rejected the order"
        ).slice(0, 180)
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
    symbol: tradeSymbol,
    volume: lots,
    side: action.toUpperCase(),
  };
}

/** Pull plain symbol names out of MT5API /Symbols payloads (string or object rows). */
function extractSymbolNames(data) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === "string" || typeof v === "number") {
      const s = String(v).trim();
      if (s && s !== "[object Object]") out.push(s);
      return;
    }
    if (typeof v === "object") {
      const name =
        v.Symbol ??
        v.symbol ??
        v.Name ??
        v.name ??
        v.symbolName ??
        v.SymbolName ??
        v.path ??
        v.Path ??
        null;
      if (name != null) push(name);
    }
  };

  if (Array.isArray(data)) {
    for (const row of data) push(row);
  } else if (data && typeof data === "object") {
    if (Array.isArray(data.symbols)) for (const row of data.symbols) push(row);
    else if (Array.isArray(data.Symbols)) for (const row of data.Symbols) push(row);
    else if (Array.isArray(data.result)) for (const row of data.result) push(row);
    else if (typeof data === "string") {
      String(data)
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach(push);
    }
  } else if (typeof data === "string") {
    data
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach(push);
  }

  // De-dupe case-insensitively, keep first casing from broker.
  const seen = new Set();
  const unique = [];
  for (const s of out) {
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(s);
  }
  return unique;
}

/** Ordered spellings to try for OrderSend / GetQuote on a client account. */
function buildTradeSymbolProbe({ requested, resolved, accountSymbols = [] } = {}) {
  const want = normalizeBrokerSymbol(requested) || String(requested || "").trim();
  const out = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (!s) return;
    if (out.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    out.push(s);
  };

  const list = Array.isArray(accountSymbols) ? accountSymbols.map(String).filter(Boolean) : [];
  const best = resolved || pickBestSymbolFromList(want, list) || want;
  push(best);

  // Prefer real catalog names for this instrument family (EURUSD → EURUSDm).
  const familyOnAccount = list.filter((s) => sameInstrumentFamily(want, s));
  familyOnAccount.sort((a, b) => {
    const aExact = normalizeBrokerSymbol(a).toLowerCase() === want.toLowerCase() ? 0 : 1;
    const bExact = normalizeBrokerSymbol(b).toLowerCase() === want.toLowerCase() ? 0 : 1;
    return aExact - bExact || a.length - b.length;
  });
  for (const s of familyOnAccount) push(s);

  for (const alt of candidateSymbols(want)) push(alt);
  return out;
}

async function resolveTradeSymbolDetailed(accountId, requested) {
  const want = normalizeBrokerSymbol(requested) || String(requested || "").trim();
  if (!want) {
    return { symbol: requested, accountSymbols: [] };
  }

  let symbols = [];
  try {
    const data = await mt5Fetch(`/Symbols?id=${encodeURIComponent(accountId)}`, {
      timeoutMs: 20000,
    });
    symbols = extractSymbolNames(data);
  } catch {
    return {
      symbol: pickBestSymbolFromList(want, []) || want,
      accountSymbols: [],
    };
  }

  const resolved = pickBestSymbolFromList(want, symbols);
  // If the catalog is loaded but has no family match, do not pretend plain
  // EURUSD exists — callers must walk broker suffixes / Subscribe.
  if (symbols.length) {
    const hasFamily = symbols.some((s) => sameInstrumentFamily(want, s));
    if (!hasFamily) {
      return { symbol: want, accountSymbols: symbols };
    }
  }
  return { symbol: resolved || want, accountSymbols: symbols };
}

/** Pick the broker's real symbol name for a requested pair (XAUUSD → XAUUSDm / GOLD / …). */
async function resolveTradeSymbol(accountId, requested) {
  const { symbol } = await resolveTradeSymbolDetailed(accountId, requested);
  return symbol;
}

/**
 * Live bid/ask/mid for a connected account symbol (used by silent START scanner).
 * `fast: true` keeps START snappy (fewer probes / shorter timeouts).
 */
export async function getSymbolQuote(
  accountId,
  symbol,
  { side = "BUY", fast = false } = {}
) {
  const id = String(accountId || "").trim();
  const requested = normalizeBrokerSymbol(symbol) || String(symbol || "").trim();
  if (!id || !requested) {
    const err = new Error("accountId and symbol are required");
    err.status = 400;
    throw err;
  }

  const action =
    String(side || "BUY").trim().toUpperCase() === "SELL" ? "Sell" : "Buy";
  const maxProbes = fast ? 8 : 40;
  const quoteTimeoutMs = fast ? 4000 : 12000;
  const subTimeoutMs = fast ? 3000 : 8000;

  async function subscribeSymbol(symbolName) {
    const name = String(symbolName || "").trim();
    if (!name) return;
    try {
      await mt5Fetch(
        `/Subscribe?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(name)}&interval=0`,
        { timeoutMs: subTimeoutMs }
      );
    } catch {
      // optional
    }
  }

  async function quoteOne(symbolName) {
    await subscribeSymbol(symbolName);
    const quote = await mt5Fetch(
      `/GetQuote?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(symbolName)}`,
      { timeoutMs: quoteTimeoutMs }
    );
    const bid = Number(quote?.bid ?? quote?.Bid ?? quote?.bidPrice);
    const ask = Number(quote?.ask ?? quote?.Ask ?? quote?.askPrice);
    const mid = Number(quote?.price ?? quote?.last ?? quote?.Last);
    let price = null;
    if (action === "Buy" && Number.isFinite(ask) && ask > 0) price = ask;
    else if (action === "Sell" && Number.isFinite(bid) && bid > 0) price = bid;
    else if (Number.isFinite(mid) && mid > 0) price = mid;
    else if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
      price = (bid + ask) / 2;
    }
    if (!(Number.isFinite(price) && price > 0)) return null;
    return {
      ok: true,
      accountId: id,
      symbol: symbolName,
      requestedSymbol: requested,
      bid: Number.isFinite(bid) && bid > 0 ? bid : null,
      ask: Number.isFinite(ask) && ask > 0 ? ask : null,
      price,
      side: action === "Sell" ? "SELL" : "BUY",
    };
  }

  // Fast path: try the exact requested spelling before heavy catalog resolve.
  try {
    const direct = await quoteOne(requested);
    if (direct) return direct;
  } catch {
    // fall through
  }

  const { symbol: resolvedSym, accountSymbols } =
    await resolveTradeSymbolDetailed(id, requested);
  const probeSymbols = buildTradeSymbolProbe({
    requested,
    resolved: resolvedSym,
    accountSymbols,
  });

  for (const alt of probeSymbols.slice(0, maxProbes)) {
    if (String(alt || "").toLowerCase() === requested.toLowerCase()) continue;
    try {
      const hit = await quoteOne(alt);
      if (hit) return hit;
    } catch {
      // try next spelling
    }
  }

  const err = new Error(`No live quote for ${requested}`);
  err.status = 404;
  throw err;
}

/**
 * Today's OHLC bars for a connected account (MT5 PriceHistoryToday).
 * timeFrame is minutes: 30=M30, 60=H1, 240=H4.
 */
export async function getPriceHistoryToday(
  accountId,
  symbol,
  { timeFrame = 30, fast = false } = {}
) {
  const id = String(accountId || "").trim();
  const requested = normalizeBrokerSymbol(symbol) || String(symbol || "").trim();
  const tf = Math.max(1, Math.floor(Number(timeFrame) || 30));
  if (!id || !requested) {
    const err = new Error("accountId and symbol are required");
    err.status = 400;
    throw err;
  }

  const timeoutMs = fast ? 8000 : 20000;

  async function historyOne(symbolName) {
    const name = String(symbolName || "").trim();
    if (!name) return null;
    // Path has a trailing space in swagger for Today — try both.
    const paths = [
      `/PriceHistoryToday?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(name)}&timeFrame=${tf}`,
      `/PriceHistoryToday%20?id=${encodeURIComponent(id)}&symbol=${encodeURIComponent(name)}&timeFrame=${tf}`,
    ];
    let lastErr = null;
    for (const path of paths) {
      try {
        const data = await mt5Fetch(path, { timeoutMs });
        const rows = Array.isArray(data) ? data : Array.isArray(data?.bars) ? data.bars : null;
        if (!rows?.length) continue;
        const bars = rows
          .map((row) => {
            const open = Number(row?.openPrice ?? row?.Open ?? row?.open);
            const high = Number(row?.highPrice ?? row?.High ?? row?.high);
            const low = Number(row?.lowPrice ?? row?.Low ?? row?.low);
            const close = Number(row?.closePrice ?? row?.Close ?? row?.close);
            if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) {
              return null;
            }
            return {
              time: row?.time || row?.Time || null,
              open,
              high,
              low,
              close,
            };
          })
          .filter(Boolean);
        if (bars.length) {
          return { ok: true, accountId: id, symbol: name, requestedSymbol: requested, timeFrame: tf, bars };
        }
      } catch (error) {
        lastErr = error;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  try {
    const direct = await historyOne(requested);
    if (direct) return direct;
  } catch {
    // resolve spelling below
  }

  const { symbol: resolvedSym, accountSymbols } =
    await resolveTradeSymbolDetailed(id, requested);
  const probeSymbols = buildTradeSymbolProbe({
    requested,
    resolved: resolvedSym,
    accountSymbols,
  });
  const maxProbes = fast ? 6 : 20;
  for (const alt of probeSymbols.slice(0, maxProbes)) {
    if (String(alt || "").toLowerCase() === requested.toLowerCase()) continue;
    try {
      const hit = await historyOne(alt);
      if (hit) return hit;
    } catch {
      // try next
    }
  }

  const err = new Error(`No price history for ${requested}`);
  err.status = 404;
  throw err;
}
