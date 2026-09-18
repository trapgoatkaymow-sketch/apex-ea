export const DEFAULT_APP_COLOR = "#ff2d7a";

export const APP_COLOR_PRESETS = [
  { id: "pink", label: "Apex Pink", color: "#ff2d7a" },
  { id: "red", label: "Racing Red", color: "#ef4444" },
  { id: "orange", label: "Solar Orange", color: "#f97316" },
  { id: "gold", label: "Gold", color: "#eab308" },
  { id: "lime", label: "Lime", color: "#84cc16" },
  { id: "green", label: "Neon Green", color: "#22c55e" },
  { id: "teal", label: "Teal", color: "#14b8a6" },
  { id: "cyan", label: "Cyan", color: "#06b6d4" },
  { id: "blue", label: "Electric Blue", color: "#3b82f6" },
  { id: "indigo", label: "Indigo", color: "#6366f1" },
  { id: "violet", label: "Violet", color: "#8b5cf6" },
  { id: "fuchsia", label: "Fuchsia", color: "#d946ef" },
];

function clamp(n, min = 0, max = 255) {
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function normalizeHexColor(raw, fallback = DEFAULT_APP_COLOR) {
  let value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return fallback;
  if (!value.startsWith("#")) value = `#${value}`;
  if (/^#[0-9a-f]{3}$/.test(value)) {
    value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/.test(value)) return fallback;
  return value;
}

function hexToRgb(hex) {
  const value = normalizeHexColor(hex);
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((n) => clamp(n).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mix(hex, target, amount) {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  const t = Math.min(1, Math.max(0, amount));
  return rgbToHex(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t
  );
}

function darken(hex, amount) {
  return mix(hex, "#000000", amount);
}

function lighten(hex, amount) {
  return mix(hex, "#ffffff", amount);
}

export function deriveAppTheme(baseColor = DEFAULT_APP_COLOR) {
  const pink = normalizeHexColor(baseColor);
  return {
    pink,
    pinkHot: darken(pink, 0.08),
    magenta: mix(pink, lighten(pink, 0.12), 0.45),
    pinkSoft: lighten(pink, 0.16),
    pinkDeep: darken(pink, 0.28),
    pinkDark: darken(pink, 0.55),
    // Keep ambient wash in the chosen hue (do not blend toward a pink-black).
    glow: darken(pink, 0.78),
  };
}

function rgbChannels(hex) {
  const { r, g, b } = hexToRgb(hex);
  return `${r}, ${g}, ${b}`;
}

export function applyAppTheme(baseColor = DEFAULT_APP_COLOR) {
  if (typeof document === "undefined") return deriveAppTheme(baseColor);
  const theme = deriveAppTheme(baseColor);
  const root = document.documentElement;
  root.style.setProperty("--pink", theme.pink);
  root.style.setProperty("--pink-hot", theme.pinkHot);
  root.style.setProperty("--magenta", theme.magenta);
  root.style.setProperty("--pink-soft", theme.pinkSoft);
  root.style.setProperty("--pink-deep", theme.pinkDeep);
  root.style.setProperty("--pink-dark", theme.pinkDark);
  root.style.setProperty("--accent", theme.pink);
  root.style.setProperty("--accent-glow", theme.glow);
  root.style.setProperty("--pink-rgb", rgbChannels(theme.pink));
  root.style.setProperty("--pink-hot-rgb", rgbChannels(theme.pinkHot));
  root.style.setProperty("--magenta-rgb", rgbChannels(theme.magenta));
  root.style.setProperty("--pink-soft-rgb", rgbChannels(theme.pinkSoft));
  root.style.setProperty("--pink-deep-rgb", rgbChannels(theme.pinkDeep));
  root.style.setProperty("--pink-dark-rgb", rgbChannels(theme.pinkDark));
  root.dataset.appColor = theme.pink;
  return theme;
}
