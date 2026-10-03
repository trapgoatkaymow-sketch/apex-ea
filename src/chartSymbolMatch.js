import { normalizeBrokerSymbol, symbolCore } from "./brokerSymbol.js";

/** Longest-first so XAUUSD wins over XAU, NAS100 over NAS. */
export const KNOWN_TICKERS = [
  "XAUUSD",
  "XAGUSD",
  "BTCUSD",
  "ETHUSD",
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "NZDUSD",
  "USDCAD",
  "USDCHF",
  "EURGBP",
  "EURJPY",
  "GBPJPY",
  "NAS100",
  "USTEC",
  "US100",
  "US500",
  "SPX500",
  "GER40",
  "GER30",
  "DE40",
  "DE30",
  "UK100",
  "JP225",
  "AUS200",
  "FRA40",
  "HK50",
  "USOIL",
  "UKOIL",
  "US30",
  "DJ30",
  "WS30",
  "GOLD",
  "SILVER",
  "NDX",
  "DAX",
  "WTI",
];

const PHRASE_ALIASES = [
  [/WALL\s*STREET\s*30|DOW\s*JONES|\bDJIA\b|USA\s*30|US\s*WALL/i, "US30"],
  [/NASDAQ|US\s*TECH|USATECH|USTEC/i, "NAS100"],
  [/S&P\s*500|SPX\s*500|US\s*500/i, "US500"],
  [/GERMAN\s*4[0O]|GERMANY\s*4[0O]|\bDAX\b/i, "GER40"],
  [/FTSE|UK\s*100/i, "UK100"],
  [/NIKKEI|JP\s*225|JAPAN\s*225/i, "JP225"],
  [/SPOT\s*GOLD|\bGOLD\b/i, "XAUUSD"],
  [/\bSILVER\b/i, "XAGUSD"],
  [/BITCOIN|\bBTC\b/i, "BTCUSD"],
  [/ETHEREUM|\bETH\b/i, "ETHUSD"],
  [/BRENT|UK\s*OIL/i, "UKOIL"],
  [/CRUDE|WTI|US\s*OIL/i, "USOIL"],
  [/EUR\s*\/?\s*USD|EURO\s*USD/i, "EURUSD"],
  [/GBP\s*\/?\s*USD|CABLE|POUND\s*USD/i, "GBPUSD"],
  [/USD\s*\/?\s*JPY/i, "USDJPY"],
];

const PRICE_BANDS = [
  { cores: ["US30", "DJ30", "WS30"], lo: 28000, hi: 62000 },
  { cores: ["NAS100", "US100", "USTEC"], lo: 12000, hi: 28000 },
  { cores: ["JP225"], lo: 25000, hi: 52000 },
  { cores: ["GER40", "DE40", "GER30", "DE30"], lo: 14000, hi: 24000 },
  { cores: ["UK100"], lo: 6000, hi: 11000 },
  { cores: ["US500", "SPX500"], lo: 4000, hi: 8000 },
  { cores: ["BTCUSD"], lo: 40000, hi: 180000 },
  { cores: ["ETHUSD"], lo: 1400, hi: 8000 },
  { cores: ["XAUUSD", "GOLD"], lo: 1600, hi: 5500 },
  { cores: ["XAGUSD", "SILVER"], lo: 15, hi: 80 },
  { cores: ["USOIL", "UKOIL"], lo: 40, hi: 130 },
  { cores: ["USDJPY"], lo: 130, hi: 170 },
  { cores: ["GBPUSD"], lo: 1.12, hi: 1.45 },
  { cores: ["EURUSD"], lo: 0.95, hi: 1.2 },
  { cores: ["AUDUSD"], lo: 0.55, hi: 0.78 },
];

