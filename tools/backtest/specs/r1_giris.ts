/**
 * T1: giriş modlarının üstünlük taraması — 3 sabit çıkış geometrisinde (1 saatlik ATR katı), başa baş ve süre
 * sınırı kapalı, komisyon koruması kapalı. "Rastgele yön" (UT sinyal anında yazı-tura, 10 tohum) kontrol grubudur:
 * üstünlük = mod ortalaması − aynı çıkışlarla rastgele ortalaması.
 */
import { DEV_COINS } from "../protocol";
import type { Spec } from "../sweep";

const EXITS: [number, number][] = [
  [0.5, 1.5],
  [1, 2],
  [1.5, 3],
];

export default {
  name: "r1_giris",
  script: "tools/backtest/pine/ut_bot_pro_research.pine",
  coins: DEV_COINS,
  window: "dev",
  base: { "En kısa kâr al mesafesi (%)": 0 },
  grid: {
    "Giriş modu": ["Devam", "Geri çekilme", "Ham", "Trend yönü", "Rastgele yön"],
    "Hassasiyet (anahtar değer)": [1, 2, 3],
    "Kâr al (ATR katı)": [0.5, 1, 1.5],
    "Zarar kes (ATR katı)": [1.5, 2, 3],
    "Rastgele tohum": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  },
  where: (c) =>
    EXITS.some(([tp, sl]) => c["Kâr al (ATR katı)"] === tp && c["Zarar kes (ATR katı)"] === sl) &&
    (c["Giriş modu"] === "Rastgele yön" || c["Rastgele tohum"] === 1),
} satisfies Spec;
