/**
 * Shared broker symbol normalization + matching.
 * Brokers expose the same instrument under many names:
 *   US30, .US30., US30Cash, US30.m, EURUSD.mic, XAUUSDp, DE30↔GER40, …
 *
 * Important: keep broker suffixes like `p` / `m` lowercase (XAUUSDp, not XAUUSDP).
 */

const BROKER_SUFFIX_RE =
  /^(?<core>.+?)(?<suffix>(?:\.(?:micro|mic|pro|raw|ecn|std|cash|spot|[mpabric]))|(?:micro|mic|pro|raw|ecn|std|cash|spot)|[mpabric])$/i;

function looksLikeInstrumentCore(core) {
  const c = String(core || "").replace(/\./g, "");
  if (!c || c.length < 3) return false;
  if (!/[A-Za-z]/.test(c)) return false;
  // FX pairs, metals, crypto, indices with digits, etc.
  if (/^[A-Za-z]{6}$/i.test(c)) return true;
  if (/^(XAU|XAG|BTC|ETH|USO|UKO)/i.test(c)) return true;
  if (/[0-9]/.test(c) && /[A-Za-z]/.test(c)) return true;
  if (/^(GOLD|SILVER|NAS|SPX|DAX|GER|USTEC|DJ)/i.test(c)) return true;
  return c.length >= 4;
}

function formatBrokerSuffix(suffix) {
  const raw = String(suffix || "");
  if (!raw) return "";
  // Dotted multi-char: .mic / .pro → keep lowercase
  if (raw.startsWith(".")) {
    return `.${raw.slice(1).toLowerCase()}`;
  }
  // Undotted multi-char cash/pro/… → lowercase (Cash brokers still matched via candidates)
  if (raw.length > 1) return raw.toLowerCase();
  // Single-letter broker suffixes are almost always lowercase on MT5 (p, m, a…)
  return raw.toLowerCase();
}

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

  // Uppercase instrument core only — never the broker suffix letter.
  core = core.toUpperCase();
  return `${lead}${core}${suffix}${trail}`;
}

/** Strip broker dots / Cash / common suffix tokens to a comparable core. */
export function symbolCore(raw) {
  let s = normalizeBrokerSymbol(raw).replace(/^\.+/, "").replace(/\.+$/, "");
  if (!s) return "";
  // Drop dotted suffixes: EURUSD.mic → EURUSD, XAUUSD.m → XAUUSD
  s = s.replace(/\.(MICRO|MIC|PRO|RAW|ECN|STD|CASH|SPOT|M|P|R|I|A|B|C)$/i, "");
  // Undotted suffixes: EURUSDm, XAUUSDp, US30Cash, XAUUSDpro, XAUUSDmicro
  s = s.replace(/(MICRO|MIC|PRO|RAW|ECN|STD|CASH|SPOT)$/i, "");
  s = s.replace(/([A-Z0-9])[MPABCRI]$/i, "$1");
  s = s.split(".")[0] || s;
  return s.toUpperCase();
}

const INDEX_ALIASES = {
  DE30: ["DE30", "DE40", "GER40", "GER30", "GDAXI", "DAX40", "DAX30"],
  DE40: ["DE40", "DE30", "GER40", "GER30", "GDAXI", "DAX40"],
  GER40: ["GER40", "DE40", "DE30", "GER30", "GDAXI", "DAX40"],
  GER30: ["GER30", "GER40", "DE30", "DE40", "GDAXI"],
  US30: ["US30", "DJ30", "DJIA", "WS30", "USA30", "DOW30", "USWALLST30"],
  NAS100: ["NAS100", "USTEC", "NDX100", "NASDAQ100", "USATECH100", "TECH100"],
  US100: ["US100", "NAS100", "USTEC", "NDX100", "NASDAQ100"],
  UK100: ["UK100", "FTSE100", "FTSE", "UKFTSE100"],
  JP225: ["JP225", "JPN225", "NI225", "NIKKEI", "NIKKEI225"],
  US500: ["US500", "SPX500", "SP500", "SPX", "USASP500"],
  SPX500: ["SPX500", "US500", "SP500", "SPX"],
  AUS200: ["AUS200", "AU200", "ASX200"],
  FRA40: ["FRA40", "CAC40", "FR40"],
  HK50: ["HK50", "HKG33", "HSI"],
  // Gold — mentor XAUUSD must map onto broker GOLD renames (suffixes added below).
  XAUUSD: ["XAUUSD", "GOLD", "XAU"],
  GOLD: ["GOLD", "XAUUSD", "XAU"],
  XAGUSD: ["XAGUSD", "SILVER", "XAG"],
  SILVER: ["SILVER", "XAGUSD", "XAG"],
  BTCUSD: ["BTCUSD", "BTCUSDT", "BITCOIN", "BTC"],
  ETHUSD: ["ETHUSD", "ETHUSDT", "ETHEREUM", "ETH"],
};

