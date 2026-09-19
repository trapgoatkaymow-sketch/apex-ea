/** Curated company → official website domain (for remote logo fallbacks). */
const BROKER_DOMAINS = {
  "ic markets": "icmarkets.com",
  pepperstone: "pepperstone.com",
  exness: "exness.com",
  xm: "xm.com",
  "fp markets": "fpmarkets.com",
  tickmill: "tickmill.com",
  "blackbull markets": "blackbull.com",
  blackbull: "blackbull.com",
  vantage: "vantagemarkets.com",
  "vantage markets": "vantagemarkets.com",
  fxpro: "fxpro.com",
  hfm: "hfm.com",
  hotforex: "hfm.com",
  "hf markets": "hfm.com",
  octa: "octafx.com",
  octafx: "octafx.com",
  eightcap: "eightcap.com",
  oanda: "oanda.com",
  "forex.com": "forex.com",
  ig: "ig.com",
  avatrade: "avatrade.com",
  "admiral markets": "admiralmarkets.com",
  admirals: "admiralmarkets.com",
  axi: "axi.com",
  axiory: "axiory.com",
  activtrades: "activtrades.com",
  alpari: "alpari.com",
  "atc brokers": "atcbrokers.com",
  bdswiss: "bdswiss.com",
  "blueberry markets": "blueberrymarkets.com",
  "capital.com": "capital.com",
  capital: "capital.com",
  "cmc markets": "cmcmarkets.com",
  darwinex: "darwinex.com",
  dukascopy: "dukascopy.com",
  easymarkets: "easymarkets.com",
  fxtm: "fxtm.com",
  thinkmarkets: "thinkmarkets.com",
  tmgm: "tmgm.com",
  "fusion markets": "fusionmarkets.com",
  "global prime": "globalprime.com",
  gowmarkets: "gowmarkets.com",
  "go markets": "gomarkets.com",
  "hantec markets": "hantecfx.com",
  "iconic fx": "iconicfx.com",
  ironfx: "ironfx.com",
  justmarkets: "justmarkets.com",
  litefinance: "litefinance.org",
  lmax: "lmax.com",
  "markets.com": "markets.com",
  multiBank: "multibankfx.com",
  multibank: "multibankfx.com",
  "multibank group": "multibankfx.com",
  nordfx: "nordfx.com",
  "optimus futures": "optimusfutures.com",
  plus500: "plus500.com",
  puprime: "puprime.com",
  roboforex: "roboforex.com",
  robomarkets: "robomarkets.com",
  "robo markets": "robomarkets.com",
  "robomarkets ltd": "robomarkets.com",
  saxo: "home.saxo",
  "saxo bank": "home.saxo",
  spreadex: "spreadex.com",
  stark: "starkmarkets.com",
  swissquote: "swissquote.com",
  t4trade: "t4trade.com",
  "titan fx": "titanfx.com",
  "traders trust": "traders-trust.com",
  tradex: "tradex.com",
  "vt markets": "vtmarkets.com",
  windsorbrokers: "windsorbrokers.com",
  "windsor brokers": "windsorbrokers.com",
  "xm global": "xm.com",
  xtb: "xtb.com",
  "your online brokerage": "yobroker.com",
  zeromarkets: "zeromarkets.com",
  // Real Razor Markets SA site (razormarkets.com is unrelated Magento store)
  "razor markets": "razormarkets.co.za",
  "razor markets (pty) ltd": "razormarkets.co.za",
  "razor markets sa": "razormarkets.co.za",
  razormarkets: "razormarkets.co.za",
  vaultmarkets: "vaultmarkets.trade",
  "vault markets": "vaultmarkets.trade",
  "vaultmarkets (pty) ltd": "vaultmarkets.trade",
  "vaultmarkets pty ltd": "vaultmarkets.trade",
  "valor markets": "valormarkets.com",
  "valor markets ltd": "valormarkets.com",
  "gbe brokers": "gbebrokers.com",
  fbs: "fbs.com",
  instaforex: "instaforex.com",
  freshforex: "freshforex.com",
  forex4you: "forex4you.com",
  "grand capital": "grandcapital.net",
  weltrade: "weltrade.com",
  "pocket option": "pocketoption.com",
  binance: "binance.com",
  bybit: "bybit.com",
  fundingpips: "fundingpips.com",
  ftmo: "ftmo.com",
  the5ers: "the5ers.com",
  fundednext: "fundednext.com",
  topstep: "topstep.com",
  etoro: "etoro.com",
  "interactive brokers": "interactivebrokers.com",
  "trading 212": "trading212.com",
  skilling: "skilling.com",
  deriv: "deriv.com",
  fxcm: "fxcm.com",
  fxopen: "fxopen.com",
};

