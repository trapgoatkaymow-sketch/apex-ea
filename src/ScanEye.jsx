import { useId } from "react";

/**
 * Unique signal-hunter eye — rotating search ring, drifting pupil,
 * aperture squeeze blink. No white fills.
 */
export default function ScanEye({ className = "", size = "lg", label = "Looking for signal" }) {
  const uid = useId().replace(/:/g, "");
  const irisId = `cs-hunt-iris-${uid}`;
  const clipId = `cs-hunt-clip-${uid}`;
  const glowId = `cs-hunt-glow-${uid}`;

  return (
    <div
      className={`cs-scan-eye cs-scan-eye--${size}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
    >
      <div className="cs-scan-eye-core" aria-hidden="true">
        <svg className="cs-scan-eye-svg" viewBox="0 0 80 56" overflow="visible">
          <defs>
            <radialGradient id={irisId} cx="38%" cy="34%" r="62%">
              <stop offset="0%" stopColor="#f0abfc" />
              <stop offset="42%" stopColor="#d946ef" />
              <stop offset="100%" stopColor="#4a044e" />
            </radialGradient>
            <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="1.4" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <clipPath id={clipId}>
              <ellipse cx="40" cy="28" rx="30" ry="16" />
            </clipPath>
          </defs>

          {/* Rotating radar / search ticks */}
          <g className="cs-scan-eye-radar" filter={`url(#${glowId})`}>
            <circle
              cx="40"
              cy="28"
              r="24"
              fill="none"
              stroke="rgba(232,121,249,0.35)"
              strokeWidth="1"
              strokeDasharray="2.5 5.5"
            />
            <circle
              className="cs-scan-eye-radar-ring"
              cx="40"
              cy="28"
              r="27.5"
              fill="none"
              stroke="rgba(244,114,182,0.55)"
              strokeWidth="1.2"
              strokeDasharray="6 10"
              strokeLinecap="round"
            />
          </g>

          {/* Almond lids — stroke only */}
          <path
            className="cs-scan-eye-lid cs-scan-eye-lid--top"
            d="M10 28 C22 10, 58 10, 70 28"
            fill="none"
            stroke="rgba(244,114,182,0.9)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            className="cs-scan-eye-lid cs-scan-eye-lid--bot"
            d="M10 28 C22 46, 58 46, 70 28"
            fill="none"
            stroke="rgba(216,180,254,0.75)"
            strokeWidth="1.7"
            strokeLinecap="round"
          />

          <g className="cs-scan-eye-iris-wrap" clipPath={`url(#${clipId})`}>
            <circle className="cs-scan-eye-iris" cx="40" cy="28" r="13" fill={`url(#${irisId})`} />
            <circle
              cx="40"
              cy="28"
              r="13"
              fill="none"
              stroke="rgba(251,207,232,0.35)"
              strokeWidth="0.8"
            />
            <circle
              className="cs-scan-eye-ringlet"
              cx="40"
              cy="28"
              r="9.2"
              fill="none"
              stroke="rgba(253,224,255,0.4)"
              strokeWidth="0.7"
              strokeDasharray="2 3"
            />
            <g className="cs-scan-eye-gaze">
              <circle className="cs-scan-eye-pupil" cx="40" cy="28" r="5.2" />
              <circle className="cs-scan-eye-spark" cx="37.4" cy="25.6" r="1.35" />
            </g>
            <rect className="cs-scan-eye-beam" x="39.2" y="14" width="1.6" height="28" rx="0.8" />
          </g>
        </svg>
      </div>
    </div>
  );
}
