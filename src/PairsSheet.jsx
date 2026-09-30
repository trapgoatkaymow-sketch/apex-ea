import { useMemo, useState } from "react";
import { useApp } from "./store.jsx";

export default function PairsSheet() {
  const {
    pairsOpen,
    setPairsOpen,
    catalog,
    appSymbols,
    addAppSymbol,
    openSymbolSetup,
    normalizeSymbol,
    activeBot,
    licenseKeys,
  } = useApp();
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");

  // Mentor-authored symbols for this robot (from the license / EA), not the
  // global default forex catalog.
  const mentorSymbols = useMemo(() => {
    const botId = String(activeBot?.id || "").trim();
    const license =
      (Array.isArray(licenseKeys) ? licenseKeys : []).find(
        (row) => String(row?.botId || row?.bot?.id || "").trim() === botId
      ) || null;
    const fromLicense = Array.isArray(license?.bot?.symbols)
      ? license.bot.symbols
      : [];
    const fromBot = Array.isArray(activeBot?.symbols) ? activeBot.symbols : [];
    const raw = fromLicense.length ? fromLicense : fromBot;
    const out = [];
    const seen = new Set();
    for (const rawSym of raw) {
      const clean = normalizeSymbol?.(rawSym) || String(rawSym || "").trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
    return out;
  }, [activeBot, licenseKeys, normalizeSymbol]);

  // Include typed custom broker symbols even if catalog state lags behind.
  const selected = useMemo(() => {
    const fromCatalog = catalog.filter((s) => appSymbols.has(s));
    const extras = Array.from(appSymbols).filter(
      (s) =>
        !fromCatalog.some(
          (c) => String(c).toLowerCase() === String(s).toLowerCase()
        )
    );
    return [...fromCatalog, ...extras];
  }, [catalog, appSymbols]);

  const available = useMemo(() => {
    const q = String(query || "")
      .trim()
      .toLowerCase();
    const selectedKeys = new Set(
      Array.from(appSymbols).map((s) => String(s).toLowerCase())
    );
    return mentorSymbols.filter((s) => {
      const key = String(s).toLowerCase();
      if (selectedKeys.has(key)) return false;
      if (!q) return true;
      return key.includes(q);
    });
  }, [mentorSymbols, appSymbols, query]);

  if (!pairsOpen) return null;

  function beginSetup(rawSymbol, { addFirst = false } = {}) {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return;
    if (addFirst) {
      const ok = addAppSymbol?.(symbol, { quiet: true });
      if (ok === false) return;
    }
    openSymbolSetup?.(symbol);
    setCustom("");
    setQuery("");
  }

  function handleAddCustom(event) {
    event?.preventDefault?.();
    beginSetup(custom, { addFirst: true });
  }

  return (
    <div className="pairs-sheet">
      <div className="pairs-backdrop" onClick={() => setPairsOpen(false)} />
      <div className="pairs-panel" role="dialog" aria-modal="true" aria-label="Your pairs">
        <header className="pairs-header">
          <button
            className="pairs-back"
            type="button"
            onClick={() => setPairsOpen(false)}
            aria-label="Close pairs"
          >
            ←
          </button>
          <div className="pairs-header-copy">
            <h2>Your pairs</h2>
            <p>Add a pair, then set lot size and trades</p>
          </div>
          <span className="pairs-count">{selected.length} active</span>
        </header>

        <form className="pairs-add-row" onSubmit={handleAddCustom}>
          <label className="pairs-field">
            <span>Type your broker symbol</span>
            <input
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/\s+/g, ""))}
              placeholder="e.g. XAUUSDm, EURUSD.r, .US30."
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              inputMode="text"
              autoComplete="off"
            />
          </label>
          <button
            className="pairs-add-btn"
            type="submit"
            disabled={!String(custom || "").trim()}
          >
            Add
          </button>
        </form>
        <p className="pairs-note pairs-custom-hint">
          Can’t find your pair? Type the exact symbol from your broker, then tap Add
          — you can edit lot size and trades after.
        </p>

        <section className="pairs-section">
          <div className="pairs-section-head">
            <h3>On your app</h3>
            <span>{selected.length}</span>
          </div>
          <p className="pairs-note">
            Tap a pair to edit lot size, action, platform, and trades.
          </p>
          {selected.length === 0 ? (
            <div className="pairs-empty-card">
              <strong>No pairs yet</strong>
              <p>Add from your mentor’s list below, or type a custom symbol above.</p>
            </div>
          ) : (
            <div className="symbol-list">
              {selected.map((symbol) => (
                <button
                  key={symbol}
                  type="button"
                  className="symbol-chip is-selected"
                  onClick={() => beginSetup(symbol)}
                  aria-label={`Edit ${symbol}`}
                >
                  <span>{symbol}</span>
                  <span className="chip-edit" aria-hidden="true">
                    ✎
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="pairs-section">
          <div className="pairs-section-head">
            <h3>Mentor symbols</h3>
            <span>{available.length}</span>
          </div>
          <label className="pairs-search">
            <span className="sr-only">Search mentor symbols</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search mentor symbols…"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <p className="pairs-note">
            Only symbols your mentor added to this EA. Tap one to add it — then set lot size.
          </p>
          {available.length === 0 ? (
            <p className="pairs-empty">
              {query.trim()
                ? `No mentor symbol match for “${query.trim()}” — type your broker symbol above to add.`
                : mentorSymbols.length === 0
                  ? "Your mentor hasn’t added symbols to this EA yet — type your broker symbol above."
                  : "Every mentor symbol is already on your app."}
            </p>
          ) : (
            <div className="symbol-list is-catalog">
              {available.map((symbol) => (
                <button
                  key={symbol}
                  type="button"
                  className="symbol-chip is-available"
                  onClick={() => beginSetup(symbol, { addFirst: true })}
                  aria-label={`Add and set up ${symbol}`}
                >
                  <span>{symbol}</span>
                  <span className="chip-plus" aria-hidden="true">
                    +
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
