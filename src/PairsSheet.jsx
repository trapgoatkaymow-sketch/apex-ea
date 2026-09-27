import { useMemo, useState } from "react";
import { useApp } from "./store.jsx";

export default function PairsSheet() {
  const {
    pairsOpen,
    setPairsOpen,
    catalog,
    appSymbols,
    addAppSymbol,
    removeSymbolEverywhere,
    normalizeSymbol,
  } = useApp();
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");

  const selected = useMemo(
    () => catalog.filter((s) => appSymbols.has(s)),
    [catalog, appSymbols]
  );

  const available = useMemo(() => {
    const q = String(query || "")
      .trim()
      .toLowerCase();
    return catalog.filter((s) => {
      if (appSymbols.has(s)) return false;
      if (!q) return true;
      return String(s).toLowerCase().includes(q);
    });
  }, [catalog, appSymbols, query]);

  if (!pairsOpen) return null;

  function handleAddCustom(event) {
    event?.preventDefault?.();
    const symbol = normalizeSymbol(custom);
    if (!symbol) return;
    addAppSymbol?.(symbol);
    setCustom("");
    setQuery("");
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
            <p>Add the markets you want on this phone</p>
          </div>
          <span className="pairs-count">{selected.length} active</span>
        </header>

        <form className="pairs-add-row" onSubmit={handleAddCustom}>
          <label className="pairs-field">
            <span>Add a pair</span>
            <input
              type="text"
              value={custom}
              onChange={(e) => setCustom(e.target.value.toUpperCase())}
              placeholder="e.g. XAUUSD or EURUSD"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
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

        <section className="pairs-section">
          <div className="pairs-section-head">
            <h3>On your app</h3>
            <span>{selected.length}</span>
          </div>
          <p className="pairs-note">
            Tap a pair to remove it. These are your symbols — not locked by Manage EA.
          </p>
          {selected.length === 0 ? (
            <div className="pairs-empty-card">
              <strong>No pairs yet</strong>
              <p>Add from the list below, or type a custom symbol above.</p>
            </div>
          ) : (
            <div className="symbol-list">
              {selected.map((symbol) => (
                <button
                  key={symbol}
                  type="button"
                  className="symbol-chip is-selected"
                  onClick={() => removeSymbolEverywhere(symbol)}
                  aria-label={`Remove ${symbol}`}
                >
                  <span>{symbol}</span>
                  <span className="chip-x" aria-hidden="true">
                    ×
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="pairs-section">
          <div className="pairs-section-head">
            <h3>Browse & add</h3>
            <span>{available.length}</span>
          </div>
          <label className="pairs-search">
            <span className="sr-only">Search pairs</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search catalog…"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <p className="pairs-note">Tap any symbol to add it to your app.</p>
          {available.length === 0 ? (
            <p className="pairs-empty">
              {query.trim()
                ? `No catalog match for “${query.trim()}” — type it above to add.`
                : "Every catalog pair is already on your app."}
            </p>
          ) : (
            <div className="symbol-list is-catalog">
              {available.map((symbol) => (
                <button
                  key={symbol}
                  type="button"
                  className="symbol-chip is-available"
                  onClick={() => addAppSymbol?.(symbol)}
                  aria-label={`Add ${symbol}`}
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
