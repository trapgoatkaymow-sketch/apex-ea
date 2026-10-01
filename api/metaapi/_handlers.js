import { waitUntil } from "@vercel/functions";
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
  normalizeBrokerSymbol,
  sameInstrumentFamily,
  symbolCore,
} from "../_symbolResolve.js";
import {
  assertNoOppositeDirection as mt5AssertNoOppositeDirection,
  closeAllPositions as mt5CloseAllPositions,
  connectAccount as mt5ConnectAccount,
  disconnectAccount as mt5DisconnectAccount,
  getAccountStatus as mt5GetAccountStatus,
  listOpenMarketPositions as mt5ListOpenMarketPositions,
  pingBrokerApi,
  getSymbolQuote as mt5GetSymbolQuote,
  getPriceHistoryToday as mt5GetPriceHistoryToday,
  placeMarketTrade as mt5PlaceMarketTrade,
  readJsonBody,
  searchBrokers as mt5SearchBrokers,
  sendJson,
} from "../mt5/_lib.js";
import {
  dequeueSelfHostJobId,
  enqueueSelfHostJobId,
  getSelfHostJob,
  kickSelfHostJobContinue,
  newSelfHostJobId,
  publicSelfHostJob,
  saveSelfHostJob,
  updateSelfHostJob,
} from "./_selfHostJobs.js";

/** Clients processed per serverless hop so large fan-outs outlive maxDuration. */
const SELF_HOST_BATCH_SIZE = Math.max(
  3,
  Math.min(20, Number(process.env.SELF_HOST_BATCH_SIZE) || 10)
);
/** Leave headroom before maxDuration (120s) to persist + chain the next hop. */
const SELF_HOST_HOP_BUDGET_MS = Math.max(
  20_000,
  Math.min(105_000, Number(process.env.SELF_HOST_HOP_BUDGET_MS) || 90_000)
);
const SELF_HOST_HARD_CAP_MS = Math.max(
  SELF_HOST_HOP_BUDGET_MS,
  Math.min(115_000, Number(process.env.SELF_HOST_HARD_CAP_MS) || 105_000)
);

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
    // Brokers come ONLY from MT5API /Search (http://66.23.225.158) — no MetaAPI.
    const brokers = await mt5SearchBrokers(q, platform);
    sendJson(res, 200, { brokers });
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
    const health = await pingBrokerApi();
    sendJson(res, 200, health);
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
    const session = await mt5ConnectAccount({
      login: body.login,
      password: body.password,
      server: body.server,
      platform: body.platform || "MT5",
      company: body.company || "",
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
    const session = await mt5GetAccountStatus(accountId, { company });
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
    const source = String(body.source || "").trim().toLowerCase();
    // Chart Scanner only — Interface 1 (chart-scanner) and Interface 2 premium scanner.
    if (source !== "chart-scanner" && source !== "premium-scanner") {
      const err = new Error("Trades can only be opened from Chart Scanner after a scan");
      err.status = 403;
      throw err;
    }
    const tpList = Array.isArray(body.takeProfits)
      ? body.takeProfits.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const result = await mt5PlaceMarketTrade({
      accountId: body.accountId,
      symbol: body.symbol,
      volume: body.volume,
      side: body.side || body.action || "BUY",
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit,
      takeProfits: tpList.length ? tpList : undefined,
      count: body.count ?? body.trades ?? body.times ?? 1,
      comment: body.comment || "bot~APEXEA",
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Trade failed",
      code: error.code || null,
      details: error.data || null,
    });
  }
}

/** List open market positions (symbol + side) for opposite-direction guards. */
export async function handleOpenPositions(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    const body =
      req.method === "POST"
        ? await readJsonBody(req)
        : Object.fromEntries(url.searchParams);
    const accountId = String(body.accountId || "").trim();
    if (!accountId) {
      sendJson(res, 400, { error: "accountId is required" });
      return;
    }
    const positions = await mt5ListOpenMarketPositions(accountId);
    const symbol = String(body.symbol || "").trim();
    const side = String(body.side || body.action || "")
      .trim()
      .toUpperCase();
    if (symbol && (side === "BUY" || side === "SELL")) {
      try {
        await mt5AssertNoOppositeDirection(accountId, symbol, side);
        sendJson(res, 200, { positions, ok: true });
        return;
      } catch (error) {
        if (error?.code === "OPPOSITE_DIRECTION") {
          sendJson(res, 200, {
            positions,
            ok: false,
            code: error.code,
            error: error.message,
            details: error.data || null,
          });
          return;
        }
        throw error;
      }
    }
    sendJson(res, 200, { positions, ok: true });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Could not load open positions",
      code: error.code || null,
      details: error.data || null,
    });
  }
}

