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
let paypalSdkClientId = "";

/**
 * Load PayPal JS SDK configured for Debit/Credit Card checkout.
 * Card is the primary (and preferred) funding source — buyers do not need a
 * PayPal account. PayPal wallet is still available as a secondary option when
 * `cardOnly` is false.
 */
export function loadPaypalSdk(clientId, { cardOnly = true } = {}) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Card checkout only runs in the browser"));
  }
  const id = String(clientId || "").trim();
  if (!id) {
    return Promise.reject(new Error("PayPal client id is missing"));
  }

  // Reuse only when the same client + mode is already loaded.
  const modeKey = cardOnly ? "card" : "mixed";
  if (
    window.paypal &&
    paypalSdkClientId === `${id}:${modeKey}` &&
    window.paypal.FUNDING
  ) {
    return Promise.resolve(window.paypal);
  }

  // Bust a previously loaded SDK that was wallet-first.
  const existing = document.querySelector("script[data-apexea-paypal]");
  if (existing && existing.dataset.apexeaMode !== modeKey) {
    existing.remove();
    try {
      delete window.paypal;
    } catch {
      window.paypal = undefined;
    }
    paypalSdkPromise = null;
  }

  if (paypalSdkPromise && paypalSdkClientId === `${id}:${modeKey}`) {
    return paypalSdkPromise;
  }

  paypalSdkClientId = `${id}:${modeKey}`;
  paypalSdkPromise = new Promise((resolve, reject) => {
    const already = document.querySelector("script[data-apexea-paypal]");
    if (already && window.paypal) {
      resolve(window.paypal);
      return;
    }
    const script = document.createElement("script");
    // Card-first: enable Debit/Credit Card, hide Pay Later / Venmo / credit.
    // When cardOnly, also disable the PayPal wallet so the only button is Card.
    const disable = cardOnly
      ? "paypal,venmo,paylater,credit"
      : "venmo,paylater,credit";
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
      id
    )}&currency=USD&intent=capture&components=buttons&enable-funding=card&disable-funding=${disable}&commit=true`;
    script.async = true;
    script.dataset.apexeaPaypal = "1";
    script.dataset.apexeaMode = modeKey;
    script.onload = () => {
      if (!window.paypal) {
        reject(new Error("Card checkout SDK missing after load"));
        return;
      }
      resolve(window.paypal);
    };
    script.onerror = () => reject(new Error("Card checkout SDK failed to load"));
    document.head.appendChild(script);
  });

  return paypalSdkPromise;
}

/**
 * Render a Debit/Credit Card PayPal button into `container`.
 * Buyers enter card details — no PayPal account required.
 */
export async function renderCardPayButtons({
  container,
  clientId,
  purpose = "access",
  getEmail,
  onPaying,
  onPaid,
  onError,
  onCancel,
  cardOnly = true,
} = {}) {
  if (!container) throw new Error("Missing card button container");
  const paypal = await loadPaypalSdk(clientId, { cardOnly });
  container.innerHTML = "";

  const shared = {
    style: {
      layout: "vertical",
      color: cardOnly ? "black" : "gold",
      shape: "rect",
      label: "pay",
      tagline: false,
      height: 48,
    },
    createOrder: async () => {
      const email = String(getEmail?.() || "")
        .trim()
        .toLowerCase();
      if (!email.includes("@")) {
        throw new Error("Enter a valid email before paying");
      }
      const order = await createPaypalOrder(email, purpose);
      if (!order?.id) throw new Error("Could not start card checkout");
      return order.id;
    },
    onApprove: async (data) => {
      onPaying?.(true);
      try {
        const email = String(getEmail?.() || "")
          .trim()
          .toLowerCase();
        const result = await capturePaypalOrder(data.orderID, email, purpose);
        await onPaid?.(result, email);
      } catch (error) {
        onError?.(error);
        throw error;
      } finally {
        onPaying?.(false);
      }
    },
    onError: (err) => {
      onError?.(err || new Error("Card checkout error — try again"));
    },
    onCancel: () => {
      onCancel?.();
    },
  };

  const cardFunding = paypal.FUNDING?.CARD;
  if (cardFunding) {
    const cardButtons = paypal.Buttons({
      ...shared,
      fundingSource: cardFunding,
    });
    if (typeof cardButtons.isEligible !== "function" || cardButtons.isEligible()) {
      await cardButtons.render(container);
      return;
    }
  }

  // Card-only button not eligible — render standard buttons with card enabled.
  const mixedPaypal = await loadPaypalSdk(clientId, { cardOnly: false });
  container.innerHTML = "";
  await mixedPaypal
    .Buttons({
      ...shared,
      style: { ...shared.style, color: "gold" },
    })
    .render(container);
}
