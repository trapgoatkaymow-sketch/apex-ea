/** Client helpers for MT5API (Swagger http://66.23.225.158). Prefer server proxy. */

export const MT5_API_BASE = String(
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_MT5_API_BASE) ||
    "http://66.23.225.158"
).replace(/\/$/, "");

export function parseAccessPoint(access) {
  const raw = String(access || "").trim();
  if (!raw) return null;
  const [host, portPart] = raw.split(":");
  if (!host) return null;
  return { host, port: Number(portPart) || 443 };
}
