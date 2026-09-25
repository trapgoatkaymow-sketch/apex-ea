/**
 * Monotonic UI shell generation — bump this whenever the live product UI
 * must never fall back to an older layout.
 *
 * Gen 40 — PRODUCT LOCK. Current Interface 1 + Interface 2 + admin/mentor
 * portals are frozen. Clients on any older shell must reload to live.
 * Gen 41 — Brevo license-key emails when mentors generate keys.
 * Gen 53 — One license email per unused client+bot key (no duplicate sends).
 * Gen 54 — Still email every new key; only block duplicate sends of the same key.
 * Gen 55 — Live MT5 balance + license info icon on robot rows.
 * Gen 56 — Fix PascalCase AccountSummary parse + visible license key icon.
 * Gen 57 — Live floating profit = equity − balance on MetaTrader card.
 * Gen 58 — Floating from open orders / AccountSummary.Profit; profit color blue.
 * Gen 59 — Close all positions button on connected MetaTrader card.
 * Gen 60 — Android APK v2.23 with close-all positions baked in.
 * Gen 61 — Restore Economic calendar button on Interface 1 + 2 Home.
 * Gen 62 — Fix license details card clipping / Created row cut off.
 * Gen 63 — Android APK 2.23.2 with license card fix.
 * Gen 64 — Remove Economic calendar from Interface 2 Home only.
 * Gen 65 — Android APK 2.23.3 without Interface 2 Economic calendar.
 * Gen 66 — Stable /android download link + APK 2.24.0.
 * Gen 67 — Android EA photo loads on the hero and the robot bubble.
 * Gen 68 — Lock Chart Scanner SCAN LOCK HUD on Android for both interfaces.
 * Gen 69 — Classic glowing orb Chart Scanner on both interfaces (Android lock).
 * Gen 70 — Restore Interface 2 SCAN LOCK portal + desk Trading Engine.
 * Gen 71 — Old license keys reclaim on same email after reinstall.
 * Gen 72 — Mentor or client email can reclaim used keys; drop stuck restore toast.
 * Gen 73 — Android EA photos: name/sibling botId fallback when key still has logo.
 * Gen 73 FREEZE — User confirmed product is good. Do not change Interface 1/2,
 * CoverLock, scanner, EA photos, or license reclaim without an explicit new ask.
 * Floor raised to 73 so older shells cannot stick on phones.
 * Gen 74 — Super admin Client Management: Delete under Paid (+ Bypassed) emails.
 * Do not lower this number. Only raise it when intentionally shipping a
 * new locked product UI.
 */
export const UI_SHELL_GENERATION = 74;

/** Stable lock label written to app-version.json and document dataset. */
export const UI_SHELL_LABEL = "product-frozen-stable";

/**
 * Floor for the locked product. Any running shell below this that can reach
 * live app-version.json must upgrade. Keep equal to UI_SHELL_GENERATION
 * while the product is locked.
 */
export const UI_SHELL_FLOOR = 74;

/** Product UI is frozen — old interfaces must not stick on devices. */
export const UI_SHELL_LOCKED = true;

export const SHELL_GEN_STORAGE_KEY = "apexea-shell-gen-v1";
export const BUILD_ID_STORAGE_KEY = "apexea-build-id-v1";
export const RELOAD_SESSION_KEY = "apexea-build-reload-v1";
/** One-shot per tab — prevents infinite reload when a CDN still serves old HTML. */
export const RECOVERY_SESSION_KEY = "apexea-shell-recovery-v1";
export const LOCK_WATERMARK_KEY = "apexea-ui-lock-floor-v1";