/**
 * Hosted original brand marks under /public/broker-logos/.
 * Prefer these over generic favicon CDNs so search shows real logos.
 */
const BROKER_LOCAL_LOGOS = {
  activtrades: "/broker-logos/activtrades.png",
  admiralmarkets: "/broker-logos/admiralmarkets.png",
  alpari: "/broker-logos/alpari.png",
  avatrade: "/broker-logos/avatrade.png",
  axi: "/broker-logos/axi.svg",
  bdswiss: "/broker-logos/bdswiss.png",
  binance: "/broker-logos/binance.png",
  blackbull: "/broker-logos/blackbull.png",
  blueberrymarkets: "/broker-logos/blueberrymarkets.png",
  bybit: "/broker-logos/bybit.png",
  capital: "/broker-logos/capital.png",
  cmcmarkets: "/broker-logos/cmcmarkets.png",
  darwinex: "/broker-logos/darwinex.png",
  deriv: "/broker-logos/deriv.png",
  dukascopy: "/broker-logos/dukascopy.png",
  easymarkets: "/broker-logos/easymarkets.png",
  eightcap: "/broker-logos/eightcap.png",
  etoro: "/broker-logos/etoro.png",
  exness: "/broker-logos/exness.png",
  fbs: "/broker-logos/fbs.png",
  forex: "/broker-logos/forex.png",
  fpmarkets: "/broker-logos/fpmarkets.png",
  ftmo: "/broker-logos/ftmo.png",
  fundednext: "/broker-logos/fundednext.png",
  fundingpips: "/broker-logos/fundingpips.png",
  fusionmarkets: "/broker-logos/fusionmarkets.svg",
  fxcm: "/broker-logos/fxcm.png",
  fxopen: "/broker-logos/fxopen.png",
  fxpro: "/broker-logos/fxpro.png",
  gbebrokers: "/broker-logos/gbebrokers.png",
  hfm: "/broker-logos/hfm.png",
  hotforex: "/broker-logos/hfm.png",
  icmarkets: "/broker-logos/icmarkets.png",
  ig: "/broker-logos/ig.png",
  instaforex: "/broker-logos/instaforex.png",
  interactivebrokers: "/broker-logos/interactivebrokers.png",
  litefinance: "/broker-logos/litefinance.png",
  multibankfx: "/broker-logos/multibankfx.png",
  nordfx: "/broker-logos/nordfx.png",
  oanda: "/broker-logos/oanda.svg",
  octa: "/broker-logos/octafx.png",
  octafx: "/broker-logos/octafx.png",
  pepperstone: "/broker-logos/pepperstone.svg",
  plus500: "/broker-logos/plus500.png",
  puprime: "/broker-logos/puprime.png",
  razormarkets: "/broker-logos/razormarkets.png",
  roboforex: "/broker-logos/roboforex.svg",
  robomarkets: "/broker-logos/robomarkets.png",
  skilling: "/broker-logos/skilling.png",
  swissquote: "/broker-logos/swissquote.png",
  the5ers: "/broker-logos/the5ers.png",
  thinkmarkets: "/broker-logos/thinkmarkets.png",
  tickmill: "/broker-logos/tickmill.svg",
  titanfx: "/broker-logos/titanfx.png",
  tmgm: "/broker-logos/tmgm.webp",
  topstep: "/broker-logos/topstep.png",
  trading212: "/broker-logos/trading212.png",
  valormarkets: "/broker-logos/valormarkets.png",
  vaultmarkets: "/broker-logos/vaultmarkets.png",
  "vault markets": "/broker-logos/vaultmarkets.png",
  vantagemarkets: "/broker-logos/vantagemarkets.png",
  vantage: "/broker-logos/vantagemarkets.png",
  vtmarkets: "/broker-logos/vtmarkets.png",
  xm: "/broker-logos/xm.png",
  xtb: "/broker-logos/xtb.png",
};

