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
 * 2026-10-01  Asıl sınav (bakış 1) — TUTMADI. Yedek coinler × 2024-11 → 2026-09: 377 işlem, kazanma %74,5, −%0,044/işlem,
 *             PF 0,98. Analiz coinleri × 2024-11 → 2025-03: 180 işlem, %68,3, −%0,950, PF 0,68. İkincil: son sınav
 *             dönemi × 6 coin %85,0 / +%0,650 (107 işlem); XRP/BNB/DOGE × tüm dönem %74,1 / +%0,070 (317 işlem).
 *             Sonuç: yüksek kazanma oranı görülmemiş veride de sürüyor (TP/SL geometrisi), kâr sürmüyor. Strateji
 *             tools/backtest/pine/'a arşivlendi; kütüphaneye eklenmedi.
 * 2026-10-01  Uzun geçmiş çalışması (L_STUDY, aşağıda) bot deposunun research-data dalıyla (2020 → ) sonuçlara
 *             bakılmadan önce yazıldı. Yalnız veri bütünlüğü denetlendi: market-data ile örtüşen dönemde coin başına
 *             72 864 mumun 1-6'sı ayrışıyor (arşiv farkı), funding birebir aynı.
 * 2026-10-01  long_study.py (1988 kural): 37 aday (★). Uyarı: 4 saatte rastgele giriş de (kâr al 1 / zarar kes 3)
 *             aday şartını geçti (%75,2, +29 bps) — 4 saatte bu dönemde geometri tek başına artı. Seçim kuralıyla
 *             (en kötü yılın ortalaması) seçilen: 1 gün, gövde > 1,5 × ATR14, devam, kâr al 1 / zarar kes 3, 20 gün
 *             (laboratuvar: 446 işlem, %74,4, +132 bps; aynı geometride rastgele −79 bps). Motor (g1_ldev):
 *             570 işlem, %76,5, +%1,608/işlem, PF 1,32; yıllar %75,7/+0,28, %77,5/+1,95, %75,8/+2,54; 11/15 coinde
 *             PF > 1. Donduruldu: frozen_1d.json. Sınavlar: final.ts --study-l, bir bakış.
 * 2026-10-01  Sınavlar (bakış 1) — TUTMADI. Sınav 1 (2023-01 → 2024-08, hiç görülmemiş): 308 işlem, kazanma %71,8,
 *             −%0,067/işlem, PF 0,98, PF > 1 olan coin 7/15. Sınav 2 (2024-09 → 2026-09): 401 işlem, %77,8,
 *             +%0,969, PF 1,30, 10/15 (geçti). Her işlemde %100 ile coin başına bileşik özsermaye iki sınavda da
 *             medyan ×0,94 / ×0,95, en büyük düşüş medyanı %35 / %42. Sonuç: 15 dk, 1 s, 4 s, 1 g'de yüksek kazanma
 *             oranı görülmemiş veride sürüyor (geometri), kâr dönemden döneme değişiyor; ≥ %70 + kâr sağlam değil.
 *             Ek denetim (T_CHECK, aşağıda): teslim edilen Trend Avcısı, hiç görmediği 2020-01 → 2024-08'de.
 * 2026-10-01  T_CHECK (bakış 1) — TUTMADI. Trend Avcısı × 15 coin × 2020-01 → 2024-08: 6304 işlem, kazanma %34,4,
 *             −%0,123/işlem (fonlama dahil −%0,184), PF 0,95; yıllar 2020 −0,004, 2021 −0,014, 2022 −0,109, 2023 −0,244,
 *             2024 −0,238; bileşik özsermaye medyanı ×0,31. README ve kütüphane açıklaması buna göre düzeltildi.
 * 2026-10-01  Kullanıcı: "%70 her yerde çıkıyorsa, şu an hangi trendde olduğunu bulup ona göre strateji yapalım."
 *             Rejim çalışması (R_STUDY, aşağıda) sonuçlara bakılmadan önce yazıldı. Veri daha önce görüldüğü için
 *             koruma ayrı sınav dönemi değil, ileriye doğru yürüyen seçimdir: her yıl yalnız önceki yıllarda kapanmış
 *             işlemlerle seçim yapılır; yöntem, ölçütler ve kural evreni çalıştırmadan önce sabit.
 * 2026-10-01  R_STUDY (tek çalıştırma) — ANA MODEL GEÇTİ (zayıf). Coin rejimi, örneklem dışı 2021-01 → 2026-09: 1079
 *             işlem, kazanma %70,6, +55,1 bps (t +1,5), PF 1,12; yıllar +51 / +27 / +168 / +181 / +320 / −350 bps (5/6
 *             artı); PF > 1 coin 11/15; fonlama dahil +53,4 bps. İkincil: BTC rejimi 770 işlem %70,9 +169 bps (t +4,5);
 *             rejimsiz 429 işlem %74,8 +174 bps (t +3,1). Denetim (rastgele kurallar): −19 / −64 / +16 bps, hiçbiri
 *             geçmedi. Güncel seçim (eğitim 2026 dahil) Pine'a çevrildi: src/pine/library/rejim_strategy.pine ve
 *             rejim.pine; motor ↔ laboratuvar 2021-2026: 695 / 667 işlem, +%2,77 / +%2,80 (örneklem içi, iyimser).
 *             Uygulamada gerçek veriyle BTC ve SOL 2025-01 → 2026-09 düzenekle aynı (e2e/real.spec.ts).
 * 2026-10-01  Kullanıcı: "sadece altın için çalışır mısın". Altın çalışması (G_STUDY, aşağıda) altın verisi gelmeden
 *             ve hiçbir sonuca bakılmadan önce yazıldı.
 * 2026-10-01  Altın verisi (kapsam): spot PAXGUSDT 2020-08 → 2026-09 (en uzun seri → ana sınav), vadeli PAXGUSDT
 *             2025-03 →, XAUUSDT 2025-12 →, XAUTUSDT 2026-03 →. İlk Test A denemesi içe aktarıcıdaki zaman birimi
 *             hatası (ms çözünürlüklü dizin) yüzünden sonuç üretmeden çöktü; düzeltilip bir kez çalıştırıldı.
 *             Test A — spot PAXG 2021-01 → 2026-09: 51 işlem, kazanma %76,5, +%0,034/işlem, PF 1,03 (ölçütler geçti,
 *             fiilen başa baş); yıllar 2021-2025 artı, 2026: 10 işlem %40 −%2,76. Bilgi: XAUUSDT 2026-04 → 09 4 işlem
 *             %25 −%2,92; vadeli PAXGUSDT 2025-07 → 2026-09 11 işlem %54,5 −%1,81.
 *             Test B — GEÇMEDİ. Yalnız altınla ileriye yürüyen seçim (coin rejimi): 567 işlem, %76,9, −7,8 bps (t −2,0),
 *             PF 0,76, 6 yılın 1'i artı; rejimsiz: 677 işlem, %84,2, +0,8 bps. Rastgele kurallarla aynı yöntem −3,0 /
 *             −4,2 bps: tek enstrümanda seçim gürültüden ayrılamıyor (rastgele kurallar da seçiliyor).
 * 2026-10-01  Kullanıcı: "geçmişteki haberleri dün duyuyormuş gibi düşünerek ve grafiğe bakarak işlem al; mantıksızsa
 *             alma; 1 saat / 4 saat / günlük / haftalık geriye dönük test". A_STUDY (aşağıda) ve konjonktür takvimi
 *             (konjonktur.ts) hiçbir süzgeç sonucuna bakılmadan önce yazıldı ve gönderildi.
 * 2026-10-01  A_STUDY (tek çalıştırma; gold_ai_filter.ts). Net, yapay zekâ (haber + grafik) ← UT Bot olduğu gibi:
 *             1 saat Al/Sat −%96,3 (2534 işlem, %25,5) ← −%100; yalnız long −%76,9 (1325, %26,9) ← −%97,5.
 *             4 saat Al/Sat +%2,7 (541, %40,5) ← −%71,8; yalnız long +%42,1 (281, %44,5) ← −%20,0.
 *             1 gün Al/Sat +%113,1 (91, %48,4) ← +%26,2; yalnız long +%136,8 (44, %54,5) ← +%69,2.
 *             1 hafta Al/Sat +%37,1 (22, %45,5) ← +%15,8; yalnız long +%82,5 (12, %75,0) ← +%68,5.
 *             Rastgele süzgeç denetimi: 1 saat / 4 saat / 1 gün çekilişlerin %99-100'ünden, haftalık %85 ve %94'ünden iyi.
 *             Yalnız grafik (kurala dayalı, geçmişi bilmeyi gerektirmez): 4 saat long +%28,3, 1 gün long +%77,3,
 *             1 gün Al/Sat +%72,3, 1 hafta Al/Sat +%47,7, 1 hafta long +%70,2. Haberin ek katkısı geriye dönük
 *             yazılmış takvimden şişmiş olabilir; temiz ölçü ileriye dönük denemedir.
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

