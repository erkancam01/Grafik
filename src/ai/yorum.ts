/**
 * Yapay zekâ yorumcusu: altında haftalık UT Bot (varsayılan ayarlar, yalnız long) sinyallerini her pazartesi Claude
 * haberlerle yorumlar; Al sinyalinde "al" ya da "atla" der, her hafta yön tahmini yapar. Gerçek para yok: iki kâğıt
 * defter tutulur — UT Bot olduğu gibi ve yapay zekânın onayladığı işlemler. Kaydı GitHub Actions işi
 * (tools/ai/haftalik.ts) "ai-yorum" dalına yazar, uygulama oradan okur. Bu dosya ikisinin ortak biçimi ve puanlaması.
 */

/** İlk sayılan hafta (pazartesi 00:00 UTC). Öncesindeki kayıtlar gösterilir, puanlanmaz. */
export const AI_BASLANGIC = Date.UTC(2026, 9, 5);
/** Karar haftanın açılışından en çok bu kadar sonra verildiyse sayılır (sonrası haberlerde ileriyi görmek olur). */
export const ZAMANINDA_MS = 3 * 3_600_000;
export const AI_SEMBOL = "PAXGUSDT";
export const AI_KAYIT_URL = "https://raw.githubusercontent.com/erkancam01/Grafik/ai-yorum/ai/yorumlar.json";

/** Geçen haftanın kapanışındaki UT Bot sinyali; işlem bu haftanın açılışında. */
export type Sinyal = "al" | "sat" | "yok";
/** Yapay zekânın kararı: yalnız Al haftalarında "al" ya da "atla". */
export type Karar = "al" | "atla" | "yok";
export type Yon = "yukari" | "asagi" | "kararsiz";

export interface Kaynak {
  baslik: string;
  url: string;
  tarih: string;
}

export interface AiCevap {
  karar: Karar;
  /** 0–100 */
  guven: number;
  yon: Yon;
  /** 50–100 */
  yonGuveni: number;
  ozet: string;
  gerekce: string;
  riskler: string[];
  /** Yapay zekânın dayandığı haberler (yalnız aramada gerçekten dönenler tutulur). */
  kaynaklar: Kaynak[];
  /** Yanıtı veren model (yedek modele geçildiyse o). */
  model: string;
  arama: number;
  girdiToken: number;
  ciktiToken: number;
  /** Tahmini maliyet (USD). */
  maliyet: number;
}

export interface Hafta {
  /** Haftanın açılışı (ms, UTC; pazartesi 00:00). */
  hafta: number;
  /** Kararın verildiği an (ms). */
  zaman: number;
  zamaninda: boolean;
  sinyal: Sinyal;
  /** UT Bot bu haftanın açılışından sonra pozisyonda mı. */
  pozisyon: boolean;
  /** Bu haftanın açılış fiyatı (işlemler bu fiyattan). */
  acilis: number;
  oncekiKapanis: number;
  /** UT Bot iz süren stop (geçen haftanın kapanışında). */
  iz: number;
  ai: AiCevap | null;
  /** Yapay zekâ yanıt vermediyse nedeni. */
  aiHata: string | null;
  /** Hafta kapanınca doldurulur. */
  kapanis: number | null;
}

/** UT Bot (yalnız long) işlemi; uygulamanın strateji motoru hesaplar. */
export interface Islem {
  giris: number;
  girisFiyat: number;
  cikis: number | null;
  /** Açık işlemde son fiyat. */
  cikisFiyat: number;
  /** % (komisyon düşülmüş; açıkta gerçekleşmemiş). */
  getiri: number;
  acik: boolean;
}

export interface Kayit {
  surum: 1;
  sembol: string;
  baslangic: number;
  guncelleme: number;
  haftalar: Hafta[];
  /** Başlangıçtan sonra açılan UT Bot işlemleri (her çalışmada yeniden hesaplanır). */
  islemler: Islem[];
}

export function yeniKayit(): Kayit {
  return { surum: 1, sembol: AI_SEMBOL, baslangic: AI_BASLANGIC, guncelleme: 0, haftalar: [], islemler: [] };
}

export interface Defter {
  /** Kapanmış işlemler. */
  islem: number;
  kazanan: number;
  /** Kapanmış işlemlerin bileşik getirisi (%). */
  getiri: number;
  acik: Islem | null;
}

export interface Puan {
  /** UT Bot olduğu gibi. */
  duz: Defter;
  /** Yalnız yapay zekânın atlamadığı işlemler. */
  ai: Defter;
  /** Yapay zekânın atladığı kapanmış işlemler: kaçı zararlıydı (atlamak doğruydu). */
  atlanan: { islem: number; zararli: number; getiri: number };
  /** Haftalık yön tahmini (kararsızlar hariç, kapanmış ve zamanında haftalar). */
  yon: { tahmin: number; dogru: number };
}

/** Zamanında verilmiş bir "atla" kararı var mı (yoksa yapay zekâ defteri de işlemi alır). */
export function atlandi(k: Kayit, giris: number): boolean {
  const h = k.haftalar.find((x) => x.hafta === giris);
  return !!h && h.zamaninda && h.ai?.karar === "atla";
}

function defter(ts: Islem[]): Defter {
  const kapali = ts.filter((t) => !t.acik);
  return {
    islem: kapali.length,
    kazanan: kapali.filter((t) => t.getiri > 0).length,
    getiri: (kapali.reduce((m, t) => m * (1 + t.getiri / 100), 1) - 1) * 100,
    acik: ts.find((t) => t.acik) ?? null,
  };
}

export function puanla(k: Kayit): Puan {
  const ts = k.islemler.filter((t) => t.giris >= k.baslangic);
  const alinan = ts.filter((t) => !atlandi(k, t.giris));
  const atlanan = ts.filter((t) => !t.acik && atlandi(k, t.giris));
  const yon = { tahmin: 0, dogru: 0 };
  for (const h of k.haftalar) {
    if (h.hafta < k.baslangic || !h.zamaninda || !h.ai || h.kapanis === null || h.ai.yon === "kararsiz") continue;
    yon.tahmin++;
    if ((h.ai.yon === "yukari" && h.kapanis > h.acilis) || (h.ai.yon === "asagi" && h.kapanis < h.acilis)) yon.dogru++;
  }
  return {
    duz: defter(ts),
    ai: defter(alinan),
    atlanan: { islem: atlanan.length, zararli: atlanan.filter((t) => t.getiri <= 0).length, getiri: defter(atlanan).getiri },
    yon,
  };
}

/** Kaydın beklenen biçimde olup olmadığı (uygulama dışarıdan okur). */
export function kayitMi(x: unknown): x is Kayit {
  const k = x as Kayit;
  return !!k && k.surum === 1 && Array.isArray(k.haftalar) && Array.isArray(k.islemler) && typeof k.baslangic === "number";
}
