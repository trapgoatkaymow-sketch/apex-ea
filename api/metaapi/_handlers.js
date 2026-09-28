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
import { normalizeBrokerSymbol } from "../_symbolResolve.js";
import {
  closeAllPositions as mt5CloseAllPositions,
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
    const result = await mt5PlaceMarketTrade({
      accountId: body.accountId,
      symbol: body.symbol,
      volume: body.volume,
      side: body.side || body.action || "BUY",
      stopLoss: body.stopLoss,
      takeProfit: body.takeProfit,
      comment: body.comment || "bot~APEXEA",
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
    const stamp = Number(row.usedAt || row.updatedAt || row.createdAt || 0);
    if (prev && prev.stamp >= stamp) continue;
    botMetaByClient[clientEmail] = {
      stamp,
      botName:
        String(row.botName || row.bot?.name || row.clientName || "").trim() ||
        "Bot",
      mentorName: String(row.mentorName || mentor.username || "").trim(),
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
    comment,
    mentorEmail,
    mentorUsername = "",
    hostedByAdmin = "",
  } = job;
  try {
    const fill = await mt5PlaceMarketTrade({
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
    };
    try {
      const meta = botMetaByClient?.[normalizeEmail(target.email)] || {};
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
        comment,
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

  job = await updateSelfHostJob(jobId, { status: "running" });
  const targets = Array.isArray(job.targets) ? job.targets : [];
  const expected = Number(job.targeted || targets.length || 0);
  // Guard: never finish as "done/failed" if the roster failed to load.
  if (!targets.length && expected > 0) {
    await updateSelfHostJob(jobId, {
      leaseUntil: 0,
      leaseOwner: "",
      error: "Target roster missing — retrying",
    });
    await kickSelfHostJobContinue({ jobId, req, delayMs: 1500, force: true });
    return { ok: false, reason: "targets-missing", chained: true };
  }

  let cursor = Math.max(0, Number(job.cursor || 0));
  let results = Array.isArray(job.results) ? [...job.results] : [];
  let placed = Number(job.placed || 0);
  const botMetaByClient = job.botMetaByClient || {};

  while (cursor < targets.length) {
    if (Date.now() - started > SELF_HOST_HOP_BUDGET_MS) break;
    const batchEnd = Math.min(targets.length, cursor + SELF_HOST_BATCH_SIZE);
    for (; cursor < batchEnd; cursor += 1) {
      if (Date.now() - started > SELF_HOST_HOP_BUDGET_MS) break;
      const target = targets[cursor];
      if (!target?.accountId) {
        results.push({
          ok: false,
          email: target?.email || "",
          error: "Missing accountId",
        });
        continue;
      }
      const { row, placedHere } = await placeOneSelfHostTrade({
        target,
        job,
        botMetaByClient,
      });
      results.push(row);
      placed += placedHere;
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
<<<<<<< HEAD
  let kick = await kickSelfHostJobContinue({
    jobId,
    req,
    delayMs: 0,
    force: true,
  });
  if (!kick?.ok && Date.now() - started < SELF_HOST_HARD_CAP_MS) {
    // Chain HTTP failed — keep processing in this same invocation.
    return processSelfHostJobHop(jobId, { req, force: true });
  }
  // Await a second kick so waitUntil does not freeze the function before
  // the backup request is accepted (fire-and-forget gets killed).
  if (kick?.ok) {
    await sleep(2_000);
    kick =
      (await kickSelfHostJobContinue({
        jobId,
        req,
        delayMs: 0,
        force: true,
      })) || kick;
  }
  return {
    ok: true,
    status: "running",
    cursor,
    chained: Boolean(kick?.ok),
    kickStatus: kick?.status || kick?.reason || null,
  };
=======
  await kickSelfHostJobContinue({ jobId, req, delayMs: 0, force: true });
  return { ok: true, status: "running", cursor, chained: true };
>>>>>>> neworigin/main
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
    const tradesCount = Math.max(
      1,
      Math.min(
        20,
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

    const licenses = await listLicenses();
    const { targets, botMetaByClient } = await resolveMentorTradeTargets({
      mentor,
      body,
      licenses,
    });

    const lot = Number.isFinite(volume) && volume > 0 ? volume : 0.01;
    const hostedByAdmin = normalizeEmail(body.hostedByAdmin || body.adminEmail);
    const comment = String(
      body.comment || (hostedByAdmin ? "admin~APEXEA" : "mentor~APEXEA")
    )
      .replace(/apexea/gi, "APEXEA")
      .slice(0, 31);

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
      targets,
      botMetaByClient,
      targeted: targets.length,
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
      targeted: targets.length,
      connected: targets.length,
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
