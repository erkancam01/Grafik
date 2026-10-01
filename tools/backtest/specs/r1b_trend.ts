/**
 * T1b: daha uzun vadeli trend (4 saat, günlük) yönünde UT girişleri — T1'de 1 saatlik EMA50 yönü rastgeleden farksızdı.
 * Çıkışlar 1 saatlik ATR ile (1/2 ve 2/4); anahtar değer 2. "Rastgele yön" (6 tohum) aynı UT anlarında kontrol grubu.
 */
import { DEV_COINS } from "../protocol";
import type { Spec } from "../sweep";

const TRENDS: [string, number][] = [
  ["60", 200],
  ["240", 50],
  ["240", 200],
  ["D", 20],
  ["D", 50],
];

export default {
  name: "r1b_trend",
  script: "tools/backtest/pine/ut_bot_pro_research.pine",
  coins: DEV_COINS,
  window: "dev",
  warmupDays: 200,
  base: { "En kısa kâr al mesafesi (%)": 0, "Hassasiyet (anahtar değer)": 2 },
  grid: {
    "Giriş modu": ["Trend yönü", "Devam", "Geri çekilme", "Rastgele yön"],
    "Trend zaman dilimi": ["60", "240", "D"],
    "Trend EMA": [20, 50, 200],
    "Kâr al (ATR katı)": [1, 2],
    "Zarar kes (ATR katı)": [2, 4],
    "Rastgele tohum": [1, 2, 3, 4, 5, 6],
  },
  where: (c) =>
    TRENDS.some(([tf, len]) => c["Trend zaman dilimi"] === tf && c["Trend EMA"] === len) &&
    c["Zarar kes (ATR katı)"] === 2 * (c["Kâr al (ATR katı)"] as number) &&
    (c["Giriş modu"] === "Rastgele yön" ? c["Trend zaman dilimi"] === "60" && c["Trend EMA"] === 200 : c["Rastgele tohum"] === 1),
} satisfies Spec;
