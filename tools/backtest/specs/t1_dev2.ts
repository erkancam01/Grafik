/** Trend Avcısı (15 dk) — laboratuvardan seçilen kural, dev2 (15 ay), 8 analiz coini, motorla doğrulama. */
import type { Spec } from "../sweep";

export default {
  name: "t1_dev2",
  script: "src/pine/library/trend_avcisi_strategy.pine",
  coins: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BCHUSDT", "DOTUSDT", "ETCUSDT", "TRXUSDT", "XLMUSDT"],
  window: "dev2",
  tf: 900,
  warmupDays: 120,
  grid: {},
} satisfies Spec;