/** Live quote for silent START / scanner-aligned opens. */
export async function handleQuote(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  try {
    const body =
      req.method === "POST"
        ? await readJsonBody(req)
        : Object.fromEntries(new URL(req.url, "http://local").searchParams);
    const result = await mt5GetSymbolQuote(body.accountId, body.symbol, {
      side: body.side || body.action || "BUY",
      fast: body.fast === true || body.fast === "1" || body.fast === 1,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Quote failed",
      details: error.data || null,
    });
  }
}

/** OHLC bars for Safe Scalper START when OpenAI is offline. */
export async function handleHistory(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  try {
    const body =
      req.method === "POST"
        ? await readJsonBody(req)
        : Object.fromEntries(new URL(req.url, "http://local").searchParams);
    const result = await mt5GetPriceHistoryToday(body.accountId, body.symbol, {
      timeFrame: body.timeFrame ?? body.timeframe ?? 30,
      fast: body.fast === true || body.fast === "1" || body.fast === 1,
    });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "History failed",
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
    const disconnected = await mt5DisconnectAccount(accountId);
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

/** Close every open market position on the connected MT5/MT4 account. */
export async function handleClosePositions(req, res) {
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
    const result = await mt5CloseAllPositions(accountId);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Close positions failed",
      code: error.code || null,
      details: error.data || null,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeAllowedSymbols(list) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .map((s) => normalizeBrokerSymbol(s) || String(s || "").trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
}

/** True when the mentor's self-host symbol is on this client's EA allow-list. */
function isSymbolAllowedOnClientEa(requested, allowedList) {
  const want = normalizeBrokerSymbol(requested);
  if (!want) return false;
  const allowed = normalizeAllowedSymbols(allowedList);
  if (!allowed.length) return false;
  const wantCore = symbolCore(want);
  return allowed.some((entry) => {
    if (!entry) return false;
    if (sameInstrumentFamily(want, entry)) return true;
    return symbolCore(entry) === wantCore;
  });
}

async function resolveMentorTradeTargets({ mentor, body, licenses }) {
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

  const botMetaByClient = {};
  for (const row of licenses) {
    if (normalizeEmail(row.mentorEmail) !== mentor.email) continue;
    const clientEmail = normalizeEmail(row.clientEmail);
    if (!clientEmail) continue;
    const prev = botMetaByClient[clientEmail];
    const stamp = Number(
      row.clientSymbolsUpdatedAt ||
        row.usedAt ||
        row.updatedAt ||
        row.createdAt ||
        0
    );
    // Prefer the newest used key; once we have clientSymbols, do not let an
    // older empty template wipe a fresher allow-list.
    const clientSymbols = normalizeAllowedSymbols(row.clientSymbols);
    const botSymbols = normalizeAllowedSymbols(row.bot?.symbols);
    const symbols = clientSymbols.length ? clientSymbols : botSymbols;
    if (prev) {
      const prevHasClient = Number(prev.clientSymbolsUpdatedAt || 0) > 0;
      const nextHasClient = Number(row.clientSymbolsUpdatedAt || 0) > 0;
      if (prevHasClient && !nextHasClient) continue;
      if (prev.stamp >= stamp && !(nextHasClient && !prevHasClient)) continue;
    }
    botMetaByClient[clientEmail] = {
      stamp,
      clientSymbolsUpdatedAt: Number(row.clientSymbolsUpdatedAt || 0) || 0,
      botName:
        String(row.botName || row.bot?.name || row.clientName || "").trim() ||
        "Bot",
      mentorName: String(row.mentorName || mentor.username || "").trim(),
      symbols,
    };
  }

  // Targets: portal clients[] → license robot sessions → mt5 registry → API fallback
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
  return { targets, botMetaByClient };
}

/** MT5 comment from the client's EA name — never "mentor" / "admin". */
function buildSelfHostEaComment(botName) {
  const brand = "~APEXEA";
  const nameRoom = Math.max(1, 31 - brand.length);
  let raw = String(botName || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^a-zA-Z0-9._~\-]/g, "")
    .replace(/~apexea$/i, "");
  // Strip legacy self-host prefixes if a bad comment leaked into botName.
  raw = raw.replace(/^(mentor|admin)[~_\-]*/i, "");
  if (!raw || /^(mentor|admin)$/i.test(raw)) raw = "bot";
  return `${raw.slice(0, nameRoom)}${brand}`.slice(0, 31);
}

async function placeOneSelfHostTrade({
  target,
  job,
  botMetaByClient,
}) {
  const {
    symbol,
    side,
    volume: lot,
    tradesCount,
    stopLoss,
    takeProfit,
    takeProfits = [],
    mentorEmail,
    mentorUsername = "",
    hostedByAdmin = "",
  } = job;
  const meta = botMetaByClient?.[normalizeEmail(target.email)] || {};
  const tradeComment = buildSelfHostEaComment(meta.botName || "bot");
  const allowedSymbols = normalizeAllowedSymbols(meta.symbols);
  if (!isSymbolAllowedOnClientEa(symbol, allowedSymbols)) {
    const want = normalizeBrokerSymbol(symbol) || String(symbol || "").trim();
    return {
      row: {
        ok: false,
        skipped: true,
        email: target.email,
        login: target.login,
        accountId: target.accountId,
        symbol: want,
        error: allowedSymbols.length
          ? `Symbol not allowed on EA (${want}). Allowed: ${allowedSymbols.join(", ")}`
          : `Symbol not allowed on EA (${want}) — client has no pairs on this EA`,
      },
      placedHere: 0,
    };
  }
  try {
    const fill = await mt5PlaceMarketTrade({
      accountId: target.accountId,
      symbol,
      volume: lot,
      side,
      stopLoss,
      takeProfit,
      takeProfits: takeProfits.length ? takeProfits : undefined,
      comment: tradeComment,
      count: tradesCount,
    });
    const placedHere = Number(fill.count || tradesCount || 1);
    const row = {
      ok: true,
      email: target.email,
      login: target.login,
      accountId: target.accountId,
      symbol: fill.symbol,
      volume: fill.volume,
      side: fill.side,
      trades: placedHere,
      tickets: fill.tickets || [],
      result: fill.order || fill.result || null,
      comment: tradeComment,
    };
    try {
      await enqueueTradeEvent({
        clientEmail: target.email,
        mentorEmail,
        mentorName: meta.mentorName || mentorUsername || "",
        botName: meta.botName || "Bot",
        symbol: fill.symbol || symbol,
        side: fill.side || side,
        volume: fill.volume || lot,
        stopLoss,
        takeProfit,
        comment: tradeComment,
        source: hostedByAdmin ? "admin-self-hosting" : "self-hosting",
        hostedByAdmin: hostedByAdmin || undefined,
        at: Date.now(),
      });
    } catch {
      // ignore enqueue failures
    }
    return { row, placedHere };
  } catch (error) {
    const msg = String(error?.message || "Trade failed");
    const sessionDead =
      error?.code === "SESSION_EXPIRED" ||
      /session expired|reconnect|not connect|disconnect/i.test(msg);
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
    return {
      row: {
        ok: false,
        offline: sessionDead,
        email: target.email,
        login: target.login,
        accountId: target.accountId,
        error: msg,
        details: error.data || null,
      },
      placedHere: 0,
    };
  }
}

/**
 * Resolve connected MT5 targets for a stub job. Done inside the hop so the
 * portal POST can return 202 immediately (iOS aborts slow mentor-trade calls).
 */
async function ensureSelfHostJobTargets(job) {
  if (!job?.id) return job;
  const existing = Array.isArray(job.targets) ? job.targets : [];
  if (existing.length && !job.resolveTargets) return job;

  const mentorEmail = normalizeEmail(job.mentorEmail);
  if (!mentorEmail) {
    return updateSelfHostJob(job.id, {
      status: "failed",
      resolveTargets: false,
      error: "mentorEmail is required",
      finishedAt: Date.now(),
      leaseUntil: 0,
      leaseOwner: "",
    });
  }

  const licenses = await listLicenses();
  const mentor = {
    email: mentorEmail,
    username: job.mentorUsername || "",
  };
  try {
    const { targets, botMetaByClient } = await resolveMentorTradeTargets({
      mentor,
      body: {
        clients: Array.isArray(job.clientTips) ? job.clientTips : [],
      },
      licenses,
    });
    return updateSelfHostJob(job.id, {
      targets,
      botMetaByClient,
      targeted: targets.length,
      resolveTargets: false,
      clientTips: [],
      error: "",
    });
  } catch (error) {
    return updateSelfHostJob(job.id, {
      status: "failed",
      resolveTargets: false,
      targeted: 0,
      targets: [],
      error: error?.message || "No connected robot clients",
      finishedAt: Date.now(),
      leaseUntil: 0,
      leaseOwner: "",
    });
  }
}

/**
 * Process one hop of a durable self-host job. Chains another hop when needed
 * so portal close / MetaTrader switch cannot abort the fan-out.
 */
export async function processSelfHostJobHop(
  jobId,
  { req = null, force = false } = {}
) {
  const started = Date.now();
  let job = await getSelfHostJob(jobId, { preferRemote: true });
  if (!job) return { ok: false, reason: "job-not-found" };
  if (job.status === "cancelled") {
    await dequeueSelfHostJobId(jobId);
    return { ok: true, status: "cancelled" };
  }
  if (job.status === "done" || job.status === "failed") {
    await dequeueSelfHostJobId(jobId);
    return { ok: true, status: job.status };
  }

  // Soft lease so overlapping cron/portal kicks cannot double-place.
  // `force` may steal only when the lease is missing/expired — never while
  // another hop still holds a live lease (that was resetting cursor to 0).
  const leaseUntil = Number(job.leaseUntil || 0);
  const leaseLive = leaseUntil > Date.now() + 1_500;
  if (leaseLive) {
    return { ok: true, status: "leased" };
  }
  const leaseOwner = `hop_${started}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    job = await updateSelfHostJob(jobId, {
      leaseUntil: Date.now() + SELF_HOST_HOP_BUDGET_MS + 20_000,
      leaseOwner,
    });
  } catch (error) {
    return { ok: false, reason: error?.message || "lease-update-failed" };
  }

  const runAt = Number(job.runAt || 0);
  if (runAt > Date.now()) {
    job = await updateSelfHostJob(jobId, { status: "scheduled" });
    const waitMs = Math.min(SELF_HOST_HOP_BUDGET_MS, runAt - Date.now());
    if (waitMs > 250) await sleep(waitMs);
    if (Date.now() < runAt) {
      await updateSelfHostJob(jobId, { leaseUntil: 0, leaseOwner: "" });
      await kickSelfHostJobContinue({ jobId, req, delayMs: 0, force: true });
      return { ok: true, status: "scheduled", chained: true };
    }
  }

  // Lazy roster resolve — portal never waits on 600+ license lookups.
  if (job.resolveTargets || !Array.isArray(job.targets) || !job.targets.length) {
    job = await ensureSelfHostJobTargets(job);
    if (!job || job.status === "failed") {
      await dequeueSelfHostJobId(jobId);
      return { ok: false, reason: "resolve-failed", status: "failed" };
    }
  }

  job = await updateSelfHostJob(jobId, { status: "running" });
  const targets = Array.isArray(job.targets) ? job.targets : [];
  const expected = Number(job.targeted || targets.length || 0);
  // Guard: never finish as "done/failed" if the roster failed to load.
  if (!targets.length && (expected > 0 || job.resolveTargets)) {
    await updateSelfHostJob(jobId, {
      leaseUntil: 0,
      leaseOwner: "",
      error: "Target roster missing — retrying",
    });
    await kickSelfHostJobContinue({ jobId, req, delayMs: 1500, force: true });
    return { ok: false, reason: "targets-missing", chained: true };
  }
  if (!targets.length) {
    await updateSelfHostJob(jobId, {
      status: "failed",
      leaseUntil: 0,
      leaseOwner: "",
      finishedAt: Date.now(),
      error: "No connected robot clients yet",
    });
    await dequeueSelfHostJobId(jobId);
    return { ok: false, reason: "no-targets", status: "failed" };
  }

  let cursor = Math.max(0, Number(job.cursor || 0));
  let results = Array.isArray(job.results) ? [...job.results] : [];
  let placed = Number(job.placed || 0);
  const botMetaByClient = job.botMetaByClient || {};
  const concurrency = Math.max(
    1,
    Math.min(6, Number(process.env.SELF_HOST_CONCURRENCY) || 4)
  );

  while (cursor < targets.length) {
    if (Date.now() - started > SELF_HOST_HOP_BUDGET_MS) break;
    const batchEnd = Math.min(targets.length, cursor + SELF_HOST_BATCH_SIZE);
    const slice = targets.slice(cursor, batchEnd);
    // Place a few clients in parallel — serial fan-out was too slow for 600+.
    for (let i = 0; i < slice.length; i += concurrency) {
      if (Date.now() - started > SELF_HOST_HOP_BUDGET_MS) break;
      const group = slice.slice(i, i + concurrency);
      const settled = await Promise.all(
        group.map(async (target) => {
          if (!target?.accountId) {
            return {
              row: {
                ok: false,
                email: target?.email || "",
                error: "Missing accountId",
              },
              placedHere: 0,
            };
          }
          return placeOneSelfHostTrade({ target, job, botMetaByClient });
        })
      );
      for (const item of settled) {
        results.push(item.row);
        placed += Number(item.placedHere || 0);
      }
      cursor += group.length;
    }
    const placedClients = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    const offline = results.filter((r) => !r.ok && r.offline).length;
    job = await updateSelfHostJob(jobId, {
      status: "running",
      cursor,
      placed,
      placedClients,
      failed,
      offline,
      results,
      error: "",
    });
  }

  if (targets.length && cursor >= targets.length) {
    const placedClients = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    const offline = results.filter((r) => !r.ok && r.offline).length;
    const firstError = results.find((r) => !r.ok)?.error || "";
    await updateSelfHostJob(jobId, {
      status: placed > 0 ? "done" : "failed",
      cursor,
      placed,
      placedClients,
      failed,
      offline,
      results,
      leaseUntil: 0,
      leaseOwner: "",
      finishedAt: Date.now(),
      error: placed > 0 ? "" : firstError || "No trades were placed",
    });
    await dequeueSelfHostJobId(jobId);
    return { ok: true, status: placed > 0 ? "done" : "failed", placed };
  }

  // Release lease BEFORE chaining so the next hop is not blocked.
  await updateSelfHostJob(jobId, { leaseUntil: 0, leaseOwner: "" });
  const kick = await kickSelfHostJobContinue({
    jobId,
    req,
    delayMs: 0,
    force: true,
  });
  if (!kick?.ok && Date.now() - started < SELF_HOST_HARD_CAP_MS) {
    // Chain HTTP failed — keep processing in this same invocation.
    return processSelfHostJobHop(jobId, { req, force: true });
  }
  return {
    ok: true,
    status: "running",
    cursor,
    chained: Boolean(kick?.ok),
    kickStatus: kick?.status || kick?.reason || null,
  };
}

export async function handleMentorTrade(req, res) {
  if (req.method === "OPTIONS") {
    endOptions(res);
    return;
  }

  // Poll / cancel background job status.
  if (req.method === "GET") {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const jobId = String(
        url.searchParams.get("jobId") || url.searchParams.get("id") || ""
      ).trim();
      if (!jobId) {
        sendJson(res, 400, { error: "jobId is required" });
        return;
      }
      const job = await getSelfHostJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Job not found" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        ...publicSelfHostJob(job),
      });
    } catch (error) {
      sendJson(res, error.status || 500, {
        error: error.message || "Could not load self-host job",
      });
    }
    return;
  }

  if (req.method === "DELETE") {
    try {
      const body = await readJsonBody(req);
      const jobId = String(body.jobId || body.id || "").trim();
      if (!jobId) {
        sendJson(res, 400, { error: "jobId is required" });
        return;
      }
      const job = await getSelfHostJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "Job not found" });
        return;
      }
      if (job.status === "done" || job.status === "failed") {
        sendJson(res, 200, { ok: true, ...publicSelfHostJob(job) });
        return;
      }
      const next = await updateSelfHostJob(jobId, {
        status: "cancelled",
        finishedAt: Date.now(),
        error: "Cancelled from portal",
      });
      await dequeueSelfHostJobId(jobId);
      sendJson(res, 200, { ok: true, ...publicSelfHostJob(next) });
    } catch (error) {
      sendJson(res, error.status || 500, {
        error: error.message || "Could not cancel self-host job",
      });
    }
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);

    // Continue hop for an existing durable job (portal may already be closed).
    if (body.continue && body.jobId) {
      const delayMs = Math.max(0, Math.min(55_000, Number(body.delayMs) || 0));
      if (delayMs > 0) await sleep(delayMs);
      const force = body.force !== false;
      waitUntil(
        processSelfHostJobHop(String(body.jobId), { req, force }).catch((err) => {
          console.error(
            "self-host continue hop failed",
            err instanceof Error ? err.message : String(err)
          );
        })
      );
      sendJson(res, 202, {
        ok: true,
        accepted: true,
        background: true,
        jobId: String(body.jobId),
      });
      return;
    }

    const mentor = await assertApprovedMentor(body.mentorEmail);
    const symbol =
      normalizeBrokerSymbol(body.symbol) || String(body.symbol || "").trim();
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
    // Max 3 TP threads; lot on the job is TOTAL size (server splits it).
    const tradesCount = Math.max(
      1,
      Math.min(
        3,
        Math.floor(Number(body.tradesCount ?? body.count ?? body.trades ?? 1) || 1)
      )
    );
    const delaySec = Math.max(
      0,
      Math.min(600, Math.floor(Number(body.delaySec ?? body.delay ?? 0) || 0))
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

    // Do NOT resolve the 600+ client roster here. iPhone/WebKit aborts the
    // POST with "Load failed" when licenses/registry work runs before 202.
    // The hop resolves targets, then places trades.
    const lot = Number.isFinite(volume) && volume > 0 ? volume : 0.01;
    const hostedByAdmin = normalizeEmail(body.hostedByAdmin || body.adminEmail);
    // Job-level comment is only a fallback; each fill uses the client's EA name.
    const comment = String(body.comment || "bot~APEXEA")
      .replace(/apexea/gi, "APEXEA")
      .replace(/^(mentor|admin)~/i, "bot~")
      .slice(0, 31);
    const expectedClients = Math.max(
      0,
      Math.floor(
        Number(body.expectedClients ?? body.targeted ?? body.connected ?? 0) || 0
      )
    );
    const rawClients = Array.isArray(body.clients)
      ? body.clients
      : Array.isArray(body.accounts)
        ? body.accounts
        : [];
    // Optional tiny tip only — never require the full portal roster.
    const clientTips = rawClients.slice(0, 8).map((row) => ({
      email: row?.email,
      accountId: row?.accountId,
      login: row?.login,
    }));

    const jobId = newSelfHostJobId();
    const runAt = Date.now() + delaySec * 1000;
    const job = await saveSelfHostJob({
      id: jobId,
      status: delaySec > 0 ? "scheduled" : "queued",
      mentorEmail: mentor.email,
      mentorUsername: mentor.username || "",
      hostedByAdmin: hostedByAdmin || "",
      symbol,
      side,
      volume: lot,
      tradesCount,
      stopLoss,
      takeProfit,
      takeProfits,
      comment,
      targets: [],
      botMetaByClient: {},
      clientTips,
      resolveTargets: true,
      targeted: expectedClients,
      cursor: 0,
      placed: 0,
      placedClients: 0,
      failed: 0,
      offline: 0,
      results: [],
      runAt,
      createdAt: Date.now(),
      error: "",
    });
    await enqueueSelfHostJobId(jobId);

    // Respond immediately so leaving the portal / switching to MetaTrader
    // cannot abort placement. waitUntil keeps this hop alive after 202.
    waitUntil(
      processSelfHostJobHop(jobId, { req }).catch(async (err) => {
        console.error(
          "self-host job hop failed",
          jobId,
          err instanceof Error ? err.message : String(err)
        );
        try {
          await updateSelfHostJob(jobId, {
            status: "failed",
            error: err instanceof Error ? err.message : "Background execute failed",
            finishedAt: Date.now(),
          });
        } catch {
          /* ignore */
        }
      })
    );

    sendJson(res, 202, {
      ok: true,
      accepted: true,
      background: true,
      jobId,
      status: job.status,
      mentorEmail: mentor.email,
      hostedByAdmin: hostedByAdmin || "",
      symbol,
      side,
      volume: lot,
      tradesCount,
      stopLoss,
      takeProfit,
      targeted: expectedClients,
      connected: expectedClients,
      placed: 0,
      placedClients: 0,
      failed: 0,
      offline: 0,
      runAt,
      delaySec,
      error: "",
      results: [],
      message:
        delaySec > 0
          ? `Trade scheduled — executes in ${delaySec}s even if you leave`
          : "Executing in background — safe to leave the portal",
    });
  } catch (error) {
    sendJson(res, error.status || 500, {
      error: error.message || "Mentor self-hosting trade failed",
      details: error.data || null,
    });
  }
}
