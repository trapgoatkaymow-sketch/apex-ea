import { clearLicenseRobotSession, listLicenses } from "../licenses/_lib.js";
import { listMentors } from "../mentors/_lib.js";
import {
  listMt5Accounts,
  normalizeMt5Account,
  removeMt5Account,
} from "../mt5-accounts/_lib.js";
import { enqueueTradeEvent } from "../trade-events/_lib.js";
import { endOptions } from "../_cors.js";
import {
  connectAccount as mt5ConnectAccount,
  disconnectAccount as mt5DisconnectAccount,
  getAccountStatus as mt5GetAccountStatus,
  pingBrokerApi,
  placeMarketTrade as mt5PlaceMarketTrade,
  readJsonBody,
  searchBrokers as mt5SearchBrokers,
  sendJson,
} from "../mt5/_lib.js";
import {
  connectTradingAccount as metaConnectAccount,
  getConnectionStatus as metaGetConnectionStatus,
  listProvisionedAccounts,
  placeMarketTrade as metaPlaceMarketTrade,
  searchKnownServers as metaSearchBrokers,
  undeployAccount as metaUndeployAccount,
} from "./_lib.js";

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

/** MetaAPI account ids are UUIDs; MT5API session tokens are opaque strings. */
function isMetaApiAccountId(accountId) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(accountId || "").trim()
  );
}

function isBrokerNetworkDown(error) {
  const status = Number(error?.status || 0);
  const msg = String(error?.message || "");
  return (
    status === 502 ||
    status === 504 ||
    /unreachable|timed?\s*out|timeout|ECONNREFUSED|ENOTFOUND|fetch failed|network is offline|Broker API/i.test(
      msg
    )
  );
}

async function pingMetaApi() {
  const started = Date.now();
  try {
    await listProvisionedAccounts();
    return {
      online: true,
      status: "online",
      provider: "metaapi",
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      message:
        "Trading network is online — connect MetaTrader in the app to search brokers and place trades.",
    };
  } catch (error) {
    return {
      online: false,
      status: "offline",
      provider: "metaapi",
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      message:
        "Broker connection service is temporarily unavailable. Please wait and try again shortly.",
      error: error?.message || "MetaAPI unreachable",
    };
  }
}

async function assertApprovedMentor(email) {
  const key = normalizeEmail(email);
  if (!key || !key.includes("@")) {
    const err = new Error("mentorEmail is required");
    err.status = 400;
    throw err;
  }
  const mentors = await listMentors();
  const mentor = mentors.find((row) => normalizeEmail(row.email) === key);
  if (!mentor) {
    const err = new Error("Mentor not found");
    err.status = 404;
    throw err;
  }
  if (mentor.status !== "approved" && mentor.role !== "superadmin") {
    const err = new Error("Mentor account is not approved");
    err.status = 403;
    throw err;
  }
  return mentor;
}

async function placeTradeOnAccount(opts) {
  const accountId = String(opts.accountId || "").trim();
  const times = Math.max(1, Math.min(20, Math.floor(Number(opts.count) || 1)));

  if (isMetaApiAccountId(accountId)) {
    const fills = [];
    for (let i = 0; i < times; i += 1) {
      const fill = await metaPlaceMarketTrade({
        accountId,
        symbol: opts.symbol,
        volume: opts.volume,
        side: opts.side,
        stopLoss: opts.stopLoss,
        takeProfit: opts.takeProfit,
        comment: opts.comment,
        region: opts.region || "",
      });
      fills.push(fill);
    }
    const last = fills[fills.length - 1];
    return {
      ok: true,
      provider: "metaapi",
      order: last?.result || last,
      orders: fills,
      tickets: fills
        .map((o) => o?.result?.orderId || o?.result?.positionId || o?.ticket || null)
        .filter((v) => v != null),
      count: fills.length,
      ticket: last?.result?.orderId || last?.result?.positionId || null,
      symbol: last?.symbol,
      volume: last?.volume,
      side: last?.side,
    };
  }

  try {
    return await mt5PlaceMarketTrade(opts);
  } catch (error) {
    if (isBrokerNetworkDown(error)) {
      const err = new Error(
        "Broker network is offline — open MetaTrader in the app and reconnect, then try again"
      );
      err.status = 503;
      err.code = "BROKER_OFFLINE";
      throw err;
    }
    throw error;
  }
}

