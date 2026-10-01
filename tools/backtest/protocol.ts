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

export const WINDOWS: Record<"back" | "dev" | "val" | "dev2" | "final", Window> = {
  back: { key: "back", name: "Geriye dönük yedek sınav", from: dayStart("2024-09-15"), to: dayEnd("2025-03-31") },
  dev: { key: "dev", name: "Geliştirme", from: dayStart("2025-04-01"), to: dayEnd("2026-03-31") },
  val: { key: "val", name: "Doğrulama", from: dayStart("2026-04-01"), to: dayEnd("2026-06-30") },
  /** 2. aşama geliştirme: eski geliştirme + doğrulama (doğrulamaya bir kez bakıldı; bkz. değişiklik kaydı). */
  dev2: { key: "dev2", name: "Geliştirme (15 ay)", from: dayStart("2025-04-01"), to: dayEnd("2026-06-30") },
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

export interface Criteria {
  /** Toplam kazanma oranı alt sınırı (yoksa yalnız raporlanır). */
  pooledWinRate?: number;
  perCoinWinRate?: number;
  pooledAvgRet: number;
  pooledPf: number;
  pfCoins?: number;
}

export const CRITERIA: { final: Criteria; holdout: Criteria; dev: { pooledWinRate: number; perCoinWinRate: number; minTradesPerCoin: number } } = {
  /** Son sınav: son 3 ay × 6 coinin toplamı (coin sonuçları bilgi amaçlı). Kâr hedefli (bkz. değişiklik kaydı). */
  final: { pooledAvgRet: 0, pooledPf: 1 },
  /** Görülmemiş coinler (XRP/BNB/DOGE) × tüm veri dönemi. */
  holdout: { pooledAvgRet: 0, pooledPf: 1, pfCoins: 2 },
  /** Geliştirmede aday sayılma şartı (son sınavdaki düşüşe pay). */
  dev: { pooledWinRate: 73, perCoinWinRate: 66, minTradesPerCoin: 50 },
};

/**
 * Değişiklik kaydı — doğrulama ve son sınav dönemlerine hiç bakılmadan önce yapıldı:
 * 2026-09-30  Grafik 5 dk → 15 dk (kullanıcı isteği). Yöntem deneme-yanılmayla değil geliştirme verisinin
 *             analiziyle kuruldu (analyze.py, candle_study.py): UT trendi yönünde gövdesi 3×ATR'yi aşan mum →
 *             sonraki açılışta giriş, 1s ATR ile kâr al 1 / zarar kes 2, en çok 1 gün. İşlem sıklığı coin başına
 *             ayda ~7-10 olduğundan son sınavdaki "coin başına ≥ 80 işlem" ve coin bazında kazanma alt sınırı
 *             (≈25 işlemde gürültü) kaldırıldı; coin bazında alt sınır, istatistik gücü yeten görülmemiş
 *             coinler × tüm dönem sınavına taşındı (holdout). Geliştirme aday şartı 150 → 50 işlem/coin.
 * 2026-09-30  Doğrulama (bakış 1): UT Bot Pro kuralı tutmadı (%63,3 kazanma, −%0,254/işlem). Kullanıcı isteği:
 *             UT Bot'a bağlı kalmadan 15 dk'da serbest arama. Doğrulama dönemi görüldüğü için geliştirmeye katıldı
 *             (dev2: 2025-04 → 2026-06, 15 ay, 5 çeyrek). Dokunulmamış sınavlar aynen: son sınav (2026-07 → 09),
 *             görülmemiş coinler (XRP/BNB/DOGE, tüm dönem), geriye dönük dönem ve yedek coinler; son sınav 1 bakış.
 *             Seçim ölçütü: 5 çeyreğin ve analiz coinlerinin hepsinde tutarlılık (en iyi ortalama değil).
 * 2026-09-30  Laboratuvar (strategy_lab.py, 8 aile): %70+ kazanma veren her yapı komisyon sonrası eksi ya da
 *             kararsız; tutarlı kâr eden tek aile trend takibi (~%37 kazanma). Kullanıcı "15 dk'da en mükemmel
 *             strateji, her şey serbest" dedi → hedef kâr ve tutarlılık. Son sınav ölçütleri: toplam ort. işlem > 0
 *             ve PF > 1; görülmemiş coinlerde ayrıca 3 coinin en az 2'sinde PF > 1. Kazanma oranı raporlanır.
 *             Dondurulan: Trend Avcısı (frozen.json, varsayılan ayarlar). Son sınav 1 bakış.
 * 2026-10-01  Kullanıcı: 1 saat / 4 saat dene. H_STUDY (yukarıda) sonuçlara bakılmadan önce yazıldı: geliştirme dev2 ×
 *             analiz coinleri; asıl sınavlar yedek coinler (ADA/AVAX/LINK/LTC) × 2024-11 → 2026-09 ve analiz
 *             coinleri × 2024-11 → 2025-03 (hiç kullanılmadı), bir bakış; hedef kullanıcının asıl hedefi (%70 + kâr).
 * 2026-10-01  1 saatte aday çıkmadı (htf_study.py). 4 saatte sert mum / RSI aşırılığı sonrası aynı yönde kısa hedef
 *             (htf_study.py, htf_momentum.py) → Momentum 4s Strateji; motorla dev2 × 8 analiz coini: 511 işlem,
 *             %77,3 kazanma, +%0,377/işlem, PF 1,30, 5 çeyreğin hepsi artı. Asıl sınavlardan önce donduruldu:
 *             frozen_4h.json (varsayılan ayarlar). Sınav: final.ts --study-h, bir bakış.
 */

/**
 * 1 saat / 4 saat çalışması (2026-10-01, kullanıcı: "dene"). Geliştirme: dev2 × analiz coinleri. Asıl sınavlar hiç
 * dokunulmamış verilerde ve bir kez: yedek coinler × tüm dönem, analiz coinleri × geriye dönük dönem. Son sınav dönemi
 * ve XRP/BNB/DOGE daha önce Trend Avcısı için bir kez görüldü → yalnız ikincil rapor.
 */
export const H_STUDY = {
  dev: { key: "dev2", name: "Geliştirme (15 ay)", from: dayStart("2025-04-01"), to: dayEnd("2026-06-30") } as Window,
  back: { key: "back2", name: "Geriye dönük sınav", from: dayStart("2024-11-01"), to: dayEnd("2025-03-31") } as Window,
  all: { key: "all2", name: "Tüm dönem", from: dayStart("2024-11-01"), to: dayEnd("2026-09-29") } as Window,
  analysisCoins: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BCHUSDT", "DOTUSDT", "ETCUSDT", "TRXUSDT", "XLMUSDT"],
  /** Kabul (asıl sınavların ikisinde de): toplam kazanma ≥ %70, ort. işlem > 0, PF > 1. Tutmazsa en iyi kârlı seçenek raporlanır. */
  criteria: { pooledWinRate: 70, pooledAvgRet: 0, pooledPf: 1 } as Criteria,
};

export const LOOKS = { val: 2, final: 1, reserveRetry: 1 };
