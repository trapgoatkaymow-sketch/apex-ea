import { apiUrl, PROD_API_ORIGIN, isBareApexHost } from "./apiOrigin.js";

const API_PATH = "/api/metaapi";

/** Always hit www for connect — bare apex-ea.com 308s can stall POSTs. */
function connectApiUrl(path = "") {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (typeof window !== "undefined" && isBareApexHost(window.location?.hostname)) {
    return `${PROD_API_ORIGIN}${API_PATH}${p}`;
  }
  return `${apiUrl(API_PATH)}${p}`;
}

function formatApiError(data, status) {
  if (data && (data.error || data.message)) {
    const raw = data.error || data.message;
    if (typeof raw === "string") return raw;
  }
  if (status === 504 || status === 502) {
    return "Broker is still connecting — wait a moment and tap Connect again";
  }
  return typeof data === "string" && data.trim()
    ? data
    : `Request failed (${status})`;
}

function friendlyNetworkError(error, fallback = "Could not reach the broker server") {
  const raw = String(error?.message || error || "").trim();
  if (
    /^failed to fetch$/i.test(raw) ||
    /^load failed$/i.test(raw) ||
    /networkerror/i.test(raw) ||
    /network request failed/i.test(raw)
  ) {
    return "Could not reach the broker server — check connection and try again";
  }
  if (/abort|timed out|timeout/i.test(raw)) {
    return "Broker is slow to answer — wait a moment and tap Connect again";
  }
  return raw || fallback;
}

async function apiFetch(path, { method = "GET", body, signal, retries = 0 } = {}) {
  let response;
  try {
    response = await fetch(`${apiUrl(API_PATH)}${path}`, {
      method,
      signal,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (error) {
    if (retries > 0 && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 700));
      return apiFetch(path, { method, body, signal, retries: retries - 1 });
    }
    const err = new Error(friendlyNetworkError(error));
    err.cause = error;
    err.status = 0;
    throw err;
  }

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
    err.code =
      (data && typeof data === "object" && (data.code || data.errorCode)) ||
      null;
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

  // Never block the UI on a hung MT5 /Search (Razor was empty after ~10s).
  // Race a short remote window; local catalog always paints immediately.
  try {
    if (signal?.aborted) return local;
    const params = new URLSearchParams({
      q,
      platform: String(platform || "MT5").toUpperCase(),
    });
    const remotePromise = apiFetch(`/brokers?${params.toString()}`, { signal })
      .then((data) => ({ ok: true, data }))
      .catch((error) => ({ ok: false, error }));
    const timeoutPromise = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, timedOut: true }), 3500);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve({ ok: false, aborted: true });
        },
        { once: true }
      );
    });
    const outcome = await Promise.race([remotePromise, timeoutPromise]);
    if (!outcome?.ok) return local;
    const remote = (
      Array.isArray(outcome.data?.brokers) ? outcome.data.brokers : []
    ).filter((b) => !isBlocked(b));
    if (!remote.length) return local;
    const seen = new Set(
      remote.map((b) => `${b.company}::${b.name}`.toLowerCase())
    );
    const extras = local.filter(
      (b) => !seen.has(`${b.company}::${b.name}`.toLowerCase())
    );
    return [...remote, ...extras];
  } catch {
    return local;
  }
}

