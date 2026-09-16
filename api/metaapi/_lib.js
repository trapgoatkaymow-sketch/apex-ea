import { randomBytes } from "node:crypto";
import { FALLBACK_METAAPI_TOKEN } from "./_fallbackToken.js";
import { applyCorsHeaders } from "../_cors.js";

const PROVISIONING_BASE =
  process.env.METAAPI_PROVISIONING_URL ||
  "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";

const COPYFACTORY_URL_TEMPLATE =
  process.env.METAAPI_COPYFACTORY_URL_TEMPLATE ||
  "https://copyfactory-api-v1.{region}.agiliumtrade.agiliumtrade.ai";

/** Self-hosted MT5API RESTful broker search (Swagger /Search). */
const MT5_API_BASE = (
  process.env.MT5_API_BASE ||
  process.env.MT5_API_TARGET ||
  "http://66.23.225.158"
).replace(/\/$/, "");


function requireToken(requestToken = "") {
  const token =
    String(requestToken || "").trim() ||
    process.env.METAAPI_TOKEN ||
    FALLBACK_METAAPI_TOKEN ||
    "";
  if (!token) {
    const err = new Error("METAAPI_TOKEN is not configured on the server");
    err.status = 500;
    throw err;
  }
  return token;
}

export function tokenFromRequest(req) {
  const header =
    req?.headers?.["x-metaapi-token"] ||
    req?.headers?.["auth-token"] ||
    "";
  return String(header || "").trim();
}

function transactionId() {
  return randomBytes(16).toString("hex");
}

const METAAPI_MAX_KEYWORDS = 3;

/** MetaAPI allows at most 3 account keywords — prioritize client tagging. */
function buildAccountKeywords({ company = "", server = "", clientEmail = "" } = {}) {
  const emailTag = normalizeClientEmail(clientEmail);
  const brokerLabel = String(company || server || "").trim();
  const serverName = String(server || "").trim();
  const out = [];

  const push = (value) => {
    const v = String(value || "").trim();
    if (!v || out.includes(v) || out.length >= METAAPI_MAX_KEYWORDS) return;
    out.push(v);
  };

  push("apexea-client");
  if (emailTag.includes("@")) push(`${CLIENT_EMAIL_TAG}${emailTag}`);
  push(brokerLabel);
  if (serverName && serverName !== brokerLabel) push(serverName);
  return out;
}

function trimMetaApiKeywords(keywords = []) {
  const list = Array.from(
    new Set(keywords.map(String).map((k) => k.trim()).filter(Boolean))
  );
  const emailTags = list.filter((k) => k.toLowerCase().startsWith(CLIENT_EMAIL_TAG));
  const hasClient = list.some((k) => k.toLowerCase() === "apexea-client");
  const brokerish = list.filter(
    (k) => !k.toLowerCase().startsWith(CLIENT_EMAIL_TAG) && k.toLowerCase() !== "apexea-client"
  );
  const out = [];
  if (emailTags[0]) out.push(emailTags[0]);
  if (hasClient) out.push("apexea-client");
  for (const keyword of brokerish) {
    if (out.length >= METAAPI_MAX_KEYWORDS) break;
    out.push(keyword);
  }
  return out.slice(0, METAAPI_MAX_KEYWORDS);
}

function formatMetaApiError(data, status) {
  if (!data) return `MetaAPI error ${status}`;
  const detailList = Array.isArray(data.details) ? data.details : null;
  if (detailList?.length) {
    const hints = detailList
      .map((row) => row?.message || row?.parameter)
      .filter(Boolean);
    if (hints.length) return hints.join(" ");
  }
  const details = data.details;
  if (typeof details === "string" && details && details !== "ValidationError") {
    return details;
  }
  const raw = data.message || data.error;
  if (typeof raw === "string") {
    if (/^Validation failed \([a-f0-9]{32}\)$/i.test(raw)) {
      return "Broker connection validation failed. Check login, password, and server name.";
    }
    return raw;
  }
  return typeof raw === "object" ? JSON.stringify(raw) : `MetaAPI error ${status}`;
}

