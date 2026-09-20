import { useId } from "react";

/**
 * Slow-blinking eye — used while the scanner is hunting for a signal.
 */
export default function ScanEye({ className = "", size = "lg", label = "Looking for signal" }) {
  const uid = useId().replace(/:/g, "");
  const irisId = `cs-eye-iris-${uid}`;

  return (
    <div
      className={`cs-scan-eye cs-scan-eye--${size}${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
    >
      <div className="cs-scan-eye-orbit" aria-hidden="true">
        <svg className="cs-scan-eye-svg" viewBox="0 0 64 40">
          <defs>
            <radialGradient id={irisId} cx="42%" cy="38%" r="55%">
              <stop offset="0%" stopColor="#f9a8d4" />
              <stop offset="45%" stopColor="#e879f9" />
              <stop offset="100%" stopColor="#a21caf" />
            </radialGradient>
            <clipPath id={`cs-eye-clip-${uid}`}>
              <ellipse cx="32" cy="20" rx="28" ry="16" />
            </clipPath>
          </defs>
          <ellipse
            className="cs-scan-eye-outline"
            cx="32"
            cy="20"
            rx="29"
            ry="17"
            fill="none"
          />
          <g clipPath={`url(#cs-eye-clip-${uid})`}>
            <circle className="cs-scan-eye-iris" cx="32" cy="20" r="10.5" fill={`url(#${irisId})`} />
            <circle className="cs-scan-eye-pupil" cx="32" cy="20" r="4.8" />
            <circle className="cs-scan-eye-glint" cx="28.2" cy="16.2" r="1.8" />
            <rect className="cs-scan-eye-lid" x="0" y="0" width="64" height="40" />
          </g>
        </svg>
      </div>
    </div>
  );
}
