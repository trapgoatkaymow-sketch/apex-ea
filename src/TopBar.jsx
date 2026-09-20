import { useApp } from "./store.jsx";
import ConnectedBrokerBadge from "./ConnectedBrokerBadge.jsx";

/** Header that lives inside the scrollable stage so title + toggle scroll away. */
export default function TopBar() {
  const { mainTextDisplay, toggleInterface } = useApp();
  // Both interfaces show the mentor portal username (never brand stamp / client name).
  const title = String(mainTextDisplay || "").trim();

  return (
    <header className="top">
      <p className="username" id="username">
        {title}
      </p>
      <div className="top-end">
        <ConnectedBrokerBadge className="top-broker" size={22} />
        <button
          className="iface-toggle"
          type="button"
          aria-label="Switch interface"
          title="Switch interface"
          onClick={toggleInterface}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 7.5h11.5M15.5 7.5 13 5m2.5 2.5L13 10M20 16.5H8.5M8.5 16.5 11 14M8.5 16.5 11 19"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <rect x="3.5" y="14" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
            <rect x="15.5" y="5" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      </div>
    </header>
  );
}
