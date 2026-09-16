import { listLicenses } from "../licenses/_lib.js";
import { listMentors } from "../mentors/_lib.js";
import { listMt5Accounts, normalizeMt5Account } from "../mt5-accounts/_lib.js";
import { enqueueTradeEvent } from "../trade-events/_lib.js";
import { endOptions } from "../_cors.js";
import {
  clearAccountClientEmail,
  clientEmailFromAccount,
  connectTradingAccount,
  getConnectionStatus,
  getAccount,
  listConnectedTradingAccounts,
  placeMarketTrade,
  readJsonBody,
  searchKnownServers,
  sendJson,
  tagAccountClientEmail,
  tokenFromRequest,
  undeployAccount,
} from "./_lib.js";
import { removeMt5Account } from "../mt5-accounts/_lib.js";

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
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
    const token = tokenFromRequest(req);
    const brokers = await searchKnownServers(q, platform, { token });
    sendJson(res, 200, { brokers });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Broker search failed",
      details: error.data || null,
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
    const session = await connectTradingAccount({
      login: body.login,
      password: body.password,
      server: body.server,
      platform: body.platform || "MT5",
      company: body.company || "",
      clientEmail: body.email || body.clientEmail || "",
      strategyId: body.strategyId || "",
    });
    sendJson(res, 200, session);
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
    // Opt-in only — do not fall back to METAAPI_STRATEGY_ID.
    const strategyId = url.searchParams.get("strategyId") || "";
    const session = await getConnectionStatus(accountId, { strategyId, company });
    sendJson(res, 200, session);
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
    const token = tokenFromRequest(req);
    const source = String(body.source || "").trim().toLowerCase();
    // Chart Scanner only — Interface 1 (chart-scanner) and Interface 2 premium scanner.
    if (source !== "chart-scanner" && source !== "premium-scanner") {
      const err = new Error("Trades can only be opened from Chart Scanner after a scan");
      err.status = 403;
      throw err;
    }
    const result = await placeMarketTrade({
      accountId: body.accountId,
      symbol: body.symbol,
      volume: body.volume,
      side: body.side || body.action || "BUY",
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit,
      comment: body.comment || "bot~APEXEA",
      region: body.region,
      token,
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
    try {
      await undeployAccount(accountId);
    } catch {
      // ignore undeploy errors for UX disconnect
    }
    try {
      await clearAccountClientEmail(accountId);
    } catch {
      // ignore
    }
    const clientEmail = normalizeEmail(body.email || body.clientEmail || "");
    if (clientEmail.includes("@")) {
      try {
        await removeMt5Account(clientEmail);
      } catch {
        // registry cleanup is best-effort
      }
    }
    let account = null;
    try {
      account = await getAccount(accountId);
    } catch {
      account = null;
    }
    sendJson(res, 200, {
      accountId,
      state: account?.state || "UNDEPLOYED",
      disconnected: true,
    });
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
    // SL / TP are optional — market orders can run without protective levels.
    const rawSl = Number(body.stopLoss ?? body.sl);
    const rawTp = Number(body.takeProfit ?? body.tp);
    const stopLoss = Number.isFinite(rawSl) && rawSl > 0 ? rawSl : null;
    const takeProfit = Number.isFinite(rawTp) && rawTp > 0 ? rawTp : null;

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

    // Prefer newest used license per client for bot name on the app script.
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

    // Always fan out to every connected robot client for this mentor.
    // Prefer the shared MT5 registry, then MetaAPI accounts tagged with client email.
    const registry = (await listMt5Accounts())
      .map((row) => normalizeMt5Account(row))
      .filter(Boolean)
      .filter((row) => clientEmails.has(row.email));

    let live = [];
    try {
      const connected = await listConnectedTradingAccounts({ token: tokenFromRequest(req) });
      live = connected
        .map((account) => {
          const email = clientEmailFromAccount(account);
          if (!email || !clientEmails.has(email)) return null;
          return normalizeMt5Account({
            email,
            accountId: account.id || account._id,
            login: account.login,
            server: account.server,
            company: account.name,
            platform: account.platform === "mt4" ? "MT4" : "MT5",
            region: account.region || account.primaryReplica?.region || "",
            connectedAt: Date.now(),
            updatedAt: Date.now(),
          });
        })
        .filter(Boolean);
    } catch {
      live = [];
    }

    const byEmail = new Map();
    for (const row of [...registry, ...live]) {
      if (!row?.email || !row?.accountId) continue;
      byEmail.set(row.email, row);
    }
    const targets = Array.from(byEmail.values());

    if (!targets.length) {
      const err = new Error(
        "No connected robot clients yet. Clients must connect MetaTrader in the app first."
      );
      err.status = 404;
      throw err;
    }

    const token = tokenFromRequest(req);
    const lot = Number.isFinite(volume) && volume > 0 ? volume : 0.01;
    const comment = String(body.comment || "mentor~APEXEA")
      .replace(/apexea/gi, "APEXEA")
      .slice(0, 31);
    const results = [];

    for (const target of targets) {
      try {
        const fill = await placeMarketTrade({
          accountId: target.accountId,
          symbol,
          volume: lot,
          side,
          stopLoss,
          takeProfit,
          comment,
          region: target.region || body.region || "",
          token,
        });
        results.push({
          ok: true,
          email: target.email,
          login: target.login,
          accountId: target.accountId,
          symbol: fill.symbol,
          volume: fill.volume,
          side: fill.side,
          result: fill.result || null,
        });
        // Notify the client app script orb (best-effort — trade already placed).
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
        results.push({
          ok: false,
          offline: true,
          email: target.email,
          login: target.login,
          accountId: target.accountId,
          error: error.message || "Client offline or trade failed",
          details: error.data || null,
        });
      }
    }

    const placed = results.filter((row) => row.ok).length;
    const offline = results.filter((row) => !row.ok).length;
    sendJson(res, 200, {
      ok: placed > 0,
      mentorEmail: mentor.email,
      symbol,
      side,
      volume: lot,
      stopLoss,
      takeProfit,
      targeted: targets.length,
      connected: targets.length,
      placed,
      failed: offline,
      offline,
      results,
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Mentor self-hosting trade failed",
      details: error.data || null,
    });
  }
}