/**
 * Uzun geçmiş çalışması (2026-10-01, 1s/4s sınavı tutmadıktan sonra). Veri: bot deposunun research-data dalı
 * (data.binance.vision, 15 dk mumlar + funding, 2020-01 → 2026-09, 15 coin; import_research_data.py). 2020-01 → 2024-08
 * bu çalışmaya kadar hiç kullanılmadı (getirisine bakılmadı). Coinlerin listelenme tarihleri farklı (SOL/AVAX/DOT/DOGE
 * 2020 ortası); işlem, verinin ve göstergelerin hazır olduğu yerden başlar.
 *   Geliştirme: dev × 15 coin, long_study.py taraması (15 dk / 1 s / 4 s / 1 g; olay × yön × filtre × kâr al/zarar kes).
 *   Aday (★): dev'in 3 yılının (2020, 2021, 2022) her birinde ≥ 50 işlem, kazanma ≥ %72 ve ort. işlem > 0 (komisyon
 *            sonrası); coinlerin ≥ 10/15'inde ort. > 0; toplam ≥ 300 işlem. Adaylar arasından en kötü yılının ortalaması
 *            en yüksek olan TEK kural Pine'a çevrilir, motorla geliştirmede doğrulanır ve sınavlardan önce dondurulur.
 *   Sınav 1 (hiç görülmemiş): exam1 × 15 coin. Sınav 2: exam2 × 15 coin (bu dönem başka kurallar için görüldü).
 *   Kabul (iki sınavda da, uygulamanın motoruyla, komisyon %0,05/taraf): toplam kazanma ≥ %70, ort. işlem > 0, PF > 1,
 *   PF > 1 olan coin ≥ 10/15. Stres komisyonu (%0,065) ve fonlama bilgi olarak raporlanır. Her sınav tek bakış.
 *   Aday çıkmazsa sınav yapılmaz; sonuç olduğu gibi raporlanır.
 */
