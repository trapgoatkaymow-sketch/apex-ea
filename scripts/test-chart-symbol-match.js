import { matchSymbolFromText, inferSymbolFromPrices, parseChartPrices } from "../src/chartSymbolMatch.js";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const catalog = ["XAUUSDp", "EURUSD", ".US30.", "NAS100", "GBPUSD"];

assertEqual(
  matchSymbolFromText("XAUUSD+  M15  gold spot", catalog),
  "XAUUSDp",
  "gold ticker maps to catalog suffix"
);
assertEqual(
  matchSymbolFromText("Wall Street 30  H1", catalog),
  ".US30.",
  "wall street phrase maps to US30 catalog spelling"
);
assertEqual(
  matchSymbolFromText("NASDAQ 100  USTEC", catalog),
  "NAS100",
  "nasdaq phrase"
);
assertEqual(
  matchSymbolFromText("Symbol: EUR/USD", catalog),
  "EURUSD",
  "slashed pair"
);
assertEqual(
  matchSymbolFromText("XA0USD M15", catalog),
  "XAUUSDp",
  "OCR O/0 confusion"
);
assertEqual(
  matchSymbolFromText("German 40 Index", ["GER40", "US30"]),
  "GER40",
  "german 40"
);
assertEqual(
  inferSymbolFromPrices([4212, 4218, 4205], catalog),
  "XAUUSDp",
  "gold from price axis"
);
assertEqual(
  inferSymbolFromPrices([44820, 44910], catalog),
  ".US30.",
  "US30 from price axis"
);
assertEqual(parseChartPrices("4,215.80\n4,198.20").join(","), "4215.8,4198.2", "price parse");

console.log("chartSymbolMatch ok");
