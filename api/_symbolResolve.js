/**
 * Shared broker symbol normalization + matching.
 * Brokers expose the same instrument under many names:
 *   US30, .US30., US30Cash, US30.m, EURUSD.mic, DE30↔GER40, …
 */

export function normalizeBrokerSymbol(raw) {
  let s = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[\/_\-]/g, "")
    .replace(/[^A-Z0-9.]/g, "");
  return s.replace(/\.{2,}/g, ".");
}

/** Strip broker dots / Cash / common suffix tokens to a comparable core. */
export function symbolCore(raw) {
  let s = normalizeBrokerSymbol(raw).replace(/^\.+/, "").replace(/\.+$/, "");
  if (!s) return "";
  // Drop dotted suffixes one at a time: EURUSD.mic → EURUSD, XAUUSD.m → XAUUSD
  s = s.replace(/\.(MIC|PRO|RAW|ECN|STD|CASH|SPOT|M|R|I|A|B|C)$/i, "");
  // Undotted suffixes brokers glue on: EURUSDm, US30Cash, XAUUSDpro
  s = s.replace(/(MIC|PRO|RAW|ECN|STD|CASH|SPOT)$/i, "");
  s = s.replace(/([A-Z0-9])M$/i, "$1");
  // Keep only the first dotted segment after stripping suffix tokens
  s = s.split(".")[0] || s;
  return s;
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
  XAUUSD: ["XAUUSD", "GOLD", "XAU"],
  XAGUSD: ["XAGUSD", "SILVER", "XAG"],
  BTCUSD: ["BTCUSD", "BTCUSDT", "BITCOIN", "BTC"],
  ETHUSD: ["ETHUSD", "ETHUSDT", "ETHEREUM", "ETH"],
};

function aliasesForCore(core) {
  const key = String(core || "").toUpperCase();
  if (!key) return [];
  if (INDEX_ALIASES[key]) return [...INDEX_ALIASES[key]];
  // Also match when OCR returns an alias as the core (GER40 → DE30 family).
  for (const [canon, list] of Object.entries(INDEX_ALIASES)) {
    if (list.includes(key)) return [canon, ...list];
  }
  return [key];
}

/** Expand a requested symbol into likely broker catalog spellings. */
export function candidateSymbols(symbol) {
  const raw = String(symbol || "").trim();
  if (!raw) return [];
  const upper = normalizeBrokerSymbol(raw);
  const bare = upper.replace(/^\.+/, "").replace(/\.+$/, "");
  const core = symbolCore(upper);
  const out = [];
  const push = (v) => {
    const s = normalizeBrokerSymbol(v);
    if (s && !out.includes(s)) out.push(s);
  };

  push(upper);
  push(bare);
  push(core);

  const cores = aliasesForCore(core);
  for (const base of cores) {
    push(base);
    push(`.${base}`);
    push(`.${base}.`);
    push(`${base}.`);
    push(`${base}.MIC`);
    push(`.${base}.MIC`);
    push(`${base}.M`);
    push(`${base}M`);
    push(`${base}.R`);
    push(`${base}.I`);
    push(`${base}.PRO`);
    push(`${base}.RAW`);
    push(`${base}.ECN`);
    push(`${base}CASH`);
    push(`.${base}CASH`);
    push(`${base}.CASH`);
    push(`.${base}.CASH`);
    push(`${base}SPOT`);
    push(`${base}.SPOT`);
  }

  return out;
}

function matchRank(requestedCore, candidateUpper, requestedUpper) {
  if (candidateUpper === requestedUpper) return 0;
  const candBare = candidateUpper.replace(/^\.+/, "").replace(/\.+$/, "");
  const reqBare = requestedUpper.replace(/^\.+/, "").replace(/\.+$/, "");
  if (candBare === reqBare) return 1;
  if (candidateUpper === requestedCore) return 2;
  if (candBare === requestedCore) return 3;
  if (candidateUpper === `${requestedCore}.MIC`) return 4;
  if (candidateUpper === `${requestedCore}M` || candidateUpper === `${requestedCore}.M`) {
    return 5;
  }
  if (candidateUpper === `${requestedCore}CASH` || candidateUpper === `${requestedCore}.CASH`) {
    return 6;
  }
  if (candBare.startsWith(requestedCore) || candidateUpper.startsWith(requestedCore)) return 7;
  if (candBare.includes(requestedCore) || candidateUpper.includes(requestedCore)) return 8;
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

  const upper = list.map((s) => ({ raw: s, u: normalizeBrokerSymbol(s) }));
  const candidates = candidateSymbols(want);
  const candidateSet = new Set(candidates);

  // Exact candidate hits first (preserves broker spelling from /Symbols).
  const exactHits = upper.filter((s) => candidateSet.has(s.u));
  if (exactHits.length) {
    const core = symbolCore(want);
    exactHits.sort(
      (a, b) =>
        matchRank(core, a.u, want) - matchRank(core, b.u, want) ||
        a.u.length - b.u.length
    );
    return exactHits[0].raw;
  }

  // Fuzzy fallback for odd suffixes not in the candidate generator.
  const cores = aliasesForCore(symbolCore(want));
  const fuzzy = upper.filter((s) => {
    const sCore = symbolCore(s.u);
    if (cores.includes(sCore)) return true;
    if (cores.some((c) => s.u.includes(c) || sCore.includes(c))) return true;
    if (want === "XAUUSD" || cores.includes("XAUUSD")) {
      if (/XAU|GOLD/i.test(s.u)) return true;
    }
    if (want === "XAGUSD" || cores.includes("XAGUSD")) {
      if (/XAG|SILVER/i.test(s.u)) return true;
    }
    return false;
  });
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
  if (exact) return normalizeBrokerSymbol(exact);

  // Prefer an exact catalog entry whose core aliases match the OCR'd instrument.
  const baseHit = list.find((item) => {
    const itemCore = symbolCore(item);
    return cores.includes(itemCore) || aliasesForCore(itemCore).some((a) => cores.includes(a));
  });
  if (baseHit) return normalizeBrokerSymbol(baseHit);

  // Keep broker-dotted OCR when nothing in the catalog matches — trade-time
  // resolver will map it against the live account /Symbols list.
  if (/^\./.test(normalized) || /\.$/.test(normalized)) return normalized;

  return normalized;
}
