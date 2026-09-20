import { useEffect, useMemo, useState } from "react";
import { brokerInitials, resolveBrokerLogoCandidates } from "./brokerLogos.js";
import { useApp } from "./store.jsx";

/** Compact logo + company name for the connected MT broker. */
export function BrokerMark({ broker, className = "", size = 28 }) {
  const candidates = useMemo(() => resolveBrokerLogoCandidates(broker), [broker]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [candidates]);
  const src = candidates[index] || "";
  const label = String(broker?.company || broker?.name || "Broker").trim() || "Broker";
  const initials = brokerInitials(label);

  return (
    <span
      className={`broker-mark${className ? ` ${className}` : ""}`}
      title={label}
      style={{ ["--broker-mark-size"]: `${size}px` }}
    >
      {src ? (
        <img
          className="broker-mark-logo"
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setIndex((v) => v + 1)}
        />
      ) : (
        <span className="broker-mark-logo is-fallback" aria-hidden="true">
          {initials}
        </span>
      )}
      <span className="broker-mark-name">{label}</span>
    </span>
  );
}

/** Shows connected MetaTrader broker logo + name when a session is armed. */
export default function ConnectedBrokerBadge({ className = "", size = 28 }) {
  const { mt5Session } = useApp();
  const broker = useMemo(() => {
    if (!mt5Session?.accountId) return null;
    return {
      company: String(mt5Session.company || mt5Session.server || "Broker").trim(),
      name: String(mt5Session.server || "").trim(),
    };
  }, [mt5Session?.accountId, mt5Session?.company, mt5Session?.server]);

  if (!broker) return null;
  return <BrokerMark broker={broker} className={className} size={size} />;
}
