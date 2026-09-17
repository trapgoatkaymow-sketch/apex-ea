import { apiUrl } from "./apiOrigin.js";

const API_PATH = "/api/paypal";

async function apiFetch(path, { method = "GET", body } = {}) {
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
      (typeof data === "string" ? data : `PayPal request failed (${response.status})`);
    throw new Error(message);
  }
  return data;
}

export async function fetchPaypalConfig() {
  return apiFetch("/config");
}

export async function createPaypalOrder(email, purpose = "access", urls = {}) {
  return apiFetch("/create-order", {
    method: "POST",
    body: {
      email,
      purpose,
      returnUrl: urls.returnUrl || "",
      cancelUrl: urls.cancelUrl || "",
    },
  });
}

export async function capturePaypalOrder(orderId, email, purpose = "access") {
  return apiFetch("/capture-order", {
    method: "POST",
    body: { orderId, email, purpose },
  });
}

let paypalSdkPromise = null;

/**
 * Optional in-app Smart Buttons (kept for scanner paywall).
 * Does NOT disable the PayPal wallet — card + PayPal both stay eligible.
 * Forcing card-only / disable-funding=paypal can trigger merchant reviews.
 */
export function loadPaypalSdk(clientId) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Checkout only runs in the browser"));
  }
  if (window.paypal) return Promise.resolve(window.paypal);
  if (paypalSdkPromise) return paypalSdkPromise;

  paypalSdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-apexea-paypal]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.paypal));
      existing.addEventListener("error", () =>
        reject(new Error("Checkout SDK failed to load"))
      );
      return;
    }
    const script = document.createElement("script");
    // Card enabled alongside PayPal — never disable the PayPal wallet.
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
      clientId
    )}&currency=USD&intent=capture&components=buttons&enable-funding=paypal,card&disable-funding=credit,paylater&commit=true`;
    script.async = true;
    script.dataset.apexeaPaypal = "1";
    script.onload = () => {
      if (!window.paypal) {
        reject(new Error("Checkout SDK missing after load"));
        return;
      }
      resolve(window.paypal);
    };
    script.onerror = () => reject(new Error("Checkout SDK failed to load"));
    document.head.appendChild(script);
  });

  return paypalSdkPromise;
}
