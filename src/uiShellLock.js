/**
 * Monotonic UI shell generation — bump this whenever the live product UI
 * must never fall back to an older layout.
 *
 * Gen 40 — PRODUCT LOCK. Current Interface 1 + Interface 2 + admin/mentor
 * portals are frozen. Clients on any older shell must reload to live.
 * Gen 41 — Brevo license-key emails when mentors generate keys.
 * Do not lower this number. Only raise it when intentionally shipping a
 * new locked product UI.
 */
export const UI_SHELL_GENERATION = 47;

/** Stable lock label written to app-version.json and document dataset. */
export const UI_SHELL_LABEL = "product-locked-mentor-reset";

/**
 * Floor for the locked product. Any running shell below this that can reach
 * live app-version.json must upgrade. Keep equal to UI_SHELL_GENERATION
 * while the product is locked.
 */
export const UI_SHELL_FLOOR = 46;

/** Product UI is frozen — old interfaces must not stick on devices. */
export const UI_SHELL_LOCKED = true;

export const SHELL_GEN_STORAGE_KEY = "apexea-shell-gen-v1";
export const BUILD_ID_STORAGE_KEY = "apexea-build-id-v1";
export const RELOAD_SESSION_KEY = "apexea-build-reload-v1";
/** One-shot per tab — prevents infinite reload when a CDN still serves old HTML. */
export const RECOVERY_SESSION_KEY = "apexea-shell-recovery-v1";
export const LOCK_WATERMARK_KEY = "apexea-ui-lock-floor-v1";
