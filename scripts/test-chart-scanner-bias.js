import {
  chartBackgroundIsLight,
  classifyCandlePixel,
  explicitTradeSide,
  inferScannerSideFromBars,
  inferSideFromColorTally,
  lastBarSide,
  scannerConfidence,
  voteScannerSides,
} from "../src/chartScannerBias.js";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond, label) {
  if (!cond) throw new Error(label);
}

function stairBars(start, step, n, timeStep = 60_000) {
  const bars = [];
  let price = start;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const close = price + step;
    bars.push({
      time: i * timeStep,
      open,
      high: Math.max(open, close) + Math.abs(step) * 0.15,
      low: Math.min(open, close) - Math.abs(step) * 0.1,
      close,
    });
    price = close;
  }
  return bars;
}

function chopBars(n = 20) {
  const bars = [];
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const step = i % 2 === 0 ? 0.35 : -0.35;
    const open = price;
    const close = price + step;
    bars.push({
      time: i * 60_000,
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
    });
    price = close;
  }
  return bars;
}

const dump = stairBars(200, -1.2, 28);
const rally = stairBars(80, 0.9, 28);

assertEqual(inferScannerSideFromBars(dump).side, "SELL", "dumping gold-like bars → SELL");
assertEqual(inferScannerSideFromBars(rally).side, "BUY", "rallying bars → BUY");
assertEqual(inferScannerSideFromBars(chopBars()).side, null, "choppy bars stay unclear");
assertEqual(lastBarSide(dump), "SELL", "last dump bar is SELL");
assertEqual(lastBarSide(rally), "BUY", "last rally bar is BUY");
assertEqual(explicitTradeSide(""), null, "empty side is not BUY");
assertEqual(explicitTradeSide("buy"), "BUY", "buy label");
assertEqual(explicitTradeSide("SELL"), "SELL", "sell label");

const dumpVote = voteScannerSides([
  { ...inferScannerSideFromBars(dump), weight: 1.5 },
  { ...inferScannerSideFromBars(dump), weight: 1.25 },
  { ...inferScannerSideFromBars(dump), weight: 1 },
]);
assertEqual(dumpVote.side, "SELL", "M5/M15/M30 dump vote is SELL");
assertEqual(dumpVote.agree, 3, "all three TFs agree SELL");

const mixedVote = voteScannerSides([
  { side: "SELL", strength: 0.6, weight: 1.5 },
  { side: "SELL", strength: 0.4, weight: 1.25 },
  { side: "BUY", strength: 0.3, weight: 1 },
]);
assertEqual(mixedVote.side, "SELL", "recent dump beats lagging M30 BUY");

const rallyVote = voteScannerSides([
  { ...inferScannerSideFromBars(rally), weight: 1.5 },
  { ...inferScannerSideFromBars(rally), weight: 1.25 },
  { ...inferScannerSideFromBars(rally), weight: 1 },
]);
assertEqual(rallyVote.side, "BUY", "M5/M15/M30 rally vote is BUY");

const dumpConf = scannerConfidence({
  vote: dumpVote,
  usedLiveBars: true,
});
const mixedConf = scannerConfidence({
  vote: mixedVote,
  usedLiveBars: true,
});
const imageConf = scannerConfidence({
  vote: { side: "SELL", buyScore: 0, sellScore: 1, agree: 1, total: 1 },
  usedImage: true,
});
assert(dumpConf !== 72, "dump confidence is not the old hardcoded 72");
assert(mixedConf !== dumpConf, "confidence changes with agreement");
assert(imageConf < dumpConf, "image-only confidence is lower than live 3-TF");
assert(dumpConf >= 79 && dumpConf <= 86, `full agree confidence in 79-86, got ${dumpConf}`);
assert(mixedConf >= 67 && mixedConf <= 78, `2-vs-1 confidence in 67-78, got ${mixedConf}`);

assertEqual(chartBackgroundIsLight(210), true, "white MT5 paper is light");
assertEqual(chartBackgroundIsLight(20), false, "dark terminal is not light");

assertEqual(
  classifyCandlePixel(12, 12, 12, 255, { lightBackground: true }),
  "bear",
  "black bodies on light charts are bear candles"
);
assertEqual(
  classifyCandlePixel(12, 12, 12, 255, { lightBackground: false }),
  null,
  "black on dark charts is wallpaper, not a bull candle"
);
assertEqual(
  classifyCandlePixel(40, 200, 50, 255, { lightBackground: true }),
  "bull",
  "lime body is bull"
);
assertEqual(
  classifyCandlePixel(210, 40, 40, 255, { lightBackground: true }),
  "bear",
  "red body is bear"
);
assertEqual(
  inferSideFromColorTally(100, 12),
  "BUY",
  "strong green majority is BUY"
);
assertEqual(
  inferSideFromColorTally(12, 100),
  "SELL",
  "strong black/red majority is SELL"
);
assertEqual(
  inferSideFromColorTally(3, 1),
  null,
  "tiny leftover blue pixels are not a BUY"
);
assertEqual(
  inferSideFromColorTally(52, 48),
  null,
  "coin-flip colors stay unclear"
);

console.log("chartScannerBias ok");
