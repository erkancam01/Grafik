/**
 * Deneme protokolü — hiçbir sonuca bakılmadan önce sabitlendi (değiştirilirse README'deki bakış kaydına yazılır).
 *
 * Hedef: 5 dk grafikte kapanan işlemlerin %70'i kârlı ("10 işlemin 7'si"), komisyon dahil toplamda kâr.
 * Ayarlar yalnız geliştirme döneminde (BTC/ETH/SOL) aranır; doğrulama en çok 2 kez, son sınav 1 kez açılır.
 * Tarih sınırları Türkiye saatine göre gün başı/sonu (Strateji Test Aracı'nın tarih kutuları gibi, src/ui/dates.ts).
 */

const IST = 3 * 3_600_000;

/** "YYYY-AA-GG" → o günün İstanbul saatiyle başı (ms, UTC). */
export function dayStart(s: string): number {
  return Date.parse(`${s}T00:00:00Z`) - IST;
}

/** "YYYY-AA-GG" → o günün İstanbul saatiyle sonu (ms, UTC). */
export function dayEnd(s: string): number {
  return dayStart(s) + 86_400_000 - 1;
}

export interface Window {
  key: string;
  name: string;
  from: number;
  to: number;
}

export const WINDOWS: Record<"back" | "dev" | "val" | "final", Window> = {
  back: { key: "back", name: "Geriye dönük yedek sınav", from: dayStart("2024-09-15"), to: dayEnd("2025-03-31") },
  dev: { key: "dev", name: "Geliştirme", from: dayStart("2025-04-01"), to: dayEnd("2026-03-31") },
  val: { key: "val", name: "Doğrulama", from: dayStart("2026-04-01"), to: dayEnd("2026-06-30") },
  final: { key: "final", name: "Son sınav", from: dayStart("2026-07-01"), to: dayEnd("2026-09-29") },
};

/** Ayarların arandığı coinler. */
export const DEV_COINS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
/** Hiç optimize edilmeyen coinler: yalnız son sınavda (tüm dönem) açılır. */
export const HOLDOUT_COINS = ["XRPUSDT", "BNBUSDT", "DOGEUSDT"];
/** Yedek coinler: yalnız son sınav başarısız olursa tek tekrarın yargılanmasında. */
export const RESERVE_COINS = ["ADAUSDT", "AVAXUSDT", "LINKUSDT", "LTCUSDT"];

/** Binance vadeli piyasa emri (taker), % / taraf; stres testi fonlama ve kaymayı kabaca karşılar. */
export const COMMISSION = 0.05;
export const STRESS_COMMISSION = 0.065;

/** Göstergelerin ısınması için test başından önce yüklenen gün (uygulamada 300 mum + 400 üst zaman dilimi mumu). */
export const WARMUP_DAYS = 30;

export const CRITERIA = {
  /** Son sınav: 6 coinin toplamı. */
  final: { pooledWinRate: 70, perCoinWinRate: 62, pooledAvgRet: 0, pooledPf: 1, pfCoins: 4, minTradesPerCoin: 80 },
  /** Geliştirmede aday sayılma şartı (son sınavdaki düşüşe pay). */
  dev: { pooledWinRate: 73, perCoinWinRate: 66, minTradesPerCoin: 150 },
};

export const LOOKS = { val: 2, final: 1, reserveRetry: 1 };
