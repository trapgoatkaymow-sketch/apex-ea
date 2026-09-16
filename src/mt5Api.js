/** MT5API RESTful broker helpers (Swagger: http://66.23.225.158/swagger/index.html). */

const DEFAULT_MT5_API_BASE = "http://66.23.225.158";

export const MT5_API_BASE = String(
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_MT5_API_BASE) ||
    DEFAULT_MT5_API_BASE
).replace(/\/$/, "");

function canUseDirectHttp(base) {
  const root = String(base || "").trim();
  if (!root.startsWith("http://")) return true;
  if (typeof window === "undefined") return true;
  // HTTPS pages block cleartext → skip instead of hanging/failing oddly.
  try {
    return window.location?.protocol !== "https:";
  } catch {
    return false;
  }
}

async function mt5Fetch(path, { signal, base = MT5_API_BASE, timeoutMs = 2500 } = {}) {
  const root = String(base || MT5_API_BASE).replace(/\/$/, "");
  const url = `${root}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    const text = await response.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Connect endpoints often return a plain token string.
    }

    if (!response.ok) {
      const message =
        typeof data === "string"
          ? data
          : data?.message || data?.title || `MT5 API error ${response.status}`;
      throw new Error(message);
    }

    return data;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/** Map Swagger Company[] → UI broker rows. */
export function mapMt5SearchResults(data, platform = "MT5") {
  if (!Array.isArray(data)) return [];
  const plat = String(platform || "MT5").toUpperCase() === "MT4" ? "MT4" : "MT5";
  const brokers = [];
  data.forEach((companyEntry) => {
    const companyName = String(companyEntry?.company || "").trim() || "Unknown broker";
    const results = Array.isArray(companyEntry?.results) ? companyEntry.results : [];
    results.forEach((result, index) => {
      const serverName =
        String(result?.name || "").trim() || `${companyName} server`;
      const access = Array.isArray(result?.access)
        ? result.access.map(String).map((v) => v.trim()).filter(Boolean)
        : [];
      brokers.push({
        id: `${companyName}::${serverName}::${index}`,
        company: companyName,
        name: serverName,
        site: String(result?.site || "").trim(),
        logoUrl: String(result?.logo_url || result?.logoUrl || "").trim(),
        access,
        platform: plat,
        custom: false,
        source: "mt5api",
      });
    });
  });
  return brokers;
}

/**
 * Broker search via MT5API /Search?company=…
 * Tries direct base (when allowed), then same-origin /mt5-api proxy.
 * Failures time out quickly so MetaAPI fallback can run.
 */
export async function searchBrokersMt5(company, platform = "MT5", { signal } = {}) {
  const q = String(company || "").trim();
  if (!q) return [];

  const path = `/Search?company=${encodeURIComponent(q)}`;
  const bases = [];
  if (MT5_API_BASE && canUseDirectHttp(MT5_API_BASE)) bases.push(MT5_API_BASE);
  bases.push("/mt5-api");

  let lastError = null;
  for (const base of bases) {
    try {
      const data = await mt5Fetch(path, { signal, base, timeoutMs: 2500 });
      const brokers = mapMt5SearchResults(data, platform);
      if (brokers.length) return brokers;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

export function parseAccessPoint(access) {
  const raw = String(access || "").trim();
  if (!raw) return null;
  const [host, portPart] = raw.split(":");
  if (!host) return null;
  return { host, port: Number(portPart) || 443 };
}
