import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/mt5-accounts";

async function apiFetch(path = "", { method = "GET", body } = {}) {
  const response = await fetch(`${apiUrl(API_PATH)}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
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
      (data && (data.error || data.message)) ||
      (typeof data === "string" ? data : `MT5 account sync failed (${response.status})`);
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

export async function upsertMt5Account(payload = {}) {
  const data = await apiFetch("", { method: "POST", body: payload });
  return data?.account || null;
}

export async function removeMt5Account(email) {
  const key = normalizeEmail(email);
  if (!key) return { ok: false };
  return apiFetch("", { method: "DELETE", body: { email: key } });
}

export async function listMentorHostedAccounts(mentorEmail) {
  const key = normalizeEmail(mentorEmail);
  if (!key) return [];
  const data = await apiFetch(`?mentorEmail=${encodeURIComponent(key)}`);
  return Array.isArray(data?.accounts) ? data.accounts : [];
}

function friendlySelfHostFetchError(error, status) {
  const raw = String(error?.message || error || "").trim();
  // iOS Safari / WebKit: oversized keepalive bodies and aborted fetches show as "Load failed".
  if (/^load failed$/i.test(raw) || /failed to fetch/i.test(raw) || /networkerror/i.test(raw)) {
    return "Could not reach the trade server — try again";
  }
  if (status) return raw || `Self hosting trade failed (${status})`;
  return raw || "Could not execute trade";
}

export async function executeMentorSelfHostTrade(payload = {}) {
  const body = JSON.stringify(payload);
  // Browsers cap keepalive request bodies at ~64KiB. A 600-client roster is
  // far larger, and iOS reports that failure as the useless "Load failed".
  const useKeepalive = body.length < 56_000;
  let response;
  try {
    response = await fetch(apiUrl("/api/metaapi/mentor-trade"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      ...(useKeepalive ? { keepalive: true } : {}),
    });
  } catch (error) {
    const err = new Error(friendlySelfHostFetchError(error));
    err.cause = error;
    throw err;
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  // 202 Accepted = durable background job (leaving the portal is safe).
  if (!response.ok && response.status !== 202) {
    const message = friendlySelfHostFetchError(
      (data && (data.error || data.message)) ||
        (typeof data === "string" ? data : ""),
      response.status
    );
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function getSelfHostTradeJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const response = await fetch(
    apiUrl(`/api/metaapi/mentor-trade?jobId=${encodeURIComponent(id)}`),
    {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    }
  );
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      (data && (data.error || data.message)) ||
      `Self host job lookup failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

export async function cancelSelfHostTradeJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return null;
  const response = await fetch(apiUrl("/api/metaapi/mentor-trade"), {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jobId: id }),
    cache: "no-store",
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
      (data && (data.error || data.message)) ||
      `Could not cancel self-host job (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}