async function metaFetch(url, { method = "GET", body, headers = {}, token } = {}) {
  const auth = requireToken(token);
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "auth-token": auth,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message =
      (data && formatMetaApiError(data, response.status)) ||
      (typeof data === "string" ? data : `MetaAPI error ${response.status}`);
    const err = new Error(typeof message === "string" ? message : JSON.stringify(message));
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return { data, response };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accountConnectionStatus(account) {
  return (
    account?.connectionStatus ||
    account?.primaryReplica?.connectionStatus ||
    account?.replicas?.[0]?.connectionStatus ||
    null
  );
}

function accountRegion(account) {
  return (
    account?.region ||
    account?.primaryReplica?.region ||
    account?.replicas?.[0]?.region ||
    null
  );
}

function accountIdOf(account) {
  return account?.id || account?._id || null;
}

const CLIENT_EMAIL_TAG = "apexea:";

function normalizeClientEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/**
 * Broker search via MT5API /Search?company=… (https://66.23.225.158/swagger).
 * Returns Company[] → { company, results:[{ name, logo_url, site, access }] }.
 */
export async function searchMt5ApiBrokers(query, platform = "MT5") {
  const q = String(query || "").trim();
  if (!q) return [];

  const plat = String(platform || "MT5").toUpperCase() === "MT4" ? "MT4" : "MT5";
  const url = `${MT5_API_BASE}/Search?company=${encodeURIComponent(q)}`;
  const controller = new AbortController();
  // Keep this short — the VPS often drops datacenter traffic and a long wait
  // made broker search feel broken before MetaAPI fallback could run.
  const timer = setTimeout(() => controller.abort(), 2500);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    const err = new Error(
      error?.name === "AbortError"
        ? "Broker search timed out"
        : error?.message || "Broker search unreachable"
    );
    err.status = 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      (typeof data === "string" && data) ||
      data?.message ||
      data?.title ||
      `Broker search error ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  if (!Array.isArray(data)) return [];

  const brokers = [];
  data.forEach((companyEntry) => {
    const companyName = String(companyEntry?.company || "").trim() || "Unknown broker";
    const results = Array.isArray(companyEntry?.results) ? companyEntry.results : [];
    results.forEach((result, index) => {
      const serverName = String(result?.name || "").trim() || `${companyName} server`;
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

export async function searchKnownServers(query, platform = "MT5", { token } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const version = String(platform).toUpperCase() === "MT4" ? 4 : 5;

  async function fromMetaApi() {
    const url = `${PROVISIONING_BASE}/known-mt-servers/${version}/search?query=${encodeURIComponent(q)}`;
    const { data } = await metaFetch(url, { token });
    const brokers = [];
    const grouped = data && typeof data === "object" ? data : {};
    Object.entries(grouped).forEach(([company, servers]) => {
      const list = Array.isArray(servers) ? servers : [];
      list.forEach((serverName, index) => {
        brokers.push({
          id: `${company}::${serverName}::${index}`,
          company,
          name: serverName,
          site: "",
          logoUrl: "",
          access: [],
          platform: version === 4 ? "MT4" : "MT5",
          custom: false,
          source: "metaapi",
        });
      });
    });
    return brokers;
  }

  // Run both in parallel. Cap is the short MT5 timeout (~2.5s), not a 15s hang.
  const [mt5, meta] = await Promise.all([
    searchMt5ApiBrokers(q, platform).catch((error) => {
      console.warn("mt5api broker search failed", error.message || error);
      return [];
    }),
    fromMetaApi(),
  ]);

  if (mt5.length) {
    if (!meta.length) return mt5;
    const seen = new Set(mt5.map((b) => `${b.company}::${b.name}`.toLowerCase()));
    return [
      ...mt5,
      ...meta.filter((b) => !seen.has(`${b.company}::${b.name}`.toLowerCase())),
    ];
  }

  return meta;
}

function parseRetryAfterSeconds(response, fallback = 60) {
  const header = response.headers.get("retry-after");
  if (!header) return fallback;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.max(5, Math.ceil((asDate - Date.now()) / 1000));
  }
  return fallback;
}

function sanitizeAccountPayload(payload = {}) {
  const next = { ...payload };
  if (Array.isArray(next.keywords)) {
    next.keywords = trimMetaApiKeywords(next.keywords);
  }
  return next;
}

async function createAccountWithRetry(payload, { maxAttempts = 10 } = {}) {
  let lastError;
  let tx = transactionId();
  let currentPayload = sanitizeAccountPayload(payload);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const { data, response } = await metaFetch(`${PROVISIONING_BASE}/users/current/accounts`, {
        method: "POST",
        headers: { "transaction-id": tx },
        body: sanitizeAccountPayload(currentPayload),
      });

      // 202 accepted — reuse same transaction-id and retry after delay
      if (response.status === 202 || data?.message?.toLowerCase?.().includes("retry")) {
        const retryAfter = parseRetryAfterSeconds(response, 60);
        await sleep(Math.min(Math.max(retryAfter, 5), 90) * 1000);
        continue;
      }

      return data;
    } catch (error) {
      lastError = error;
      const details = error?.data?.details;
      const code = details?.code || details || error?.data?.error;

      if (code === "E_RESOURCE_SLOTS" || details?.recommendedResourceSlots) {
        currentPayload = {
          ...currentPayload,
          resourceSlots: Number(details.recommendedResourceSlots) || 2,
        };
        tx = transactionId();
        continue;
      }

      if (code === "E_SRV_NOT_FOUND") {
        const suggestions = details?.serversByBrokers || error?.data?.details?.serversByBrokers;
        const flat = suggestions
          ? Object.entries(suggestions)
              .flatMap(([company, servers]) =>
                (Array.isArray(servers) ? servers : []).map((s) => `${company}: ${s}`)
              )
              .slice(0, 8)
          : [];
        const hint = flat.length ? ` Suggested: ${flat.join("; ")}` : "";
        const err = new Error(
          `Server name not found. Check the exact MT server name.${hint}`
        );
        err.status = 400;
        err.data = error.data;
        throw err;
      }

      if (code === "E_AUTH" || details === "E_AUTH") {
        const err = new Error("Broker rejected the login credentials");
        err.status = 400;
        err.data = error.data;
        throw err;
      }

      if (
        error?.status === 202 ||
        String(error.message || "").toLowerCase().includes("retry")
      ) {
        const retryAfter = 60;
        await sleep(retryAfter * 1000);
        continue;
      }

      // Conflict / duplicate transaction — new id
      if (error?.status === 409) {
        tx = transactionId();
        await sleep(2000);
        continue;
      }

      throw error;
    }
  }
  throw lastError || new Error("Account creation timed out");
}

export async function getAccount(accountId) {
  const { data } = await metaFetch(
    `${PROVISIONING_BASE}/users/current/accounts/${encodeURIComponent(accountId)}`
  );
  return data;
}

export async function deployAccount(accountId) {
  const { data } = await metaFetch(
    `${PROVISIONING_BASE}/users/current/accounts/${encodeURIComponent(accountId)}/deploy`,
    { method: "POST", headers: { "transaction-id": transactionId() } }
  );
  return data;
}

export async function undeployAccount(accountId) {
  const { data } = await metaFetch(
    `${PROVISIONING_BASE}/users/current/accounts/${encodeURIComponent(accountId)}/undeploy`,
    { method: "POST", headers: { "transaction-id": transactionId() } }
  );
  return data;
}

export async function waitUntilConnected(accountId, { timeoutMs = 45000 } = {}) {
  const started = Date.now();
  let account = await getAccount(accountId);

  if (account?.state && account.state !== "DEPLOYED") {
    try {
      await deployAccount(accountId);
    } catch {
      // may already be deploying
    }
  }

  while (Date.now() - started < timeoutMs) {
    account = await getAccount(accountId);
    const connection = accountConnectionStatus(account);

    if (connection === "CONNECTED") return { account, pending: false };
    if (["WRONG_CREDENTIALS", "INVALID_ACCOUNT"].includes(connection)) {
      const err = new Error("Broker rejected the login credentials");
      err.status = 400;
      throw err;
    }
    if (["DISCONNECTED"].includes(connection) && account?.state === "DEPLOY_FAILED") {
      const err = new Error("MetaAPI failed to deploy this account");
      err.status = 502;
      throw err;
    }
    await sleep(4000);
  }

  return { account, pending: true };
}

export async function subscribeToStrategy(account, strategyId) {
  if (!strategyId) return null;
  const region = accountRegion(account) || "vint-hill";
  const base = COPYFACTORY_URL_TEMPLATE.replace("{region}", region);
  const subscriberId = accountIdOf(account);
  const { data } = await metaFetch(
    `${base}/users/current/configuration/subscribers/${encodeURIComponent(subscriberId)}`,
    {
      method: "PUT",
      body: {
        name: account.name || `Subscriber ${account.login}`,
        subscriptions: [
          {
            strategyId,
            multiplier: 1,
          },
        ],
      },
    }
  );
  return data;
}

/** Remove CopyFactory subscriptions so MT5 connect never opens mirrored strategy trades. */
export async function clearStrategySubscriptions(account) {
  const region = accountRegion(account) || "vint-hill";
  const base = COPYFACTORY_URL_TEMPLATE.replace("{region}", region);
  const subscriberId = accountIdOf(account);
  if (!subscriberId) return null;
  const { data } = await metaFetch(
    `${base}/users/current/configuration/subscribers/${encodeURIComponent(subscriberId)}`,
    {
      method: "PUT",
      body: {
        name: account.name || `Subscriber ${account.login}`,
        subscriptions: [],
      },
    }
  );
  return data;
}

function sessionPayload(account, {
  login,
  server,
  platform,
  company,
  strategyId,
  subscription,
  subscriptionError,
  pending,
  balance,
  equity,
  profit,
  currency,
}) {
  const connection = accountConnectionStatus(account);
  return {
    accountId: accountIdOf(account),
    login: login || account?.login || "",
    server: server || account?.server || "",
    platform: platform || (account?.platform === "mt4" ? "MT4" : "MT5"),
    company: company || account?.name || server || "",
    state: account?.state || null,
    connectionStatus: connection,
    region: accountRegion(account),
    strategyId: strategyId || null,
    subscribed: Boolean(strategyId) && Boolean(subscription) && !subscriptionError,
    subscriptionError: subscriptionError || null,
    pending: Boolean(pending),
    balance: Number.isFinite(Number(balance)) ? Number(balance) : null,
    equity: Number.isFinite(Number(equity)) ? Number(equity) : null,
    // Floating / unrealized P/L (equity − balance), matching MT5 Trade tab.
    profit: Number.isFinite(Number(profit)) ? Number(profit) : null,
    currency: String(currency || "").trim().toUpperCase() || null,
  };
}

export async function getAccountInformation(accountId, { region, token } = {}) {
  const id = String(accountId || "").trim();
  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }
  const resolvedRegion = await resolveAccountRegion(id, region);
  const url = `${clientApiBase(resolvedRegion)}/users/current/accounts/${encodeURIComponent(id)}/account-information`;
  const { data } = await metaFetch(url, { token });
  return { region: resolvedRegion, info: data || null };
}

/** Sum open-position P/L when account-information has no profit field. */
export async function getOpenPositionsProfit(accountId, { region, token } = {}) {
  const id = String(accountId || "").trim();
  if (!id) return null;
  const resolvedRegion = await resolveAccountRegion(id, region);
  const url = `${clientApiBase(resolvedRegion)}/users/current/accounts/${encodeURIComponent(id)}/positions`;
  const { data } = await metaFetch(url, { token });
  const positions = Array.isArray(data) ? data : [];
  if (!positions.length) return 0;
  let total = 0;
  let saw = false;
  for (const row of positions) {
    const value = Number(
      row?.profit ?? row?.unrealizedProfit ?? row?.floatingProfit ?? NaN
    );
    if (!Number.isFinite(value)) continue;
    total += value;
    saw = true;
  }
  return saw ? total : 0;
}

/**
 * MetaAPI account-information returns balance + equity, not floating P/L.
 * MT5 floating profit = equity − balance (matches the Trade tab total).
 */
export function deriveFloatingProfit({ balance, equity, profit } = {}) {
  const bal = Number(balance);
  const eq = Number(equity);
  if (Number.isFinite(bal) && Number.isFinite(eq)) {
    return Number((eq - bal).toFixed(8));
  }
  const direct = Number(profit);
  return Number.isFinite(direct) ? direct : null;
}

export async function connectTradingAccount({
  login,
  password,
  server,
  platform = "MT5",
  company = "",
  clientEmail = "",
  // Opt-in only — never auto-subscribe from METAAPI_STRATEGY_ID (that opened
  // mirrored strategy trades without a chart scan).
  strategyId = "",
}) {
  const userLogin = String(login || "").trim();
  const userPassword = String(password || "");
  const userServer = String(server || "").trim();
  if (!userLogin || !userPassword || !userServer) {
    const err = new Error("Enter login, password, and server");
    err.status = 400;
    throw err;
  }

  const mtPlatform = String(platform).toUpperCase() === "MT4" ? "mt4" : "mt5";
  const emailTag = normalizeClientEmail(clientEmail);
  const keywords = buildAccountKeywords({
    company,
    server: userServer,
    clientEmail: emailTag,
  });

  // Reuse an already-provisioned account for this login/server (avoids E_AUTH on reconnect).
  const existing = await findExistingAccount({ login: userLogin, server: userServer });
  let accountId = accountIdOf(existing);
  let created = existing;

  if (!accountId) {
    try {
      created = await createAccountWithRetry({
        login: userLogin,
        password: userPassword,
        name: `${company || userServer} ${userLogin}${
          emailTag.includes("@") ? ` | ${CLIENT_EMAIL_TAG}${emailTag}` : ""
        }`.trim(),
        server: userServer,
        platform: mtPlatform,
        magic: 0,
        manualTrades: true,
        // G1 is enough for Chart Scanner market trades. Do NOT enable CopyFactory
        // roles here — unpaid CopyFactory blocks account create entirely.
        type: "cloud-g1",
        resourceSlots: 1,
        metastatsApiEnabled: false,
        riskManagementApiEnabled: false,
        ...(keywords.length ? { keywords } : {}),
      });
      accountId = accountIdOf(created);
    } catch (error) {
      const details = error?.data?.details;
      const code = details?.code || details || error?.data?.error;
      if (code === "E_AUTH" || details === "E_AUTH") {
        const again = await findExistingAccount({ login: userLogin, server: userServer });
        accountId = accountIdOf(again);
        created = again;
        if (!accountId) throw error;
      } else {
        throw error;
      }
    }
  }

  if (!accountId) throw new Error("MetaAPI did not return an account id");

  if (emailTag.includes("@")) {
    try {
      await tagAccountClientEmail(accountId, emailTag);
    } catch {
      // Tagging is best-effort; connect still succeeds.
    }
  }

  const { account, pending } = await waitUntilConnected(accountId, { timeoutMs: 40000 });

  let subscription = null;
  let subscriptionError = null;
  if (!pending) {
    try {
      if (strategyId) {
        subscription = await subscribeToStrategy(account, strategyId);
      } else {
        // Detach any prior CopyFactory mirrors so only Chart Scanner opens trades.
        subscription = await clearStrategySubscriptions(account);
      }
    } catch (error) {
      subscriptionError = error.message || "CopyFactory update failed";
    }
  }

  return sessionPayload(account || created, {
    login: userLogin,
    server: userServer,
    platform: mtPlatform === "mt4" ? "MT4" : "MT5",
    company: company || "",
    strategyId: strategyId || null,
    subscription,
    subscriptionError,
    pending,
  });
}

export async function getConnectionStatus(accountId, {
  strategyId = "",
  company = "",
} = {}) {
  const id = String(accountId || "").trim();
  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }

  const account = await getAccount(id);
  const connection = accountConnectionStatus(account);

  if (["WRONG_CREDENTIALS", "INVALID_ACCOUNT"].includes(connection)) {
    const err = new Error("Broker rejected the login credentials");
    err.status = 400;
    throw err;
  }

  let subscription = null;
  let subscriptionError = null;
  const pending = connection !== "CONNECTED";

  if (!pending) {
    try {
      if (strategyId) {
        subscription = await subscribeToStrategy(account, strategyId);
      } else {
        subscription = await clearStrategySubscriptions(account);
      }
    } catch (error) {
      subscriptionError = error.message || "CopyFactory update failed";
    }
  }

  let balance = null;
  let equity = null;
  let profit = null;
  let currency = null;
  if (!pending) {
    try {
      const { info } = await getAccountInformation(id, {
        region: accountRegion(account),
      });
      balance = info?.balance;
      equity = info?.equity;
      currency = info?.currency;
      // Prefer equity − balance (same as MT5). MetaAPI often omits / zeroes `profit`.
      profit = deriveFloatingProfit({
        balance,
        equity,
        profit: info?.profit,
      });
      if (profit == null || (profit === 0 && Number(equity) !== Number(balance))) {
        try {
          const fromPositions = await getOpenPositionsProfit(id, {
            region: accountRegion(account),
          });
          if (fromPositions != null) profit = fromPositions;
        } catch {
          // keep equity−balance / null
        }
      }
    } catch {
      // Metrics are best-effort — connection status still returns.
    }
  }

  return sessionPayload(account, {
    login: account?.login || "",
    server: account?.server || "",
    platform: account?.platform === "mt4" ? "MT4" : "MT5",
    company: company || account?.name || "",
    strategyId: strategyId || null,
    subscription,
    subscriptionError,
    pending,
    balance,
    equity,
    profit,
    currency,
  });
}

function clientApiBase(region) {
  const r = String(region || process.env.METAAPI_REGION || "new-york").trim() || "new-york";
  const template =
    process.env.METAAPI_CLIENT_URL_TEMPLATE ||
    "https://mt-client-api-v1.{region}.agiliumtrade.ai";
  return template.replace("{region}", r);
}

async function resolveAccountRegion(accountId, preferred) {
  if (preferred) return preferred;
  try {
    const account = await getAccount(accountId);
    return accountRegion(account) || process.env.METAAPI_REGION || "new-york";
  } catch {
    return process.env.METAAPI_REGION || "new-york";
  }
}

export async function listAccountSymbols(accountId, { region, token } = {}) {
  const resolvedRegion = await resolveAccountRegion(accountId, region);
  const url = `${clientApiBase(resolvedRegion)}/users/current/accounts/${encodeURIComponent(accountId)}/symbols`;
  const { data } = await metaFetch(url, { token });
  return { region: resolvedRegion, symbols: Array.isArray(data) ? data : [] };
}

export async function getSymbolSpecification(accountId, symbol, { region, token } = {}) {
  const resolvedRegion = await resolveAccountRegion(accountId, region);
  const url = `${clientApiBase(resolvedRegion)}/users/current/accounts/${encodeURIComponent(accountId)}/symbols/${encodeURIComponent(symbol)}/specification`;
  const { data } = await metaFetch(url, { token });
  return { region: resolvedRegion, spec: data };
}

function candidateSymbols(symbol) {
  const raw = String(symbol || "").trim();
  if (!raw) return [];
  const upper = raw.toUpperCase();
  const base = upper.replace(/\.MIC$/i, "").replace(/^\./, "");
  const out = [];
  const push = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  push(upper);
  push(`${base}.mic`);
  push(`.${base}.mic`);
  push(base);
  push(`${base}.r`);
  push(`${base}.i`);
  push(`${base}m`);
  return out;
}

export async function resolveTradeableSymbol(accountId, symbol, { region, token } = {}) {
  const resolvedRegion = await resolveAccountRegion(accountId, region);
  const { symbols } = await listAccountSymbols(accountId, { region: resolvedRegion, token });
  const symbolSet = new Set(symbols);
  const candidates = candidateSymbols(symbol).filter((s) => symbolSet.has(s));
  if (!candidates.length) {
    const err = new Error(
      `Symbol ${String(symbol || "").toUpperCase()} not found on this MT5 account`
    );
    err.status = 400;
    throw err;
  }

  let bestDisabled = null;
  for (const candidate of candidates) {
    try {
      const { spec } = await getSymbolSpecification(accountId, candidate, {
        region: resolvedRegion,
        token,
      });
      const mode = String(spec?.tradeMode || "");
      const disabled = mode === "SYMBOL_TRADE_MODE_DISABLED";
      const enabled =
        !disabled &&
        (mode === "SYMBOL_TRADE_MODE_FULL" ||
          mode === "SYMBOL_TRADE_MODE_LONGONLY" ||
          mode === "SYMBOL_TRADE_MODE_SHORTONLY" ||
          mode === "");
      const entry = {
        symbol: candidate,
        tradeMode: mode || "UNKNOWN",
        minVolume: Number(spec?.minVolume) || 0.01,
        volumeStep: Number(spec?.volumeStep) || 0.01,
        maxVolume: Number(spec?.maxVolume) || 100,
        fillingModes: Array.isArray(spec?.fillingModes) ? spec.fillingModes : [],
        enabled,
      };
      if (entry.enabled) return { region: resolvedRegion, ...entry };
      if (!bestDisabled) bestDisabled = entry;
    } catch {
      // try next candidate
    }
  }

  if (bestDisabled) {
    const err = new Error(
      `Trade disabled for ${bestDisabled.symbol}. Try ${String(symbol || "").toUpperCase()}.mic (Razor min lot often 0.1).`
    );
    err.status = 400;
    err.data = bestDisabled;
    throw err;
  }

  const err = new Error(`No tradeable symbol match for ${symbol}`);
  err.status = 400;
  throw err;
}

function normalizeVolume(volume, { minVolume, volumeStep, maxVolume }) {
  let vol = Number(volume);
  if (!Number.isFinite(vol) || vol <= 0) vol = minVolume;
  if (vol < minVolume) vol = minVolume;
  if (vol > maxVolume) vol = maxVolume;
  const step = volumeStep > 0 ? volumeStep : 0.01;
  const steps = Math.round(vol / step);
  vol = Number((steps * step).toFixed(8));
  if (vol < minVolume) vol = minVolume;
  return vol;
}

function isTradeSuccess(result) {
  if (!result || typeof result !== "object") return false;
  const code = String(result.stringCode || "");
  return (
    code === "TRADE_RETCODE_DONE" ||
    code === "TRADE_RETCODE_DONE_PARTIAL" ||
    Number(result.numericCode) === 10009
  );
}

export async function placeMarketTrade({
  accountId,
  symbol,
  volume = 0.01,
  side = "BUY",
  stopLoss,
  takeProfit,
  comment = "ApexEA scanner",
  region,
  token,
} = {}) {
  const id = String(accountId || "").trim();
  if (!id) {
    const err = new Error("accountId is required");
    err.status = 400;
    throw err;
  }

  const resolved = await resolveTradeableSymbol(id, symbol, { region, token });
  const vol = normalizeVolume(volume, resolved);
  const actionType =
    String(side).toUpperCase() === "SELL" ? "ORDER_TYPE_SELL" : "ORDER_TYPE_BUY";

  const body = {
    actionType,
    symbol: resolved.symbol,
    volume: vol,
    // Always capitalize the APEXEA brand tag in MT5 comments.
    comment: String(comment || "bot~APEXEA")
      .replace(/apexea/gi, "APEXEA")
      .slice(0, 31),
  };
  if (Number.isFinite(Number(stopLoss)) && Number(stopLoss) > 0) {
    body.stopLoss = Number(stopLoss);
  }
  if (Number.isFinite(Number(takeProfit)) && Number(takeProfit) > 0) {
    body.takeProfit = Number(takeProfit);
  }

  const url = `${clientApiBase(resolved.region)}/users/current/accounts/${encodeURIComponent(id)}/trade`;
  const { data } = await metaFetch(url, { method: "POST", body, token });

  if (!isTradeSuccess(data)) {
    const message =
      (data && (data.message || data.stringCode)) ||
      `Trade rejected for ${resolved.symbol}`;
    const err = new Error(message);
    err.status = 400;
    err.data = data;
    throw err;
  }

  return {
    ok: true,
    accountId: id,
    requestedSymbol: String(symbol || "").toUpperCase(),
    symbol: resolved.symbol,
    volume: vol,
    side: actionType === "ORDER_TYPE_SELL" ? "SELL" : "BUY",
    region: resolved.region,
    minVolume: resolved.minVolume,
    result: data,
  };
}

export async function findExistingAccount({ login, server } = {}) {
  const userLogin = String(login || "").trim();
  const userServer = String(server || "").trim();
  if (!userLogin || !userServer) return null;
  const { data } = await metaFetch(`${PROVISIONING_BASE}/users/current/accounts`);
  const list = Array.isArray(data) ? data : [];
  return (
    list.find(
      (account) =>
        String(account.login || "") === userLogin &&
        String(account.server || "").toLowerCase() === userServer.toLowerCase()
    ) || null
  );
}

const CLIENT_EMAIL_TAG_PREFIX = CLIENT_EMAIL_TAG;

export function clientEmailFromAccount(account) {
  const keywords = Array.isArray(account?.keywords) ? account.keywords : [];
  for (const raw of keywords) {
    const value = String(raw || "").trim();
    if (value.toLowerCase().startsWith(CLIENT_EMAIL_TAG_PREFIX)) {
      const email = normalizeClientEmail(value.slice(CLIENT_EMAIL_TAG_PREFIX.length));
      if (email.includes("@")) return email;
    }
  }
  const name = String(account?.name || "");
  const match = name.match(/apexea:([^\s|]+@[^\s|]+)/i);
  if (match) return normalizeClientEmail(match[1]);
  return "";
}

export async function listProvisionedAccounts({ token } = {}) {
  const { data } = await metaFetch(`${PROVISIONING_BASE}/users/current/accounts`, { token });
  return Array.isArray(data) ? data : [];
}

/** Deployed / broker-connected accounts mentors can trade on. */
export async function listConnectedTradingAccounts({ token } = {}) {
  const list = await listProvisionedAccounts({ token });
  return list.filter((account) => {
    const state = String(account?.state || "").toUpperCase();
    const connection = String(accountConnectionStatus(account) || "").toUpperCase();
    if (state === "UNDEPLOYED" || state === "DRAFT") return false;
    if (connection.includes("DISCONNECTED") && state !== "DEPLOYED") return false;
    return (
      state === "DEPLOYED" ||
      connection === "CONNECTED" ||
      connection === "CONNECTED_TO_BROKER" ||
      connection.includes("CONNECTED")
    );
  });
}

export async function tagAccountClientEmail(accountId, email, { token } = {}) {
  const id = String(accountId || "").trim();
  const clientEmail = normalizeClientEmail(email);
  if (!id || !clientEmail.includes("@")) return null;

  const account = await getAccount(id);
  const tag = `${CLIENT_EMAIL_TAG}${clientEmail}`;
  const keywords = Array.isArray(account?.keywords) ? account.keywords.map(String) : [];
  const nextKeywords = trimMetaApiKeywords([
    ...keywords.filter((k) => !String(k).toLowerCase().startsWith(CLIENT_EMAIL_TAG)),
    "apexea-client",
    tag,
  ]);
  const baseName = String(account?.name || `${account?.server || "MT5"} ${account?.login || ""}`)
    .replace(/\s*\|\s*apexea:[^\s|]+/gi, "")
    .trim();
  const name = `${baseName} | ${tag}`.trim();

  const { data } = await metaFetch(
    `${PROVISIONING_BASE}/users/current/accounts/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: { name, keywords: nextKeywords },
      token,
    }
  );
  return data || account;
}

export async function clearAccountClientEmail(accountId, { token } = {}) {
  const id = String(accountId || "").trim();
  if (!id) return null;
  try {
    const account = await getAccount(id);
    const keywords = (Array.isArray(account?.keywords) ? account.keywords : [])
      .map(String)
      .filter(
        (k) =>
          !k.toLowerCase().startsWith(CLIENT_EMAIL_TAG) &&
          k.toLowerCase() !== "apexea-client"
      );
    const name = String(account?.name || "")
      .replace(/\s*\|\s*apexea:[^\s|]+/gi, "")
      .trim();
    const { data } = await metaFetch(
      `${PROVISIONING_BASE}/users/current/accounts/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: { name, keywords },
        token,
      }
    );
    return data || account;
  } catch {
    return null;
  }
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  applyCorsHeaders(res);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}