/** Domain → local logo (when site/hostname is known). */
const DOMAIN_LOCAL_LOGOS = {
  "razormarkets.co.za": "/broker-logos/razormarkets.png",
  "razormarkets.com": "/broker-logos/razormarkets.png",
  "icmarkets.com": "/broker-logos/icmarkets.png",
  "pepperstone.com": "/broker-logos/pepperstone.svg",
  "exness.com": "/broker-logos/exness.png",
  "xm.com": "/broker-logos/xm.png",
  "fpmarkets.com": "/broker-logos/fpmarkets.png",
  "tickmill.com": "/broker-logos/tickmill.svg",
  "blackbull.com": "/broker-logos/blackbull.png",
  "vantagemarkets.com": "/broker-logos/vantagemarkets.png",
  "fxpro.com": "/broker-logos/fxpro.png",
  "hfm.com": "/broker-logos/hfm.png",
  "octafx.com": "/broker-logos/octafx.png",
  "eightcap.com": "/broker-logos/eightcap.png",
  "oanda.com": "/broker-logos/oanda.svg",
  "forex.com": "/broker-logos/forex.png",
  "ig.com": "/broker-logos/ig.png",
  "avatrade.com": "/broker-logos/avatrade.png",
  "admiralmarkets.com": "/broker-logos/admiralmarkets.png",
  "axi.com": "/broker-logos/axi.svg",
  "activtrades.com": "/broker-logos/activtrades.png",
  "alpari.com": "/broker-logos/alpari.png",
  "bdswiss.com": "/broker-logos/bdswiss.png",
  "blueberrymarkets.com": "/broker-logos/blueberrymarkets.png",
  "capital.com": "/broker-logos/capital.png",
  "cmcmarkets.com": "/broker-logos/cmcmarkets.png",
  "darwinex.com": "/broker-logos/darwinex.png",
  "dukascopy.com": "/broker-logos/dukascopy.png",
  "easymarkets.com": "/broker-logos/easymarkets.png",
  "thinkmarkets.com": "/broker-logos/thinkmarkets.png",
  "tmgm.com": "/broker-logos/tmgm.webp",
  "fusionmarkets.com": "/broker-logos/fusionmarkets.svg",
  "roboforex.com": "/broker-logos/roboforex.svg",
  "robomarkets.com": "/broker-logos/robomarkets.png",
  "valormarkets.com": "/broker-logos/valormarkets.png",
  "vaultmarkets.trade": "/broker-logos/vaultmarkets.png",
  "vaultmarkets.com": "/broker-logos/vaultmarkets.png",
  "gbebrokers.com": "/broker-logos/gbebrokers.png",
  "fbs.com": "/broker-logos/fbs.png",
  "instaforex.com": "/broker-logos/instaforex.png",
  "swissquote.com": "/broker-logos/swissquote.png",
  "xtb.com": "/broker-logos/xtb.png",
  "ftmo.com": "/broker-logos/ftmo.png",
  "plus500.com": "/broker-logos/plus500.png",
  "etoro.com": "/broker-logos/etoro.png",
  "binance.com": "/broker-logos/binance.png",
  "bybit.com": "/broker-logos/bybit.png",
  "puprime.com": "/broker-logos/puprime.png",
  "titanfx.com": "/broker-logos/titanfx.png",
  "vtmarkets.com": "/broker-logos/vtmarkets.png",
  "litefinance.org": "/broker-logos/litefinance.png",
  "multibankfx.com": "/broker-logos/multibankfx.png",
  "nordfx.com": "/broker-logos/nordfx.png",
  "fundingpips.com": "/broker-logos/fundingpips.png",
  "fundednext.com": "/broker-logos/fundednext.png",
  "topstep.com": "/broker-logos/topstep.png",
  "the5ers.com": "/broker-logos/the5ers.png",
  "interactivebrokers.com": "/broker-logos/interactivebrokers.png",
  "trading212.com": "/broker-logos/trading212.png",
  "skilling.com": "/broker-logos/skilling.png",
  "deriv.com": "/broker-logos/deriv.png",
  "fxcm.com": "/broker-logos/fxcm.png",
  "fxopen.com": "/broker-logos/fxopen.png",
};

