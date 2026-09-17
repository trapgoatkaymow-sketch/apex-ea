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
      (typeof data === "string" ? data : `Payment request failed (${response.status})`);
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
 * Load PayPal JS SDK with card funding enabled.
 * We render the Debit/Credit Card button only — buyers enter card details
 * without being sent to the PayPal login page.
 */
export function loadPaypalSdk(clientId) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Checkout only runs in the browser"));
  }
  if (window.paypal?.Buttons) return Promise.resolve(window.paypal);
  if (paypalSdkPromise) return paypalSdkPromise;

  paypalSdkPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-apexea-paypal]");
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.paypal) resolve(window.paypal);
        else reject(new Error("Checkout SDK missing after load"));
      });
      existing.addEventListener("error", () =>
        reject(new Error("Checkout SDK failed to load"))
      );
      return;
    }
    const script = document.createElement("script");
    // enable card; keep paypal eligible in SDK (required by PayPal) but we only RENDER card.
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
      clientId
    )}&currency=USD&intent=capture&components=buttons&enable-funding=card&disable-funding=venmo,paylater,credit&commit=true`;
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

/**
 * Render an in-app Debit/Credit Card button for lifetime (or scanner) access.
 * Does not redirect to paypal.com login — card form opens from the button.
 */
export async function renderLifetimeCardButton({
  container,
  clientId,
  purpose = "access",
  getEmail,
  onPaying,
  onPaid,
  onError,
  onCancel,
} = {}) {
  if (!container) throw new Error("Missing payment button container");
  const paypal = await loadPaypalSdk(clientId);
  container.innerHTML = "";

  const handlers = {
    style: {
      layout: "vertical",
      color: "black",
      shape: "rect",
      label: "pay",
      tagline: false,
      height: 50,
    },
    createOrder: async () => {
      const email = String(getEmail?.() || "")
        .trim()
        .toLowerCase();
      if (!email.includes("@")) {
        throw new Error("Enter a valid email before paying");
      }
      const order = await createPaypalOrder(email, purpose);
      if (!order?.id) throw new Error("Could not start checkout");
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
      onError?.(
        err?.message
          ? err
          : new Error("Card payment failed — try again")
      );
    },
    onCancel: () => onCancel?.(),
  };

  // Official card funding button — opens card fields, not PayPal wallet login.
  if (paypal.FUNDING?.CARD) {
    const cardBtn = paypal.Buttons({
      ...handlers,
      fundingSource: paypal.FUNDING.CARD,
    });
    if (typeof cardBtn.isEligible !== "function" || cardBtn.isEligible()) {
      await cardBtn.render(container);
      return { mode: "card" };
    }
  }

  // Fallback: standard buttons (card still enabled in SDK).
  await paypal.Buttons(handlers).render(container);
  return { mode: "buttons" };
}