export const L_STUDY = {
  dev: { key: "ldev", name: "Uzun geçmiş: geliştirme", from: dayStart("2020-01-01"), to: dayEnd("2022-12-31") } as Window,
  exam1: { key: "lexam1", name: "Uzun geçmiş: sınav 1", from: dayStart("2023-01-01"), to: dayEnd("2024-08-31") } as Window,
  exam2: { key: "lexam2", name: "Uzun geçmiş: sınav 2", from: dayStart("2024-09-01"), to: dayEnd("2026-09-29") } as Window,
  coins: [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT",
    "LTCUSDT", "DOTUSDT", "AVAXUSDT", "TRXUSDT", "BCHUSDT", "ETCUSDT", "XLMUSDT",
  ],
  candidate: { years: [2020, 2021, 2022], yearMinTrades: 50, yearWinRate: 72, posCoins: 10, minTrades: 300 },
  criteria: { pooledWinRate: 70, pooledAvgRet: 0, pooledPf: 1, pfCoins: 10 } as Criteria,
};

/**
 * Trend Avcısı ek denetimi (2026-10-01): kütüphanedeki strateji (frozen.json, varsayılan ayarlar) 15 coin ×
 * 2020-01 → 2024-08'de (research-data, 15 dk taban; strateji bu dönemi hiç görmedi). Bir bakış. Kabul, kendi son
 * sınavındaki gibi: toplam ort. işlem > 0 ve PF > 1. Kazanma oranı, yıllar ve bileşik özsermaye düşüşü raporlanır.
 */
export const T_CHECK = {
  window: { key: "tcheck", name: "Trend Avcısı ek denetimi", from: dayStart("2020-01-01"), to: dayEnd("2024-08-31") } as Window,
  criteria: { pooledAvgRet: 0, pooledPf: 1 } as Criteria,
};

/**
 * Rejim çalışması (2026-10-01) — ayrıntı regime_study.py başında. Rejim günlük mumdan: yükseliş (kapanış > EMA50,
 * +DI > −DI, ADX > 20), düşüş (tersi), yatay (diğerleri). Kural evreni 2268 (1 s / 4 s / 1 g × 18 olay × devam/ters ×
 * 7 geometri × yön). Her test yılı (2021 … 2026) başında, yalnız önceki yıllarda kapanmış işlemlerle, her rejim için
 * ≥ 60 işlem, kazanma ≥ %72, ort. > 0 olan kurallardan ortalamanın %95 alt sınırı en yüksek olan (> 0) seçilir; o yıl
 * coin o rejimdeyken yalnız o kural işlem açar (coin başına tek pozisyon). Ana model: coinin kendi rejimi; ikincil:
 * BTC'nin rejimi, rejimsiz. Kabul (ana model, örneklem dışı 2021-01 → 2026-09): kazanma ≥ %70, ort. > 0, PF > 1,
 * 6 yılın ≥ 4'ünde ort. > 0, ≥ 10/15 coinde PF > 1. Denetim: aynı yöntem yalnız rastgele girişli 1260 kuralla.
 * Tek çalıştırma; geçerse güncel seçim (tüm veriyle) Pine'a çevrilir ve motorla doğrulanır.
 */
