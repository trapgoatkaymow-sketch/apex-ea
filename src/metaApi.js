import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/metaapi";
const TOKEN_KEY = "apexea-metaapi-token";

export function getClientMetaApiToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setClientMetaApiToken(token) {
  try {
    const value = String(token || "").trim();
    if (!value) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // ignore
  }
}

function formatApiError(data, status) {
  const nested = data?.details?.details;
  if (Array.isArray(nested) && nested.length) {
    const hints = nested.map((row) => row?.message || row?.parameter).filter(Boolean);
    if (hints.length) return hints.join(" ");
  }
  const top = data?.details;
  if (Array.isArray(top) && top.length) {
    const hints = top.map((row) => row?.message || row?.parameter).filter(Boolean);
    if (hints.length) return hints.join(" ");
  }
  if (data && (data.error || data.message)) {
    const raw = data.error || data.message;
    if (typeof raw === "string" && /^Validation failed \([a-f0-9]{32}\)$/i.test(raw)) {
      return "Broker connection failed. Check login, password, and server name.";
    }
    return raw;
  }
  return typeof data === "string" ? data : `Request failed (${status})`;
}

async function apiFetch(path, { method = "GET", body, signal } = {}) {
  const clientToken = getClientMetaApiToken();
  const response = await fetch(`${apiUrl(API_PATH)}${path}`, {
    method,
    signal,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(clientToken ? { "x-metaapi-token": clientToken } : {}),
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
    const message = formatApiError(data, response.status);
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function searchBrokers(query, platform = "MT5", { signal } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  // Always include local catalog so search works even if remote broker APIs are down.
  const { searchLocalBrokers } = await import("./brokerCatalog.js");
  const local = searchLocalBrokers(q, platform);

  // Prefer MT5API Swagger /Search (direct or /mt5-api proxy) — real logos + access hosts.
  try {
    const { searchBrokersMt5 } = await import("./mt5Api.js");
    const fromMt5 = await searchBrokersMt5(q, platform, { signal });
    if (fromMt5.length) {
      const seen = new Set(
        fromMt5.map((b) => `${b.company}::${b.name}`.toLowerCase())
      );
      const extras = local.filter(
        (b) => !seen.has(`${b.company}::${b.name}`.toLowerCase())
      );
      return [...fromMt5, ...extras];
    }
  } catch {
    // Fall through to server MetaAPI path.
  }

  try {
    const params = new URLSearchParams({
      q,
      platform: String(platform || "MT5").toUpperCase(),
    });
    // Server hits MT5API /Search first, then MetaAPI known-mt-servers fallback.
    const data = await apiFetch(`/brokers?${params.toString()}`, { signal });
    const remote = Array.isArray(data?.brokers) ? data.brokers : [];
    if (!remote.length) return local;

    const seen = new Set(remote.map((b) => `${b.company}::${b.name}`.toLowerCase()));
    const extras = local.filter((b) => !seen.has(`${b.company}::${b.name}`.toLowerCase()));
    return [...remote, ...extras];
  } catch {
    return local;
  }
}

export async function getAccountStatus(accountId, { company = "", strategyId = "", signal } = {}) {
  const params = new URLSearchParams({ accountId: String(accountId || "") });
  if (company) params.set("company", company);
  if (strategyId) params.set("strategyId", strategyId);
  return apiFetch(`/status?${params.toString()}`, { signal });
}

export async function connectAccount({
  login,
  password,
  server,
  platform = "MT5",
  company = "",
  email = "",
  strategyId = "",
  signal,
  onProgress,
} = {}) {
  const initial = await apiFetch("/connect", {
    method: "POST",
    signal,
    body: {
      login,
      password,
      server,
      platform,
      company,
      email,
      clientEmail: email,
      strategyId,
    },
  });

  if (!initial?.pending) return initial;

  onProgress?.(initial);

  const started = Date.now();
  const timeoutMs = 4 * 60 * 1000;

  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error("Connection cancelled");
    await sleep(4000);
    const status = await getAccountStatus(initial.accountId, {
      company: company || initial.company || "",
      strategyId: strategyId || initial.strategyId || "",
      signal,
    });
    onProgress?.(status);
    if (!status.pending && status.connectionStatus === "CONNECTED") {
      return status;
    }
  }

  throw new Error("Timed out waiting for MetaTrader connection");
}

export async function disconnectAccount(accountId, { email = "", signal } = {}) {
  return apiFetch("/disconnect", {
    method: "POST",
    signal,
    body: {
      accountId,
      email: String(email || "")
        .trim()
        .toLowerCase(),
    },
  });
}

export async function placeTrade({
  accountId,
  symbol,
  volume = 0.01,
  side = "BUY",
  stopLoss,
  takeProfit,
  comment = "bot~APEXEA",
  region = "",
  source = "chart-scanner",
  signal,
} = {}) {
  return apiFetch("/trade", {
    method: "POST",
    signal,
    body: {
      accountId,
      symbol,
      volume,
      side,
      stopLoss,
      takeProfit,
      comment,
      region,
      source,
    },
  });
}

/** MT5 comment for scanner fills — e.g. zeta~APEXEA (max 31 chars). */
export function buildBotTradeComment(botName) {
  return buildTaggedBotPrefix(botName, 31);
}

/** Always keep the full ~APEXEA brand; trim the bot name if space is tight. */
function buildTaggedBotPrefix(botName, maxLen = 31) {
  const brand = "~APEXEA";
  const limit = Math.max(brand.length + 1, Math.min(31, Number(maxLen) || 31));
  const nameRoom = Math.max(1, limit - brand.length);
  const raw = String(botName || "bot")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9._~\-]/g, "")
    .replace(/~apexea$/i, "");
  const name = (raw || "bot").slice(0, nameRoom);
  return `${name}${brand}`;
}

/**
 * Per-fill MT5 comment (max 31 chars).
 * Interface 2 (premium scanner): always includes the word "premium".
 * Interface 1: bot tag + TPx only (e.g. …|TP1) — no premium, no T1/T2 index.
 * The brand tag is always the full "APEXEA" (never truncated to "APEXE").
 */
export function buildScannerFillComment({
  botName = "",
  variant = "default",
  premium = false,
  target = "TP1",
  tradeNo = 1,
} = {}) {
  const tp =
    String(target || "TP1")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4) || "TP1";
  const isPremium = Boolean(premium) || variant === "v2";
  const suffix = isPremium ? `|premium|${tp}` : `|${tp}`;
  const prefix = buildTaggedBotPrefix(botName, 31 - suffix.length);
  return `${prefix}${suffix}`.slice(0, 31);
}
