import {
  nextAutoExtendEndMs,
  GIVEAWAY_AUTO_EXTEND_HOURS,
  GIVEAWAY_AUTO_EXTEND_AT_MS,
} from "../api/paypal/_robotPurchase.js";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const now = Date.parse("2026-10-04T16:00:00.000Z");
const twentyOneH = 21 * 60 * 60 * 1000;

assertEqual(
  nextAutoExtendEndMs({
    remainingMs: 3 * 60 * 1000,
    nowMs: now,
    autoExtendUntilStopped: true,
  }),
  null,
  "3 minutes left does not auto-extend yet"
);

assertEqual(
  nextAutoExtendEndMs({
    remainingMs: 2 * 60 * 1000,
    nowMs: now,
    autoExtendUntilStopped: true,
  }),
  now + twentyOneH,
  "exactly 2 minutes left jumps to 21 hours"
);

assertEqual(
  nextAutoExtendEndMs({
    remainingMs: 30_000,
    nowMs: now,
    autoExtendUntilStopped: true,
  }),
  now + twentyOneH,
  "30 seconds left jumps to 21 hours"
);

assertEqual(
  nextAutoExtendEndMs({
    remainingMs: 0,
    nowMs: now,
    autoExtendUntilStopped: true,
  }),
  now + twentyOneH,
  "already ended still auto-extends while rolling is on"
);

assertEqual(
  nextAutoExtendEndMs({
    remainingMs: 0,
    nowMs: now,
    autoExtendUntilStopped: false,
  }),
  null,
  "manual stop means ended stays ended"
);

assertEqual(GIVEAWAY_AUTO_EXTEND_HOURS, 21, "default 21 hours");
assertEqual(GIVEAWAY_AUTO_EXTEND_AT_MS, 120000, "default 2 minutes");

console.log("giveaway auto-extend ok");