export const R_STUDY = {
  window: { key: "rall", name: "Rejim çalışması test yılları", from: dayStart("2021-01-01"), to: dayEnd("2026-09-29") } as Window,
  testYears: [2021, 2022, 2023, 2024, 2025, 2026],
  select: { minTrades: 60, winRate: 72, score: "ortalamanın %95 alt sınırı > 0" },
  criteria: { pooledWinRate: 70, pooledAvgRet: 0, pooledPf: 1, pfCoins: 10, yearsPositive: 4 },
};

/**
 * Altın çalışması (2026-10-01, kullanıcı: "sadece altın için çalışır mısın") — sonuçlara bakılmadan önce yazıldı.
 * Veri: fetch_gold.py (data.binance.vision, 15 dk; vadeli XAUUSDT / PAXGUSDT / XAUTUSDT, spot PAXGUSDT; arşivde hangisi
 * varsa), import_gold_data.py. Altın kripto çalışmalarının hiçbirinde kullanılmadı.
 *   Test A (tek bakış): kütüphanedeki Rejim Strateji, ayarlarına dokunmadan, günlük grafikte: en uzun geçmişli altın
 *   serisinde (kapsam raporuna göre, getiriye bakılmadan seçilir) 2021-01 → 2026-09 ve vadeli XAUUSDT'nin (varsa) tüm
 *   geçmişinde. Kabul: kazanma ≥ %70, ort. işlem > 0, PF > 1 (en uzun seride).
 *   Test B (tek çalıştırma): regime_study.py --coins <en uzun seri> --tag altin --min-trades 40: yalnız altınla ileriye
 *   doğru yürüyen seçim (2021-2026) ve rastgele denetim. Kabul: R_STUDY ile aynı (kazanma ≥ %70, ort. > 0, PF > 1,
 *   6 yılın ≥ 4'ünde ort. > 0).
 *   Komisyon %0,05/taraf (Binance vadeli piyasa emri); spot PAXG'de taker %0,1 olduğu not edilir.
 */
export const G_STUDY = {
  window: { key: "gall", name: "Altın: test yılları", from: dayStart("2021-01-01"), to: dayEnd("2026-09-29") } as Window,
  criteria: { pooledWinRate: 70, pooledAvgRet: 0, pooledPf: 1 } as Criteria,
  walkForward: { minTrades: 40, yearsPositive: 4 },
};

/**
 * Yapay zekâ konjonktür süzgeci (2026-10-01) — sonuçlara bakılmadan önce yazıldı. Tek çalıştırma; takvim ve kural
 * çalıştırmadan sonra değiştirilmez.
 *   Sinyaller: kütüphanedeki UT Bot Strateji, varsayılan ayarlar (anahtar 1, ATR 10), spot PAXGUSDT, 1 saat / 4 saat /
 *   1 gün / 1 hafta, 2021-01-01 → 2026-09-29, komisyon %0,05/taraf; biçimler "Al→long, Sat→short" ve "yalnız long".
 *   Çıkış hep UT Bot'un ters sinyali; süzgeç yalnız girişe karar verir (atlanan sinyalden sonra bir sonraki sinyale
 *   kadar pozisyon yok).
 *   Karar (asıl): konjonktür olumlu → yalnız long, olumsuz → yalnız short (yalnız long biçiminde girilmez), karışık →
 *   üst zaman dilimi trendi yönündeki sinyaller (konjonktur.ts: UST_TREND; son kapanmış üst mumda kapanış ≷ EMA).
 *   Görüş, karar anında (sinyal mumunun kapanışı) duyulmuş en son haberden: haber gününün ertesi 00:00 UTC'den geçerli.
 *   Ayrıştırma: yalnız haber (karışıkta sinyal alınır), yalnız grafik.
 *   Denetim: asıl kararla aynı sayıda işlemi rastgele atlayan süzgeç (2000 çekiliş) → asıl kararın yüzdeliği.
 *   Rapor: işlem, kazanma, ort. işlem, PF, bileşik net, maks. düşüş (kapanmış işlemlerle), atlanan işlemlerin
 *   ortalaması, yıllar.
 *   Uyarı: takvim sonradan ne olduğunu bilen biri tarafından yazıldı; geriye dönük sonuç iyimser bir üst sınırdır.
 *   Temiz ölçü ileriye dönük denemedir (tools/ai, 2026-10-05'ten itibaren).
 */
export const A_STUDY = {
  window: { key: "aall", name: "Yapay zekâ süzgeci: test dönemi", from: dayStart("2021-01-01"), to: dayEnd("2026-09-29") } as Window,
  tfs: [3_600, 14_400, 86_400, 604_800],
  randomDraws: 2_000,
};

export const LOOKS = { val: 2, final: 1, reserveRetry: 1 };
