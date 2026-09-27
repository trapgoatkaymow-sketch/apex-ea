import { useEffect, useState } from "react";
import { useApp } from "./store.jsx";

/** Interface 1 — ask lot / action / platform / trades after picking a pair. */
export default function SymbolEditSheet() {
  const {
    symbolSetupOpen,
    setSymbolSetupOpen,
    editingSymbol,
    setEditingSymbol,
    getSymbolMeta,
    saveSymbolMeta,
    removeSymbolEverywhere,
  } = useApp();

  const [lotSize, setLotSize] = useState("0.01");
  const [action, setAction] = useState("BOTH");
  const [platform, setPlatform] = useState("MT5");
  const [trades, setTrades] = useState("1");

  useEffect(() => {
    if (!symbolSetupOpen || !editingSymbol) return;
    const meta = getSymbolMeta(editingSymbol);
    setLotSize(String(meta.lotSize ?? "0.01"));
    setAction(meta.action || "BOTH");
    setPlatform(meta.platform || "MT5");
    setTrades(String(meta.trades ?? 1));
  }, [symbolSetupOpen, editingSymbol, getSymbolMeta]);

  if (!symbolSetupOpen || !editingSymbol) return null;

  function close() {
    setSymbolSetupOpen(false);
    setEditingSymbol(null);
  }

  function handleSave(event) {
    event?.preventDefault?.();
    saveSymbolMeta(editingSymbol, {
      lotSize: Number(String(lotSize).replace(",", ".")) || 0.01,
      action,
      platform,
      trades: Math.max(1, Math.floor(Number(trades) || 1)),
    });
    close();
  }

  function handleRemove() {
    removeSymbolEverywhere(editingSymbol);
    close();
  }

  return (
    <div className="symbol-setup-sheet">
      <div className="symbol-setup-backdrop" onClick={close} />
      <div
        className="symbol-setup-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Set up ${editingSymbol}`}
      >
        <header className="symbol-setup-header">
          <button
            className="symbol-setup-back"
            type="button"
            onClick={close}
            aria-label="Close symbol setup"
          >
            ←
          </button>
          <h2 className="symbol-setup-title">{editingSymbol}</h2>
          <button
            className="symbol-setup-trash"
            type="button"
            onClick={handleRemove}
            aria-label={`Remove ${editingSymbol}`}
          >
            🗑
          </button>
        </header>

        <p className="symbol-setup-note">
          Set how this pair should trade on your phone, then save.
        </p>

        <form className="symbol-setup-form" onSubmit={handleSave}>
          <label className="symbol-setup-field">
            <span>Lot Size</span>
            <input
              type="text"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              placeholder="0.01"
              value={lotSize}
              onChange={(e) => setLotSize(e.target.value.replace(/[^\d.,]/g, ""))}
              onBlur={() => {
                const n = Number(String(lotSize).replace(",", "."));
                setLotSize(
                  Number.isFinite(n) && n > 0 ? String(Number(n.toFixed(4))) : "0.01"
                );
              }}
            />
          </label>
          <label className="symbol-setup-field">
            <span>Action</span>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
              <option value="BOTH">BOTH</option>
            </select>
          </label>
          <label className="symbol-setup-field">
            <span>Platform</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="MT4">MT4</option>
              <option value="MT5">MT5</option>
            </select>
          </label>
          <label className="symbol-setup-field">
            <span>Number of Trades</span>
            <input
              type="number"
              min="1"
              value={trades}
              onChange={(e) => setTrades(e.target.value)}
            />
          </label>
          <button className="symbol-setup-save" type="submit">
            Save Symbol
          </button>
        </form>
      </div>
    </div>
  );
}
