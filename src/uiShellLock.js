/**
 * Monotonic UI shell generation — bump this whenever the live product UI
 * must never fall back to an older layout (e.g. circular V2 home, glass tabs,
 * robot stadium pills). Deployed app-version.json carries the same number.
 *
 * Gen 10 — I2 scan overlay RR style + fullscreen zoom viewer.
 */
export const UI_SHELL_GENERATION = 10;

export const UI_SHELL_LABEL = "v2-scan-overlay-zoom";

export const SHELL_GEN_STORAGE_KEY = "apexea-shell-gen-v1";
export const BUILD_ID_STORAGE_KEY = "apexea-build-id-v1";
export const RELOAD_SESSION_KEY = "apexea-build-reload-v1";
/** One-shot per tab — prevents infinite reload when a CDN still serves old HTML. */
export const RECOVERY_SESSION_KEY = "apexea-shell-recovery-v1";