export async function handleBrokers(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, `http://${host}`);
    const q = url.searchParams.get("q") || "";
    const platform = url.searchParams.get("platform") || "MT5";
    try {
      const brokers = await mt5SearchBrokers(q, platform);
      sendJson(res, 200, { brokers, provider: "mt5api" });
      return;
    } catch (error) {
      if (!isBrokerNetworkDown(error)) throw error;
      const brokers = await metaSearchBrokers(q, platform);
      sendJson(res, 200, { brokers, provider: "metaapi" });
    }
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Broker search failed",
      details: error.data || null,
    });
  }
}

export async function handleHealth(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const mt5 = await pingBrokerApi();
    if (mt5.online) {
      sendJson(res, 200, { ...mt5, provider: "mt5api" });
      return;
    }
    const meta = await pingMetaApi();
    sendJson(
      res,
      200,
      meta.online ? meta : { ...mt5, provider: "mt5api", fallback: meta }
    );
  } catch (error) {
    sendJson(res, 200, {
      online: false,
      status: "offline",
      checkedAt: Date.now(),
      message:
        "Broker connection service is temporarily unavailable. Please wait and try again shortly.",
      error: error?.message || "health check failed",
    });
  }
}

export async function handleConnect(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const payload = {
      login: body.login,
      password: body.password,
      server: body.server,
      platform: body.platform || "MT5",
      company: body.company || "",
      clientEmail: body.email || body.clientEmail || "",
    };

    try {
      const session = await mt5ConnectAccount(payload);
      sendJson(res, 200, session);
      return;
    } catch (error) {
      if (!isBrokerNetworkDown(error)) throw error;
      const session = await metaConnectAccount(payload);
      sendJson(res, 200, { ...session, provider: session.provider || "metaapi" });
    }
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: formatHandlerError(error, "Connection failed"),
      details: error.data || null,
    });
  }
}

function formatHandlerError(error, fallback) {
  const detailList = error?.data?.details;
  if (Array.isArray(detailList) && detailList.length) {
    const hints = detailList
      .map((row) => row?.message || row?.parameter)
      .filter(Boolean);
    if (hints.length) return hints.join(" ");
  }
  return error?.message || fallback;
}

export async function handleStatus(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, `http://${host}`);
    const accountId = url.searchParams.get("accountId") || "";
    const company = url.searchParams.get("company") || "";
    if (isMetaApiAccountId(accountId)) {
      const session = await metaGetConnectionStatus(accountId, { company });
      sendJson(res, 200, session);
      return;
    }
    try {
      const session = await mt5GetAccountStatus(accountId, { company });
      sendJson(res, 200, session);
    } catch (error) {
      if (isBrokerNetworkDown(error) && accountId) {
        try {
          const session = await metaGetConnectionStatus(accountId, { company });
          sendJson(res, 200, session);
          return;
        } catch {
          /* fall through */
        }
      }
      throw error;
    }
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Status check failed",
      details: error.data || null,
    });
  }
}

export async function handleTrade(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const source = String(body.source || "").trim().toLowerCase();
    if (source !== "chart-scanner" && source !== "premium-scanner") {
      const err = new Error("Trades can only be opened from Chart Scanner after a scan");
      err.status = 403;
      throw err;
    }
    const result = await placeTradeOnAccount({
      accountId: body.accountId,
      symbol: body.symbol,
      volume: body.volume,
      side: body.side || body.action || "BUY",
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit,
      comment: body.comment || "bot~APEXEA",
      region: body.region || "",
      count: body.count || body.trades || 1,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Trade failed",
      details: error.data || null,
    });
  }
}

