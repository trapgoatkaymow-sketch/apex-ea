import { CONNECT_ENGINE_STEPS, TRADE_ENGINE_STEPS } from "./chartScanner.js";

export default function EnginePanel({
  mode = "idle",
  title,
  subtitle,
  stepIndex = 0,
  logs = [],
  signal = null,
  fills = [],
}) {
  if (mode === "idle") return null;

  const steps =
    mode === "connecting"
      ? CONNECT_ENGINE_STEPS
      : mode === "scanning" || mode === "trading"
        ? TRADE_ENGINE_STEPS
        : [];

  const activeTitle =
    title ||
    (mode === "connecting"
      ? "Connecting Engine"
      : mode === "scanning"
        ? "Trading Engine · Analyzing"
        : "Trading Engine · Executing");

  return (
    <div className={`engine-panel engine-panel--${mode}`} role="status" aria-live="polite">
      <div className="engine-panel-core">
        <div className="engine-ring" aria-hidden="true">
          <span className="engine-ring-spin" />
          <span className="engine-ring-core" />
        </div>
        <div className="engine-copy">
          <p className="engine-kicker">ApexEA</p>
          <h3 className="engine-title">{activeTitle}</h3>
          {subtitle ? <p className="engine-sub">{subtitle}</p> : null}
        </div>
      </div>

      {steps.length ? (
        <ol className="engine-steps">
          {steps.map((step, index) => {
            const state =
              index < stepIndex ? "done" : index === stepIndex ? "active" : "pending";
            return (
              <li key={step.id} className={`engine-step is-${state}`}>
                <span className="engine-step-mark" />
                <span>{step.label}</span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {signal ? (
        <div className={`engine-signal engine-signal--${String(signal.side).toLowerCase()}`}>
          <strong>
            {signal.side} {signal.symbol}
          </strong>
          <span>{signal.confidence}% confidence</span>
        </div>
      ) : null}

      {fills?.length ? (
        <ul className="engine-fills">
          {fills.map((fill, index) => (
            <li key={`${fill.symbol}-${index}`}>
              {fill.ok === false
                ? `Failed · ${fill.error || "order rejected"}`
                : `Filled · ${fill.side} ${fill.symbol} ${fill.volume}`}
            </li>
          ))}
        </ul>
      ) : null}

      {logs?.length ? (
        <ul className="engine-log">
          {logs.slice(-6).map((line, index) => (
            <li key={`${line}-${index}`}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