export function aliasesForCore(core) {
  const key = String(core || "").toUpperCase();
  if (!key) return [];
  if (INDEX_ALIASES[key]) return [...INDEX_ALIASES[key]];
  // Also match when OCR returns an alias as the core (GER40 → DE30 family).
  for (const [canon, list] of Object.entries(INDEX_ALIASES)) {
    if (list.includes(key)) return [canon, ...list];
  }
  return [key];
}

/** True when candidate is the same tradable instrument family (gold, US30, …). */
export function sameInstrumentFamily(requested, candidate) {
  const want = normalizeBrokerSymbol(requested);
  const cand = normalizeBrokerSymbol(candidate);
  if (!want || !cand) return false;
  const wantCore = symbolCore(want);
  const candCore = symbolCore(cand);
  if (!wantCore || !candCore) return false;
  if (wantCore === candCore) return true;
  const wantAliases = aliasesForCore(wantCore).map((a) => String(a).toUpperCase());
  const candAliases = aliasesForCore(candCore).map((a) => String(a).toUpperCase());
  if (wantAliases.includes(candCore) || candAliases.includes(wantCore)) return true;
  if (wantAliases.some((a) => candAliases.includes(a))) return true;

  // Gold family: XAUUSD* / GOLD* only (never XAUEUR / XAUAUD).
  const wantGold =
    wantAliases.includes("XAUUSD") ||
    wantAliases.includes("GOLD") ||
    /^XAUUSD/i.test(wantCore) ||
    /^GOLD$/i.test(wantCore);
  if (wantGold) {
    return /^XAUUSD/i.test(candCore) || /^GOLD/i.test(candCore);
  }

  // Silver family
  const wantSilver =
    wantAliases.includes("XAGUSD") ||
    wantAliases.includes("SILVER") ||
    /^XAGUSD/i.test(wantCore);
  if (wantSilver) {
    return /^XAGUSD/i.test(candCore) || /^SILVER/i.test(candCore);
  }

  return false;
}