export async function handleDisconnect(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const accountId = String(body.accountId || "").trim();
    if (!accountId) {
      sendJson(res, 400, { error: "accountId is required" });
      return;
    }
    let disconnected;
    if (isMetaApiAccountId(accountId)) {
      try {
        await metaUndeployAccount(accountId);
      } catch {
        // best-effort
      }
      disconnected = {
        accountId,
        provider: "metaapi",
        state: "UNDEPLOYED",
        connectionStatus: "DISCONNECTED",
        disconnected: true,
      };
    } else {
      try {
        disconnected = await mt5DisconnectAccount(accountId);
      } catch (error) {
        if (!isBrokerNetworkDown(error)) throw error;
        disconnected = {
          accountId,
          provider: "mt5api",
          state: "UNDEPLOYED",
          connectionStatus: "DISCONNECTED",
          disconnected: true,
        };
      }
    }
    const clientEmail = normalizeEmail(body.email || body.clientEmail || "");
    if (clientEmail.includes("@")) {
      try {
        await removeMt5Account(clientEmail);
      } catch {
        // registry cleanup is best-effort
      }
    }
    sendJson(res, 200, disconnected);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Disconnect failed",
      details: error.data || null,
    });
  }
}

export async function handleMentorTrade(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const mentor = await assertApprovedMentor(body.mentorEmail);
    const symbol = String(body.symbol || "")
      .trim()
      .toUpperCase();
    const side = String(body.side || body.action || "BUY")
      .trim()
      .toUpperCase();
    const volume = Number(body.volume);
    const rawSl = Number(body.stopLoss ?? body.sl);
    const rawTp = Number(body.takeProfit ?? body.tp);
    const stopLoss = Number.isFinite(rawSl) && rawSl > 0 ? rawSl : null;
    const takeProfit = Number.isFinite(rawTp) && rawTp > 0 ? rawTp : null;
    const takeProfits = [
      body.takeProfit1,
      body.takeProfit2,
      body.takeProfit3,
      body.tp1,
      body.tp2,
      body.tp3,
    ]
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
    const tradesCount = Math.max(
      1,
      Math.min(20, Math.floor(Number(body.tradesCount ?? body.count ?? body.trades ?? 1) || 1))
    );

    if (!symbol) {
      const err = new Error("Symbol is required");
      err.status = 400;
      throw err;
    }
    if (side !== "BUY" && side !== "SELL") {
      const err = new Error("Side must be BUY or SELL");
      err.status = 400;
      throw err;
    }

    const licenses = await listLicenses();
    const clientEmails = new Set(
      licenses
        .filter((row) => normalizeEmail(row.mentorEmail) === mentor.email)
        .map((row) => normalizeEmail(row.clientEmail))
        .filter(Boolean)
    );
    if (!clientEmails.size) {
      const err = new Error("No clients found for this mentor");
      err.status = 404;
      throw err;
    }

    const botMetaByClient = new Map();
    for (const row of licenses) {
      if (normalizeEmail(row.mentorEmail) !== mentor.email) continue;
      const clientEmail = normalizeEmail(row.clientEmail);
      if (!clientEmail) continue;
      const prev = botMetaByClient.get(clientEmail);
      const stamp = Number(row.usedAt || row.updatedAt || row.createdAt || 0);
      if (prev && prev.stamp >= stamp) continue;
      botMetaByClient.set(clientEmail, {
        stamp,
        botName:
          String(row.botName || row.bot?.name || row.clientName || "").trim() ||
          "Bot",
        mentorName: String(row.mentorName || mentor.username || "").trim(),
      });
    }

    const byEmail = new Map();

    const pushTarget = (row) => {
      const item = normalizeMt5Account(row);
      if (!item?.email || !item?.accountId) return;
      if (!clientEmails.has(item.email)) return;
      const prev = byEmail.get(item.email);
      if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) {
        byEmail.set(item.email, item);
      }
    };

    const rawClients = Array.isArray(body.clients)
      ? body.clients
      : Array.isArray(body.accounts)
        ? body.accounts
        : [];
    for (const row of rawClients) pushTarget(row);

    for (const row of licenses) {
      if (normalizeEmail(row.mentorEmail) !== mentor.email) continue;
      if (!row.robotAccountId) continue;
      pushTarget({
        email: row.clientEmail,
        accountId: row.robotAccountId,
        login: row.robotLogin,
        server: row.robotServer,
        company: row.robotCompany,
        platform: row.robotPlatform || "MT5",
        connectedAt: row.robotConnectedAt,
        updatedAt: row.updatedAt || row.robotConnectedAt,
      });
    }

    const registry = (await listMt5Accounts())
      .map((row) => normalizeMt5Account(row))
      .filter(Boolean);
    for (const row of registry) pushTarget(row);

    if (!byEmail.size) {
      try {
        const host =
          process.env.VERCEL_URL ||
          process.env.VERCEL_PROJECT_PRODUCTION_URL ||
          "www.apex-ea.com";
        const base = String(host).startsWith("http")
          ? String(host)
          : `https://${host}`;
        const res = await fetch(
          `${base}/api/mt5-accounts?mentorEmail=${encodeURIComponent(mentor.email)}`,
          { headers: { Accept: "application/json" }, cache: "no-store" }
        );
        if (res.ok) {
          const data = await res.json();
          for (const row of Array.isArray(data?.accounts) ? data.accounts : []) {
            pushTarget(row);
          }
        }
      } catch {
        // ignore
      }
    }

    const targets = Array.from(byEmail.values());

    if (!targets.length) {
      const err = new Error(
        "No connected robot clients yet. Clients must connect MetaTrader in the app first."
      );
      err.status = 404;
      throw err;
    }

    const lot = Number.isFinite(volume) && volume > 0 ? volume : 0.01;
    const comment = String(body.comment || "mentor~APEXEA")
      .replace(/apexea/gi, "APEXEA")
      .slice(0, 31);
    const results = [];
    let ordersPlaced = 0;

    for (const target of targets) {
      try {
        const fill = await placeTradeOnAccount({
          accountId: target.accountId,
          symbol,
          volume: lot,
          side,
          stopLoss,
          takeProfit,
          takeProfits: takeProfits.length ? takeProfits : undefined,
          comment,
          count: tradesCount,
        });
        const placedHere = Number(fill.count || tradesCount || 1);
        ordersPlaced += placedHere;
        results.push({
          ok: true,
          email: target.email,
          login: target.login,
          accountId: target.accountId,
          symbol: fill.symbol,
          volume: fill.volume,
          side: fill.side,
          trades: placedHere,
          tickets: fill.tickets || [],
          provider: fill.provider || null,
          result: fill.order || fill.result || null,
        });
        try {
          const meta = botMetaByClient.get(normalizeEmail(target.email)) || {};
          await enqueueTradeEvent({
            clientEmail: target.email,
            mentorEmail: mentor.email,
            mentorName: meta.mentorName || mentor.username || "",
            botName: meta.botName || "Bot",
            symbol: fill.symbol || symbol,
            side: fill.side || side,
            volume: fill.volume || lot,
            stopLoss,
            takeProfit,
            comment,
            source: "self-hosting",
            at: Date.now(),
          });
        } catch {
          // ignore enqueue failures
        }
      } catch (error) {
        const msg = String(error?.message || "Trade failed");
        const sessionDead =
          error?.code === "SESSION_EXPIRED" ||
          error?.code === "BROKER_OFFLINE" ||
          /session expired|reconnect|not connect|disconnect|network is offline/i.test(msg);
        results.push({
          ok: false,
          offline: sessionDead,
          email: target.email,
          login: target.login,
          accountId: target.accountId,
          error: msg,
          details: error.data || null,
        });
        if (sessionDead && target.email) {
          try {
            await removeMt5Account(target.email);
          } catch {
            /* best-effort */
          }
          try {
            await clearLicenseRobotSession(target.email);
          } catch {
            /* best-effort */
          }
        }
      }
    }

    const placedClients = results.filter((row) => row.ok).length;
    const failed = results.filter((row) => !row.ok).length;
    const offline = results.filter((row) => !row.ok && row.offline).length;
    const firstError = results.find((row) => !row.ok)?.error || "";
    sendJson(res, 200, {
      ok: ordersPlaced > 0,
      mentorEmail: mentor.email,
      symbol,
      side,
      volume: lot,
      tradesCount,
      stopLoss,
      takeProfit,
      targeted: targets.length,
      connected: targets.length,
      placed: ordersPlaced,
      placedClients,
      failed,
      offline,
      error: ordersPlaced > 0 ? "" : firstError || "No trades were placed",
      results,
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Mentor self-hosting trade failed",
      details: error.data || null,
    });
  }
}
