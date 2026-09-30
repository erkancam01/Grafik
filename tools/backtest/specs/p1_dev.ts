/** UT Bot Pro Strateji (15 dk) — analizden çıkan kural, geliştirme dönemi, motorla doğrulama (ayar araması yok). */
import type { Spec } from "../sweep";

export default {
  name: "p1_dev",
  script: "src/pine/library/ut_bot_pro_strategy.pine",
  coins: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BCHUSDT", "DOTUSDT", "ETCUSDT", "TRXUSDT", "XLMUSDT"],
  window: "dev",
  tf: 900,
  grid: {},
} satisfies Spec;
