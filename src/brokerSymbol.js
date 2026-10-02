/**
 * Client-side broker symbol normalizer (keep in sync with api/_symbolResolve.js).
 * Preserves lowercase broker suffixes: XAUUSDp, EURUSDm, NAS100.m
 */

const BROKER_SUFFIX_RE =
  /^(?<core>.+?)(?<suffix>(?:\.(?:micro|mic|pro|raw|ecn|std|cash|spot|fx|[mpabrics]))|(?:micro|mic|pro|raw|ecn|std|cash|spot|fx)|[mpabrics])$/i;

function looksLikeInstrumentCore(core) {
  const c = String(core || "").replace(/\./g, "");
  if (!c || c.length < 3) return false;
  if (!/[A-Za-z]/.test(c)) return false;
  if (/^[A-Za-z]{6}$/i.test(c)) return true;
  if (/^(XAU|XAG|BTC|ETH|USO|UKO)/i.test(c)) return true;
  if (/[0-9]/.test(c) && /[A-Za-z]/.test(c)) return true;
  if (/^(GOLD|SILVER|NAS|SPX|DAX|GER|USTEC|DJ)/i.test(c)) return true;
  return c.length >= 4;
}

function formatBrokerSuffix(suffix) {
  const raw = String(suffix || "");
  if (!raw) return "";
  if (raw.startsWith(".")) return `.${raw.slice(1).toLowerCase()}`;
  if (raw.length > 1) return raw.toLowerCase();
  return raw.toLowerCase();
}

/** Normalize for scanner/display/trade — core UPPER, suffix lower (XAUUSDp). */
export function normalizeBrokerSymbol(raw) {
  let s = String(raw || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[\/_\-]/g, "")
    .replace(/[^A-Za-z0-9.]/g, "");
  s = s.replace(/\.{2,}/g, ".");
  if (!s) return "";

  const lead = (s.match(/^\.+/) || [""])[0];
  const trail = (s.match(/\.+$/) || [""])[0];
  let body = s.replace(/^\.+/, "").replace(/\.+$/, "");
  if (!body) return s.toUpperCase();

  let core = body;
  let suffix = "";
  const match = body.match(BROKER_SUFFIX_RE);
  if (match?.groups?.core && looksLikeInstrumentCore(match.groups.core)) {
    core = match.groups.core;
    suffix = formatBrokerSuffix(match.groups.suffix);
  }

  return `${lead}${core.toUpperCase()}${suffix}${trail}`;
}

/** Bare instrument family key — US30 / .US30. / US30Cash → US30 */
export function symbolCore(raw) {
  let s = normalizeBrokerSymbol(raw).replace(/^\.+/, "").replace(/\.+$/, "");
  if (!s) return "";
  s = s.replace(/\.(MICRO|MIC|PRO|RAW|ECN|STD|CASH|SPOT|FX|M|P|R|I|A|B|C|S)$/i, "");
  s = s.replace(/(MICRO|MIC|PRO|RAW|ECN|STD|CASH|SPOT|FX)$/i, "");
  s = s.replace(/([A-Z0-9])[MPABCRIS]$/i, "$1");
  s = s.split(".")[0] || s;
  return s.toUpperCase();
}

/** Prefer broker-native index spellings (.US30.) over bare duplicates. */
export function preferBrokerSymbolSpelling(a, b) {
  const left = normalizeBrokerSymbol(a);
  const right = normalizeBrokerSymbol(b);
  if (!left) return right;
  if (!right) return left;
  const leftDots = (left.match(/\./g) || []).length;
  const rightDots = (right.match(/\./g) || []).length;
  if (leftDots !== rightDots) return leftDots > rightDots ? left : right;
  if (/cash/i.test(left) !== /cash/i.test(right)) {
    return /cash/i.test(left) ? left : right;
  }
  return left.length >= right.length ? left : right;
}
