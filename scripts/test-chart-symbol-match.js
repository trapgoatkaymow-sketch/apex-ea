import {
  matchSymbolFromText,
  inferSymbolFromPrices,
  parseChartPrices,
  preferChartSpelling,
} from "../src/chartSymbolMatch.js";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const catalog = ["XAUUSD.p", "EURUSD", ".US30.", "NAS100", "GBPUSD"];

assertEqual(
  matchSymbolFromText("XAUUSD  M1  Gold vs US Dollar", catalog),
  "XAUUSD",
  "chart header XAUUSD must stay bare — not catalog XAUUSD.p"
);
assertEqual(
  preferChartSpelling("XAUUSD", catalog),
  "XAUUSD",
  "preferChartSpelling keeps bare gold"
);
assertEqual(
  matchSymbolFromText("XAUUSD.p M15", catalog),
  "XAUUSD.p",
  "keeps suffix only when it is on the chart"
);
assertEqual(
  matchSymbolFromText("Wall Street 30  H1", catalog),
  "US30",
  "wall street phrase → bare US30 (not forced .US30.)"
);
assertEqual(
  matchSymbolFromText("NASDAQ 100", catalog),
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
  "XAUUSD",
  "OCR O/0 confusion stays bare"
);
assertEqual(
  matchSymbolFromText("German 40 Index", ["GER40", "US30"]),
  "GER40",
  "german 40"
);
assertEqual(
  matchSymbolFromText("SPOT GOLD", ["XAUUSD.p", "EURUSD"]),
  "XAUUSD",
  "GOLD phrase → bare XAUUSD, not .p"
);
assertEqual(
  inferSymbolFromPrices([4212, 4218, 4205], catalog),
  "XAUUSD",
  "gold from price axis stays bare"
);
assertEqual(
  inferSymbolFromPrices([44820, 44910], catalog),
  "US30",
  "US30 from price axis stays bare"
);
assertEqual(parseChartPrices("4,215.80\n4,198.20").join(","), "4215.8,4198.2", "price parse");

console.log("chartSymbolMatch ok");
