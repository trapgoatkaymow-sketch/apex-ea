/** MT5API RESTful broker helpers (Swagger: http://66.23.225.158/swagger/index.html). */

const DEFAULT_MT5_API_BASE = "http://66.23.225.158";

export const MT5_API_BASE = String(
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_MT5_API_BASE) ||
    DEFAULT_MT5_API_BASE
).replace(/\/$/, "");

async function mt5Fetch(path, { signal, base = MT5_API_BASE } = {}) {
  const root = String(base || MT5_API_BASE).replace(/\/$/, "");
  const url = `${root}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    method: "GET",
    signal,
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
 * Tries direct base, then same-origin /mt5-api proxy.
 */
export async function searchBrokersMt5(company, platform = "MT5", { signal } = {}) {
  const q = String(company || "").trim();
  if (!q) return [];

  const path = `/Search?company=${encodeURIComponent(q)}`;
  const bases = [];
  // Direct VPS first — works from phones that can open the Swagger page.
  if (MT5_API_BASE) bases.push(MT5_API_BASE);
  // Same-origin proxy (Vercel rewrite / Vite proxy) when direct is blocked/mixed-content.
  bases.push("/mt5-api");

  let lastError = null;
  for (const base of bases) {
    try {
      const data = await mt5Fetch(path, { signal, base });
      const brokers = mapMt5SearchResults(data, platform);
      if (brokers.length) return brokers;
    } catch (error) {
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