export async function getAccountStatus(accountId, { company = "", signal } = {}) {
  const params = new URLSearchParams({ accountId: String(accountId || "") });
  if (company) params.set("company", company);
  return apiFetch(`/status?${params.toString()}`, { signal });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectFetch(path, { method = "GET", body, signal } = {}) {
  let response;
  try {
    response = await fetch(connectApiUrl(path), {
      method,
      signal,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (error) {
    const err = new Error(friendlyNetworkError(error));
    err.cause = error;
    err.status = 0;
    throw err;
  }

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

/** Connect via MT5API ConnectEx (async job + poll — avoids Vercel 504). */
export async function connectAccount({
  login,
  password,
  server,
  platform = "MT5",
  company = "",
  signal,
  onProgress,
} = {}) {
  const startedAt = Date.now();
  onProgress?.({
    pending: true,
    connectionStatus: "CONNECTING",
    phase: "auth",
    elapsedMs: 0,
  });
  let started;
  try {
    started = await connectFetch("/connect", {
      method: "POST",
      signal,
      body: {
        login,
        password,
        server,
        platform,
        company,
        async: true,
      },
    });
  } catch (error) {
    // Credential / server errors finish inside the first hop — surface them.
    if (Number(error?.status) > 0 && Number(error?.status) !== 202) {
      throw error;
    }
    throw error;
  }

  // Fast brokers finish inside the first response.
  if (started?.accountId && started?.pending !== true) {
    onProgress?.(started);
    return started;
  }

  const jobId = String(started?.jobId || "").trim();
  if (!jobId) {
    const err = new Error(
      started?.error || "Could not start broker connection"
    );
    err.status = 500;
    throw err;
  }

  // Poll up to ~2.5 minutes — Razor/XM cold ConnectEx can be slow.
  const deadline = Date.now() + 150_000;
  let lastError = "";
  let misses = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      const err = new Error("Connection cancelled");
      err.status = 499;
      throw err;
    }
    const elapsedMs = Date.now() - startedAt;
    const phase =
      elapsedMs < 20_000 ? "provision" : elapsedMs < 60_000 ? "handshake" : "arm";
    onProgress?.({
      pending: true,
      connectionStatus: "CONNECTING",
      jobId,
      phase,
      elapsedMs,
    });
    await sleep(elapsedMs < 30_000 ? 1500 : 2500);
    try {
      const data = await connectFetch(
        `/connect?jobId=${encodeURIComponent(jobId)}`,
        { signal }
      );
      misses = 0;
      if (data?.accountId && data?.pending !== true) {
        onProgress?.(data);
        return data;
      }
      if (data?.status === "failed" || (data?.error && data?.pending === false)) {
        const err = new Error(data.error || "Connection failed");
        err.status = data.errorStatus || 500;
        throw err;
      }
    } catch (error) {
      // 202 Accepted while still running — connectFetch treats 202 as ok and
      // returns the body. Real failures throw.
      if (Number(error?.status) === 404) {
        misses += 1;
        lastError = error.message || "Connect job not found";
        if (misses >= 8) throw error;
        continue;
      }
      if (Number(error?.status) >= 400) throw error;
      lastError = error.message || lastError;
    }
  }

  const err = new Error(
    lastError ||
      "Broker is still connecting — wait a moment and tap Connect again"
  );
  err.status = 504;
  throw err;
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

/**
 * Check whether opening `side` on `symbol` conflicts with open positions.
 * Returns { ok: true } or { ok: false, error, code, details }.
 */
export async function checkTradeDirection({
  accountId,
  symbol,
  side = "BUY",
  signal,
} = {}) {
  const data = await apiFetch("/positions", {
    method: "POST",
    signal,
    body: {
      accountId: String(accountId || "").trim(),
      symbol: String(symbol || "").trim(),
      side: String(side || "BUY").trim().toUpperCase() === "SELL" ? "SELL" : "BUY",
    },
  });
  return {
    ok: data?.ok !== false,
    positions: Array.isArray(data?.positions) ? data.positions : [],
    error: data?.error || null,
    code: data?.code || null,
    details: data?.details || null,
  };
}

/** Live bid/ask/mid for a connected account symbol. */
export async function getSymbolQuote({
  accountId,
  symbol,
  side = "BUY",
  fast = false,
  signal,
} = {}) {
  return apiFetch("/quote", {
    method: "POST",
    signal,
    body: {
      accountId: String(accountId || "").trim(),
      symbol: String(symbol || "").trim(),
      side: String(side || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
      fast: Boolean(fast),
    },
  });
}

/** OHLC bars from the connected MT5 account (Live Chart + Safe Scalper). */
export async function getPriceHistory({
  accountId,
  symbol,
  timeFrame = 30,
  fast = true,
  days = 14,
  signal,
} = {}) {
  return apiFetch("/history", {
    method: "POST",
    signal,
    body: {
      accountId: String(accountId || "").trim(),
      symbol: String(symbol || "").trim(),
      timeFrame: Math.max(1, Math.floor(Number(timeFrame) || 30)),
      days: Math.max(2, Math.min(30, Math.floor(Number(days) || 14))),
      fast: Boolean(fast),
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
  takeProfits,
  count = 1,
  comment = "bot~APEXEA",
  region = "",
  source = "chart-scanner",
  signal,
} = {}) {
  const tpList = Array.isArray(takeProfits)
    ? takeProfits.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
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
      ...(tpList.length ? { takeProfits: tpList } : {}),
      count: Math.max(1, Math.min(100, Math.floor(Number(count) || 1))),
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
