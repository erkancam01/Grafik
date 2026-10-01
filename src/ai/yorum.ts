/**
 * Yapay zekâ yorumcusu: altında UT Bot (varsayılan ayarlar) günlük ve haftalık sinyal verdiğinde Claude son haberleri
 * okuyup o sinyale 0–100 arası bir al-sat puanı ve açıklama yazar (0 = kesin sat, 50 = nötr, 100 = kesin al). Her
 * pazartesi, sinyal olmasa da, haftanın puanını verir. Gerçek para yok: her zaman dilimi için iki kâğıt defter tutulur:
 * UT Bot olduğu gibi (yalnız long) ve yalnız puanı 50 ve üstü olan Al sinyalleri. Kaydı GitHub Actions işi
 * (tools/ai/yorumcu.ts) "ai-yorum" dalına yazar, uygulama oradan okur. Bu dosya ikisinin ortak biçimi ve puanlaması.
 */

/** İlk sayılan gün (pazartesi 00:00 UTC). Öncesindeki kayıtlar gösterilir, puanlanmaz. */
export const AI_BASLANGIC = Date.UTC(2026, 9, 5);
/** Karar mumun açılışından en çok bu kadar sonra verildiyse sayılır (sonrası haberlerde ileriyi görmek olur). */
export const ZAMANINDA_MS = 3 * 3_600_000;
export const AI_SEMBOL = "PAXGUSDT";
export const AI_KAYIT_URL = "https://raw.githubusercontent.com/erkancam01/Grafik/ai-yorum/ai/yorumlar.json";
/** Bu puan ve üstündeki Al sinyalleri yapay zekâ defterine girer. */
export const ESIK = 50;

export type Tf = "1d" | "1w";
export const TF_LISTE: readonly Tf[] = ["1w", "1d"];
export const TF_SN: Record<Tf, number> = { "1d": 86_400, "1w": 604_800 };
export const TF_AD: Record<Tf, string> = { "1d": "Günlük", "1w": "Haftalık" };

/** Önceki mumun kapanışındaki UT Bot sinyali; işlem bu mumun açılışında. */
export type Sinyal = "al" | "sat" | "yok";

export interface Kaynak {
  baslik: string;
  url: string;
  tarih: string;
}

export interface Degerlendirme {
  /** 0–100 al-sat puanı: 0 kesin sat, 50 nötr, 100 kesin al. */
  puan: number;
  /** Puanın açıklaması. */
  aciklama: string;
  /** Altınla ilgili son haberlerin özeti. */
  ozet: string;
  riskler: string[];
  /** Dayandığı haberler (yalnız aramada gerçekten dönenler tutulur). */
  kaynaklar: Kaynak[];
  /** Yanıtı veren model (yedek modele geçildiyse o). */
  model: string;
  arama: number;
  girdiToken: number;
  ciktiToken: number;
  /** Tahmini maliyet (USD). */
  maliyet: number;
}

/** Bir sinyal (günlük ya da haftalık) ya da pazartesi haftalık görünümü (haftalıkta sinyal yoksa). */
export interface Olay {
  tf: Tf;
  /** İşlem mumunun açılışı (ms, UTC) = sinyal mumunun kapanışı. */
  zaman: number;
  sinyal: Sinyal;
  /** Kararın verildiği an (ms). */
  karar: number;
  zamaninda: boolean;
  /** UT Bot (yalnız long) bu mumun açılışından sonra pozisyonda mı. */
  pozisyon: boolean;
  /** Mumun açılış fiyatı (işlemler bu fiyattan). */
  acilis: number;
  oncekiKapanis: number;
  /** UT Bot iz süren stop (sinyal mumunun kapanışında). */
  iz: number;
  ai: Degerlendirme | null;
  /** Yapay zekâ yanıt vermediyse nedeni. */
  aiHata: string | null;
  /** Mum kapanınca doldurulur (haftalık görünümün isabeti için). */
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
  surum: 2;
  sembol: string;
  baslangic: number;
  guncelleme: number;
  /** Zamana göre sıralı. */
  olaylar: Olay[];
  /** Başlangıçtan sonra açılan UT Bot işlemleri (her çalışmada yeniden hesaplanır). */
  islemler: Record<Tf, Islem[]>;
}

export function yeniKayit(): Kayit {
  return { surum: 2, sembol: AI_SEMBOL, baslangic: AI_BASLANGIC, guncelleme: 0, olaylar: [], islemler: { "1d": [], "1w": [] } };
}

