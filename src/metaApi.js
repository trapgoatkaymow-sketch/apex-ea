import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/metaapi";

function formatApiError(data, status) {
  if (data && (data.error || data.message)) {
    const raw = data.error || data.message;
    if (typeof raw === "string") return raw;
  }
  return typeof data === "string" ? data : `Request failed (${status})`;
}

async function apiFetch(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(`${apiUrl(API_PATH)}${path}`, {
    method,
    signal,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
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

/**
 * Broker search via MT5API /Search only (proxied by /api/metaapi/brokers).
 * MetaAPI known-mt-servers is not used.
 */
export async function checkBrokerApiHealth({ signal } = {}) {
  return apiFetch("/health", { signal });
}

export async function searchBrokers(query, platform = "MT5", { signal } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  // Broken catalog entry — clients must use "Razor Markets", not "(Pty) Ltd".
  const isBlocked = (broker) =>
    /^razor\s*markets\s*\(pty\)\s*ltd\.?$/i.test(String(broker?.company || "").trim());

  const { searchLocalBrokers } = await import("./brokerCatalog.js");
  const local = searchLocalBrokers(q, platform).filter((b) => !isBlocked(b));

  try {
    const params = new URLSearchParams({
      q,
      platform: String(platform || "MT5").toUpperCase(),
    });
    const data = await apiFetch(`/brokers?${params.toString()}`, { signal });
    const remote = (Array.isArray(data?.brokers) ? data.brokers : []).filter(
      (b) => !isBlocked(b)
    );
    if (!remote.length) return local;
    const seen = new Set(remote.map((b) => `${b.company}::${b.name}`.toLowerCase()));
    const extras = local.filter((b) => !seen.has(`${b.company}::${b.name}`.toLowerCase()));
    return [...remote, ...extras];
  } catch (error) {
    if (local.length) return local;
    throw error;
  }
}

export async function getAccountStatus(accountId, { company = "", signal } = {}) {
  const params = new URLSearchParams({ accountId: String(accountId || "") });
  if (company) params.set("company", company);
  return apiFetch(`/status?${params.toString()}`, { signal });
}

/** Connect via MT5API ConnectEx (server-side). No MetaAPI pending poll. */
export async function connectAccount({
  login,
  password,
  server,
  platform = "MT5",
  company = "",
  signal,
  onProgress,
} = {}) {
  onProgress?.({ pending: true, connectionStatus: "CONNECTING" });
  const session = await apiFetch("/connect", {
    method: "POST",
    signal,
    body: {
      login,
      password,
      server,
      platform,
      company,
    },
  });
  onProgress?.(session);
  return session;
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

/** Close every open market position on the connected account. */
export async function closeAllPositions(accountId, { signal } = {}) {
  return apiFetch("/close-positions", {
    method: "POST",
    signal,
    body: {
      accountId: String(accountId || "").trim(),
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
 * Interface 2 (premium scanner): bot tag + |premium — never TPx.
 * Interface 1: bot tag only — never TPx.
 */
export function buildScannerFillComment({
  botName = "",
  variant = "default",
  premium = false,
} = {}) {
  const isPremium = Boolean(premium) || variant === "v2";
  const suffix = isPremium ? "|premium" : "";
  const prefix = buildTaggedBotPrefix(botName, 31 - suffix.length);
  return `${prefix}${suffix}`.slice(0, 31);
}

// Legacy no-ops — MetaAPI client token is unused with MT5API broker connect.
export function getClientMetaApiToken() {
  return "";
}
export function setClientMetaApiToken() {}