/** Expand a requested symbol into likely broker catalog spellings. */
export function candidateSymbols(symbol) {
  const raw = String(symbol || "").trim();
  if (!raw) return [];
  const normalized = normalizeBrokerSymbol(raw);
  const bare = normalized.replace(/^\.+/, "").replace(/\.+$/, "");
  const core = symbolCore(normalized);
  const out = [];
  const push = (v) => {
    const s = normalizeBrokerSymbol(v);
    if (!s) return;
    if (!out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  };

  push(normalized);
  push(bare);
  push(core);
  // Preserve original OCR casing when it already had a lowercase suffix.
  push(raw.replace(/\s+/g, "").replace(/[\/_\-]/g, ""));

  const cores = aliasesForCore(core);
  // High-priority broker suffix spellings first — self-host GetQuote walk is capped.
  for (const base of cores) {
    push(base);
    push(`${base}m`);
    push(`${base}p`);
    push(`${base}.m`);
    push(`${base}.p`);
    push(`${base}micro`);
    push(`${base}Micro`);
  }
  for (const base of cores) {
    push(`.${base}`);
    push(`.${base}.`);
    push(`${base}.`);
    push(`${base}.mic`);
    push(`.${base}.mic`);
    push(`${base}.r`);
    push(`${base}.i`);
    push(`${base}.a`);
    push(`${base}a`);
    push(`${base}.pro`);
    push(`${base}.raw`);
    push(`${base}.ecn`);
    push(`${base}Cash`);
    push(`${base}cash`);
    push(`.${base}Cash`);
    push(`${base}.cash`);
    push(`.${base}.cash`);
    push(`${base}spot`);
    push(`${base}.spot`);
  }

  return out;
}

function matchRank(requestedCore, candidateNorm, requestedNorm) {
  const cand = String(candidateNorm || "");
  const req = String(requestedNorm || "");
  const candL = cand.toLowerCase();
  const reqL = req.toLowerCase();
  if (candL === reqL) return 0;
  const candBare = cand.replace(/^\.+/, "").replace(/\.+$/, "");
  const reqBare = req.replace(/^\.+/, "").replace(/\.+$/, "");
  if (candBare.toLowerCase() === reqBare.toLowerCase()) return 1;
  const candCore = symbolCore(cand);
  const reqCore = String(requestedCore || "").toUpperCase();
  if (candCore === reqCore) return 2;
  if (candL === `${reqCore.toLowerCase()}p`) return 3;
  if (candL === `${reqCore.toLowerCase()}m`) return 3;
  if (candL === `${reqCore.toLowerCase()}.mic`) return 4;
  // Prefer GOLD when mentor asked for XAUUSD (and vice versa).
  if (reqCore === "XAUUSD" && candCore === "GOLD") return 4;
  if (reqCore === "GOLD" && candCore === "XAUUSD") return 4;
  if (candL.endsWith("cash") && candBare.toLowerCase().startsWith(reqCore.toLowerCase())) {
    return 5;
  }
  if (candBare.toLowerCase().startsWith(reqCore.toLowerCase())) return 6;
  if (candL.includes(reqCore.toLowerCase())) return 7;
  return 9;
}

/**
 * Pick the broker's real symbol string from an account symbol list.
 * Returns the original catalog casing when available.
 */
export function pickBestSymbolFromList(requested, symbolsList = []) {
  const want = normalizeBrokerSymbol(requested);
  if (!want) return "";
  const list = Array.isArray(symbolsList) ? symbolsList.map(String).filter(Boolean) : [];
  if (!list.length) return want;

  const rows = list
    .map((s) => ({ raw: s, u: normalizeBrokerSymbol(s) }))
    .filter((s) => s.u);
  const candidates = candidateSymbols(want);
  const candidateSet = new Set(candidates.map((c) => c.toLowerCase()));

  // Exact candidate hits first (preserves broker spelling from /Symbols).
  const exactHits = rows.filter((s) => candidateSet.has(String(s.u).toLowerCase()));
  if (exactHits.length) {
    const core = symbolCore(want);
    exactHits.sort(
      (a, b) =>
        matchRank(core, a.u, want) - matchRank(core, b.u, want) ||
        a.u.length - b.u.length
    );
    return exactHits[0].raw;
  }

  // Family fallback — gold/XAUUSD maps to GOLD / XAUUSDm / XAUUSDp on that broker.
  const fuzzy = rows.filter((s) => sameInstrumentFamily(want, s.u));
  if (!fuzzy.length) return want;

  const core = symbolCore(want);
  fuzzy.sort(
    (a, b) =>
      matchRank(core, a.u, want) - matchRank(core, b.u, want) || a.u.length - b.u.length
  );
  return fuzzy[0].raw;
}

/**
 * Map OCR / mentor catalog symbols onto a preferred display/trade hint.
 * Keeps broker-dotted forms when they are already in the catalog; otherwise
 * maps aliases onto the closest catalog entry (or the cleaned core).
 */
export function resolveCatalogSymbol(symbol, catalog = []) {
  const normalized = normalizeBrokerSymbol(symbol);
  if (!normalized) return "";
  const list = Array.isArray(catalog) ? catalog.map(String) : [];
  const cores = aliasesForCore(symbolCore(normalized));

  const exact = list.find((item) => normalizeBrokerSymbol(item) === normalized);
  if (exact) return String(exact);

  // Prefer an exact catalog entry whose core aliases match the OCR'd instrument.
  const baseHit = list.find((item) => {
    const itemCore = symbolCore(item);
    return cores.includes(itemCore) || aliasesForCore(itemCore).some((a) => cores.includes(a));
  });
  if (baseHit) return String(baseHit);

  // Keep broker-dotted OCR when nothing in the catalog matches — trade-time
  // resolver will map it against the live account /Symbols list.
  if (/^\./.test(normalized) || /\.$/.test(normalized)) return normalized;

  return normalized;
}
