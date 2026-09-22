/**
 * Interface 2 scanning overlay — robot sniper scope HUD.
 * Crosshair, range ticks, corner brackets, lock pulse.
 */
export default function SniperScan({
  className = "",
  size = "lg",
  label = "Sniper lock on",
}) {
  return (
    <div
      className={`cs-sniper cs-sniper--${size}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
    >
      <div className="cs-sniper-scope" aria-hidden="true">
        <span className="cs-sniper-ring cs-sniper-ring--outer" />
        <span className="cs-sniper-ring cs-sniper-ring--mid" />
        <span className="cs-sniper-ring cs-sniper-ring--inner" />

        <span className="cs-sniper-cross cs-sniper-cross--h" />
        <span className="cs-sniper-cross cs-sniper-cross--v" />

        <span className="cs-sniper-tick cs-sniper-tick--n" />
        <span className="cs-sniper-tick cs-sniper-tick--e" />
        <span className="cs-sniper-tick cs-sniper-tick--s" />
        <span className="cs-sniper-tick cs-sniper-tick--w" />

        <span className="cs-sniper-corner cs-sniper-corner--tl" />
        <span className="cs-sniper-corner cs-sniper-corner--tr" />
        <span className="cs-sniper-corner cs-sniper-corner--bl" />
        <span className="cs-sniper-corner cs-sniper-corner--br" />

        <span className="cs-sniper-dot" />
        <span className="cs-sniper-pulse" />

        <span className="cs-sniper-readout cs-sniper-readout--tl">RNG 0.00</span>
        <span className="cs-sniper-readout cs-sniper-readout--tr">LOCK</span>
        <span className="cs-sniper-readout cs-sniper-readout--bl">AZ · LOCK</span>
        <span className="cs-sniper-readout cs-sniper-readout--br">BOT-01</span>
      </div>
    </div>
  );
}