function compactText(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9./]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function glueText(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function needleVariants(needle) {
  const n = String(needle || "").toUpperCase();
  const out = new Set([n]);
  const map = {
    O: "0",
    0: "O",
    I: "1",
    1: "I",
    S: "5",
    5: "S",
    B: "8",
    U: "0",
    G: "6",
  };
  for (let i = 0; i < n.length; i += 1) {
    const swap = map[n[i]];
    if (!swap) continue;
    out.add(`${n.slice(0, i)}${swap}${n.slice(i + 1)}`);
  }
  return [...out];
}

function catalogSpellings(catalog = []) {
  return (Array.isArray(catalog) ? catalog : [])
    .map((item) => normalizeBrokerSymbol(item))
    .filter(Boolean);
}

const FAMILIES = {
  US30: ["US30", "DJ30", "WS30", "DJIA", "USA30", "DOW30"],
  NAS100: ["NAS100", "USTEC", "US100", "NDX", "NASDAQ", "NDX100"],
  US500: ["US500", "SPX500", "SP500", "SPX"],
  GER40: ["GER40", "DE40", "GER30", "DE30", "DAX", "GDAXI"],
  UK100: ["UK100", "FTSE", "FTSE100"],
  JP225: ["JP225", "JPN225", "NI225", "NIKKEI"],
  XAUUSD: ["XAUUSD", "GOLD", "XAU"],
  XAGUSD: ["XAGUSD", "SILVER", "XAG"],
  BTCUSD: ["BTCUSD", "BTCUSDT", "BTC", "BITCOIN"],
  ETHUSD: ["ETHUSD", "ETHUSDT", "ETH"],
  USOIL: ["USOIL", "WTI", "CL"],
  UKOIL: ["UKOIL", "BRENT"],
};

function familyCores(core) {
  const key = String(core || "").toUpperCase();
  if (FAMILIES[key]) return FAMILIES[key];
  for (const [canon, list] of Object.entries(FAMILIES)) {
    if (list.includes(key)) return [canon, ...list];
  }
  return [key];
}

function preferCatalogSpelling(detected, catalog = []) {
  const want = normalizeBrokerSymbol(detected);
  if (!want) return "";
  const wantCore = symbolCore(want);
  const list = catalogSpellings(catalog);
  const exact = list.find((item) => item === want);
  if (exact) return exact;
  const aliases = familyCores(wantCore);
  const familyHit = list.find((item) => aliases.includes(symbolCore(item)));
  if (familyHit) return familyHit;
  const coreHit = list.find((item) => symbolCore(item) === wantCore);
  if (coreHit) return coreHit;
  return want;
}

function scoreHit(core, source) {
  let score = String(core || "").length;
  if (source === "catalog") score += 50;
  if (source === "phrase") score += 36;
  if (source === "ticker") score += 24;
  if (source === "price") score += 10;
  return score;
}

export function parseChartPrices(text) {
  const raw = String(text || "");
  const found = [];
  const re = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2,5}|\d{4,6}/g;
  let match = re.exec(raw);
  while (match) {
    const n = Number(String(match[0]).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) found.push(n);
    match = re.exec(raw);
  }
  return found;
}

export function inferSymbolFromPrices(prices = [], catalog = []) {
  const nums = (Array.isArray(prices) ? prices : []).filter(
    (n) => Number.isFinite(n) && n > 0
  );
  if (!nums.length) return "";
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const list = catalogSpellings(catalog);
  let best = "";
  let bestRel = 0.22;
  for (const band of PRICE_BANDS) {
    if (mid < band.lo || mid > band.hi) continue;
    for (const core of band.cores) {
      const spelling = preferCatalogSpelling(core, list.length ? list : [core]);
      if (list.length && !list.some((item) => symbolCore(item) === symbolCore(spelling))) {
        // Catalog is loaded but this instrument is not on the EA — skip unless no catalog hits at all.
        continue;
      }
      const rel =
        Math.abs((band.lo + band.hi) / 2 - mid) / Math.max(mid, (band.lo + band.hi) / 2);
      if (rel < bestRel) {
        bestRel = rel;
        best = spelling || core;
      }
    }
  }
  if (best) return normalizeBrokerSymbol(best);
  if (!list.length) {
    for (const band of PRICE_BANDS) {
      if (mid >= band.lo && mid <= band.hi) return normalizeBrokerSymbol(band.cores[0]);
    }
  }
  return "";
}

/**
 * Read a ticker out of OCR / header text. Prefers the client's EA catalog.
 */
export function matchSymbolFromText(text, catalog = []) {
  const compact = compactText(text);
  const glued = glueText(text);
  if (!compact && !glued) return "";

  const list = catalogSpellings(catalog);
  const hits = [];

  const consider = (raw, source) => {
    const spelling = preferCatalogSpelling(raw, list);
    const core = symbolCore(spelling || raw);
    if (!core || core.length < 3) return;
    hits.push({ symbol: spelling || normalizeBrokerSymbol(raw), score: scoreHit(core, source) });
  };

  for (const item of list) {
    const core = symbolCore(item);
    if (!core || core.length < 3) continue;
    const names = familyCores(core);
    const variants = names.flatMap((name) => needleVariants(name));
    if (variants.some((v) => glued.includes(v) || compact.includes(v))) {
      consider(item, "catalog");
    }
  }

  for (const ticker of KNOWN_TICKERS) {
    const variants = needleVariants(ticker);
    if (variants.some((v) => glued.includes(v) || compact.includes(v))) {
      consider(ticker, "ticker");
    }
  }

  for (const [re, ticker] of PHRASE_ALIASES) {
    if (re.test(compact) || re.test(String(text || ""))) consider(ticker, "phrase");
  }

  const dotted = compact.match(/\.[A-Z]{2,12}[A-Z0-9]*\.?/g) || [];
  for (const token of dotted) consider(token, "ticker");

  const spaced = compact.match(/\b[A-Z]{3,6}(?:USD|JPY|GBP|EUR|CAD|CHF|AUD|NZD|USDT)?\b/g) || [];
  for (const token of spaced) {
    if (KNOWN_TICKERS.includes(token) || list.some((item) => symbolCore(item) === token)) {
      consider(token, "ticker");
    }
  }

  if (!hits.length) {
    const fromPrice = inferSymbolFromPrices(parseChartPrices(text), list);
    return fromPrice;
  }

  hits.sort((a, b) => b.score - a.score || b.symbol.length - a.symbol.length);
  return hits[0].symbol;
}