function normalizeCompanyKey(company) {
  return String(company || "")
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ");
}

/** Strip legal suffixes so "Razor Markets (Pty) Ltd" → "razormarkets". */
function slugifyCompany(company) {
  return String(company || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(
      /\b(pty|ltd|llc|inc|limited|group|corp|corporation|plc|sa|ag|gmbh|co|company|markets?|market|forex|fx|trading|capital|brokers?|brokerage|international|global)\b/gi,
      " "
    )
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Compact slug keeping brand words (for local logo lookup). */
function logoSlug(company) {
  const key = normalizeCompanyKey(company)
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(pty|ltd|llc|inc|limited|sa|ag|gmbh|plc|corp|corporation|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return key;
}

export function brokerInitials(company) {
  const words = String(company || "")
    .replace(/\(.*?\)/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w && !/^(pty|ltd|llc|inc|limited|sa|ag)$/i.test(w));
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
}

function domainFromSite(site) {
  const raw = String(site || "").trim();
  if (!raw) return "";
  try {
    const host = raw.includes("://")
      ? new URL(raw).hostname
      : raw.replace(/^www\./i, "");
    if (host.includes(".")) return host.replace(/^www\./i, "").toLowerCase();
  } catch {
    // ignore
  }
  return "";
}

export function resolveBrokerDomain(broker = {}) {
  const fromSite = domainFromSite(broker.site || broker.website || broker.domain);
  if (fromSite) {
    // Never trust wrong Magento park for Razor Markets brand
    if (
      fromSite === "razormarkets.com" &&
      /razor/i.test(String(broker.company || broker.name || ""))
    ) {
      return "razormarkets.co.za";
    }
    return fromSite;
  }

  const company = String(broker.company || "").trim();
  const server = String(broker.name || "").trim();
  const key = normalizeCompanyKey(company);
  if (key && key !== "unknown broker" && BROKER_DOMAINS[key]) return BROKER_DOMAINS[key];

  const stripped = key
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(pty|ltd|llc|inc|limited|sa)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && BROKER_DOMAINS[stripped]) return BROKER_DOMAINS[stripped];

  // From MT5 server name: "VaultMarkets-Live" → vaultmarkets / vault markets
  if (server) {
    const brand = server.split(/[-_]/)[0] || server;
    const compact = brand.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compact && BROKER_DOMAINS[compact]) return BROKER_DOMAINS[compact];
    const spaced = brand
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (spaced && BROKER_DOMAINS[spaced]) return BROKER_DOMAINS[spaced];
    if (compact.length >= 4) {
      // Prefer known local/domain maps before guessing .com
      if (DOMAIN_LOCAL_LOGOS[`${compact}.com`]) return `${compact}.com`;
      if (DOMAIN_LOCAL_LOGOS[`${compact}.trade`]) return `${compact}.trade`;
    }
  }

  // Word-boundary / token match only (avoid "Zora Capital" → capital.com).
  const tokens = stripped.split(/\s+/).filter(Boolean);
  const compactCompany = tokens.join("");
  let best = "";
  let bestLen = 0;
  for (const [name, domain] of Object.entries(BROKER_DOMAINS)) {
    const nameTokens = name.split(/\s+/).filter(Boolean);
    const nameCompact = nameTokens.join("");
    let hit = false;
    if (nameTokens.length > 1) {
      hit = nameTokens.every((t) => tokens.includes(t));
    } else {
      // Single-word brands: must be the primary brand token, not a later word
      // like "Capital" in "Zora Capital Limited".
      hit =
        stripped === name ||
        stripped.startsWith(`${name} `) ||
        compactCompany === nameCompact ||
        (tokens[0] === name && tokens.length <= 2);
    }
    if (hit && name.length > bestLen) {
      best = domain;
      bestLen = name.length;
    }
  }
  if (best) return best;

  const slug = slugifyCompany(company || server);
  if (slug.length >= 3 && slug !== "unknown") return `${slug}.com`;
  return "";
}

function resolveLocalLogo(broker = {}) {
  const domain = resolveBrokerDomain(broker);
  if (domain && DOMAIN_LOCAL_LOGOS[domain]) return DOMAIN_LOCAL_LOGOS[domain];

  const company = String(broker.company || "").trim();
  const server = String(broker.name || "").trim();
  const labels = [company, server, server.split(/[-_]/)[0] || ""].filter(Boolean);

  for (const label of labels) {
    const key = normalizeCompanyKey(label);
    if (!key || key === "unknown broker") continue;
    const spaced = key.replace(/\s+/g, "");
    const fullSlug = logoSlug(label);
    if (BROKER_LOCAL_LOGOS[fullSlug]) return BROKER_LOCAL_LOGOS[fullSlug];
    if (BROKER_LOCAL_LOGOS[spaced]) return BROKER_LOCAL_LOGOS[spaced];
    if (BROKER_LOCAL_LOGOS[key]) return BROKER_LOCAL_LOGOS[key];

    const compact = slugifyCompany(label);
    if (BROKER_LOCAL_LOGOS[compact]) return BROKER_LOCAL_LOGOS[compact];

    // CamelCase server brands: VaultMarkets → vaultmarkets
    const camel = String(label)
      .replace(/[-_].*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (camel && BROKER_LOCAL_LOGOS[camel]) return BROKER_LOCAL_LOGOS[camel];
  }

  const fullSlug = logoSlug(company || server);
  const spaced = normalizeCompanyKey(company || server).replace(/\s+/g, "");
  // Conservative partial match: only longer brand slugs, prefix/contains on company slug.
  for (const [slug, path] of Object.entries(BROKER_LOCAL_LOGOS)) {
    if (slug.length < 4) continue;
    if (
      fullSlug === slug ||
      spaced === slug ||
      (fullSlug.length >= slug.length && fullSlug.startsWith(slug)) ||
      (spaced.length >= slug.length && spaced.startsWith(slug)) ||
      (fullSlug.length >= 6 && slug.startsWith(fullSlug))
    ) {
      return path;
    }
  }
  return "";
}

/**
 * Logo URL candidates for a broker search row (first wins, then fallbacks).
 * Prefer official Search logo_url, then hosted brand marks, then favicons.
 */
export function resolveBrokerLogoCandidates(broker = {}) {
  const official = String(broker.logoUrl || "").trim();
  const local = resolveLocalLogo(broker);
  const domain = resolveBrokerDomain(broker);
  const remote = [];
  if (domain && !/^unknown\b/i.test(domain)) {
    remote.push(
      `https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`,
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
      `https://icon.horse/icon/${encodeURIComponent(domain)}`
    );
  }
  return [...new Set([official, local, ...remote].filter(Boolean))];
}

/** @deprecated prefer resolveBrokerLogoCandidates */
export function resolveBrokerLogoUrl(broker = {}) {
  return resolveBrokerLogoCandidates(broker)[0] || "";
}