/** Puanın sözlü karşılığı. */
export function puanAdi(p: number): { ad: string; renk: "up" | "down" | "muted" } {
  if (p >= 60) return { ad: p >= 80 ? "Güçlü al" : "Al", renk: "up" };
  if (p <= 40) return { ad: p <= 20 ? "Güçlü sat" : "Sat", renk: "down" };
  return { ad: "Nötr", renk: "muted" };
}

/**
 * Dışarıdan okunan kaydı doğrular. İlk sürümün (yalnız haftalık, al/atla kararlı) kayıtları haftalık olaylara çevrilir;
 * o sürümde puan olmadığından yapay zekâ yanıtları alınmaz.
 */
export function kayitOku(x: unknown): Kayit | null {
  const k = x as Record<string, unknown> | null;
  if (!k || typeof k.baslangic !== "number") return null;
  if (k.surum === 2 && Array.isArray(k.olaylar) && k.islemler && typeof k.islemler === "object") return k as unknown as Kayit;
  if (k.surum === 1 && Array.isArray(k.haftalar) && Array.isArray(k.islemler)) {
    const y = yeniKayit();
    y.baslangic = k.baslangic;
    y.guncelleme = typeof k.guncelleme === "number" ? k.guncelleme : 0;
    y.islemler["1w"] = k.islemler as Islem[];
    y.olaylar = (k.haftalar as Record<string, unknown>[]).map((h) => ({
      tf: "1w" as const,
      zaman: h.hafta as number,
      sinyal: h.sinyal as Sinyal,
      karar: h.zaman as number,
      zamaninda: h.zamaninda as boolean,
      pozisyon: h.pozisyon as boolean,
      acilis: h.acilis as number,
      oncekiKapanis: h.oncekiKapanis as number,
      iz: h.iz as number,
      ai: null,
      aiHata: (h.aiHata as string | null) ?? (h.ai ? "eski sürüm yanıtı (puansız)" : null),
      kapanis: (h.kapanis as number | null) ?? null,
    }));
    return y;
  }
  return null;
}

export interface Defter {
  /** Kapanmış işlemler. */
  islem: number;
  kazanan: number;
  /** Kapanmış işlemlerin bileşik getirisi (%). */
  getiri: number;
  acik: Islem | null;
}

export interface TfPuan {
  /** UT Bot olduğu gibi. */
  duz: Defter;
  /** Yalnız puanı ESIK ve üstü olan (ya da zamanında puanlanmamış) Al sinyalleri. */
  ai: Defter;
  /** Puan düşük olduğu için atlanan kapanmış işlemler: kaçı zararlıydı (atlamak doğruydu). */
  atlanan: { islem: number; zararli: number; getiri: number };
}

export interface Puan {
  tf: Record<Tf, TfPuan>;
  /** Haftalık puanın yön isabeti: 55 üstü yukarı, 45 altı aşağı (arası sayılmaz), kapanmış ve zamanında haftalar. */
  hafta: { tahmin: number; dogru: number };
}

/** Zamanında verilmiş ve eşiğin altında kalmış bir puan var mı (yoksa yapay zekâ defteri de işlemi alır). */
export function atlandi(k: Kayit, tf: Tf, giris: number): boolean {
  const e = k.olaylar.find((x) => x.tf === tf && x.zaman === giris);
  return !!e && e.zamaninda && !!e.ai && e.ai.puan < ESIK;
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
  const tf = {} as Record<Tf, TfPuan>;
  for (const t of TF_LISTE) {
    const ts = (k.islemler[t] ?? []).filter((x) => x.giris >= k.baslangic);
    const alinan = ts.filter((x) => !atlandi(k, t, x.giris));
    const atlanan = ts.filter((x) => !x.acik && atlandi(k, t, x.giris));
    tf[t] = {
      duz: defter(ts),
      ai: defter(alinan),
      atlanan: { islem: atlanan.length, zararli: atlanan.filter((x) => x.getiri <= 0).length, getiri: defter(atlanan).getiri },
    };
  }
  const hafta = { tahmin: 0, dogru: 0 };
  for (const e of k.olaylar) {
    if (e.tf !== "1w" || e.zaman < k.baslangic || !e.zamaninda || !e.ai || e.kapanis === null) continue;
    const p = e.ai.puan;
    if (p > 45 && p < 55) continue;
    hafta.tahmin++;
    if ((p >= 55 && e.kapanis > e.acilis) || (p <= 45 && e.kapanis < e.acilis)) hafta.dogru++;
  }
  return { tf, hafta };
}
