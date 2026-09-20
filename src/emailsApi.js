import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/emails";

export const WITHDRAWAL_REQUEST_EMAIL = "apexeaa@gmail.com";

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
      (typeof data === "string" ? data : `Email send failed (${response.status})`);
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Send a custom broadcast to many client emails (super-admin only). */
export async function sendBroadcastEmailsRemote({
  adminEmail,
  subject,
  message,
  recipients,
  concurrency = 4,
} = {}) {
  return apiFetch("", {
    method: "POST",
    body: {
      action: "broadcast",
      adminEmail,
      subject,
      message,
      recipients,
      concurrency,
    },
  });
}

/** Mentor requests a commission payout email to apexeaa@gmail.com. */
export async function requestCommissionWithdrawalRemote(payload = {}) {
  return apiFetch("", {
    method: "POST",
    body: {
      action: "withdraw-request",
      ...payload,
    },
  });
}

export async function fetchEmailServiceStatus() {
  return apiFetch("");
}
