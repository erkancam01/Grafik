/**
 * Haftalık yapay zekâ yorumu (ileriye dönük kâğıt deneme). Her pazartesi haftalık mum kapandıktan sonra çalışır:
 * PAXG/USDT haftalık mumlarında UT Bot Strateji'yi (varsayılan ayarlar, yalnız long) uygulamanın Pine motoruyla
 * çalıştırır, geçen haftanın sinyalini bulur, Claude'a haberlerle yorumlatır ve kaydı günceller.
 * Kullanım: node --import jiti/register tools/ai/haftalik.ts --kayit <yorumlar.json> [--deneme] [--simdi <ISO>]
 *   --deneme: yapay zekâ çağrılmaz (veri ve UT Bot denetimi). ANTHROPIC_API_KEY yoksa da çağrılmaz.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_SEMBOL, kayitMi, puanla, yeniKayit, ZAMANINDA_MS, type Hafta, type Islem, type Kayit, type Sinyal } from "../../src/ai/yorum";
import { BinanceSource, SPOT } from "../../src/data/binance";
import { run, type BarsData } from "../../src/pine";
import { istemciKur, yorumla, type Baglam, type ClaudeIstemci } from "./claude";

const HAFTA = 7 * 86_400_000;
const UT_KOD = readFileSync(fileURLToPath(new URL("../../src/pine/library/ut_bot_strategy.pine", import.meta.url)), "utf8");
const MUM_SAYISI = 12;

/** Binance spot haftalık mumları (son eleman oluşan hafta). */
export async function haftalikMumlar(simdi: number): Promise<BarsData> {
  const b = await new BinanceSource(SPOT).klines(AI_SEMBOL, "1w", 1000);
  const n = b.time.length;
  b.lastRealtime = n > 0 && b.time[n - 1]! + HAFTA > simdi;
  return b;
}

export interface Durum {
  hafta: number;
  sinyal: Sinyal;
  pozisyon: boolean;
  acikIslem: { giris: number; girisFiyat: number } | null;
  acilis: number;
  oncekiKapanis: number;
  iz: number;
  islemler: Islem[];
}

/** UT Bot Strateji (yalnız long) haftalık mumlarda: geçen haftanın sinyali, pozisyon ve tüm işlemler. */
export function utBotDurumu(b: BarsData): Durum {
  const n = b.time.length;
  if (n < 30) throw new Error(`Yetersiz haftalık veri (${n} mum)`);
  if (!b.lastRealtime) throw new Error("Yeni haftanın mumu henüz yok (Binance); biraz sonra yeniden çalıştırın");
  const r = run(UT_KOD, b, { inputs: { "İşlem yönü": "Yalnız long" } });
  if (!r.ok) throw new Error(`UT Bot çalışmadı: ${"error" in r ? r.error.message : "eksik veri"}`);
  const st = r.output.strategy!;
  const W = b.time[n - 1]!;
  const tum = [...st.trades, ...st.openTrades].sort((x, y) => x.entryTime - y.entryTime);
  const sinyal: Sinyal = tum.some((t) => t.entryTime === W) ? "al" : st.trades.some((t) => t.exitTime === W) ? "sat" : "yok";
  const acik = st.openTrades[0] ?? null;
  const iz = r.output.plots.find((p) => p.title === "İz süren stop")?.values[n - 2] ?? Number.NaN;
  return {
    hafta: W,
    sinyal,
    pozisyon: !!acik,
    acikIslem: acik ? { giris: acik.entryTime, girisFiyat: acik.entryPrice } : null,
    acilis: b.open[n - 1]!,
    oncekiKapanis: b.close[n - 2]!,
    iz,
    islemler: tum.map((t) => ({
      giris: t.entryTime,
      girisFiyat: t.entryPrice,
      cikis: t.open ? null : t.exitTime,
      cikisFiyat: t.exitPrice,
      getiri: t.profitPct,
      acik: t.open,
    })),
  };
}

const mesaj = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Kaydı günceller: kapanan haftaların kapanışı, işlemler, bu haftanın kaydı. Bu haftanın yapay zekâ yorumu yoksa
 * (ilk çalışma ya da önceki deneme başarısız) istemci varsa Claude'a sorulur; zaman o anınki olur.
 */
export async function calistir(o: { kayit: Kayit; mumlar: BarsData; simdi: number; istemci: ClaudeIstemci | null; aiYokNedeni: string }): Promise<{ kayit: Kayit; hafta: Hafta }> {
  const k: Kayit = structuredClone(o.kayit);
  const b = o.mumlar;
  const d = utBotDurumu(b);
  const n = b.time.length;
  for (const h of k.haftalar) {
    if (h.kapanis !== null) continue;
    const i = b.time.indexOf(h.hafta);
    if (i >= 0 && i < n - 1) h.kapanis = b.close[i]!;
  }
  k.islemler = d.islemler.filter((t) => t.giris >= k.baslangic);
  let h = k.haftalar.find((x) => x.hafta === d.hafta);
  if (!h) {
    h = {
      hafta: d.hafta,
      zaman: o.simdi,
      zamaninda: o.simdi - d.hafta <= ZAMANINDA_MS,
      sinyal: d.sinyal,
      pozisyon: d.pozisyon,
      acilis: d.acilis,
      oncekiKapanis: d.oncekiKapanis,
      iz: d.iz,
      ai: null,
      aiHata: null,
      kapanis: null,
    };
    k.haftalar.push(h);
    k.haftalar.sort((x, y) => x.hafta - y.hafta);
  }
  if (!h.ai) {
    if (o.istemci) {
      h.zaman = o.simdi;
      h.zamaninda = o.simdi - d.hafta <= ZAMANINDA_MS;
      const baglam: Baglam = {
        simdi: o.simdi,
        hafta: d.hafta,
        sinyal: d.sinyal,
        pozisyon: d.pozisyon,
        acikIslem: d.acikIslem,
        acilis: d.acilis,
        oncekiKapanis: d.oncekiKapanis,
        iz: d.iz,
        mumlar: Array.from({ length: Math.min(MUM_SAYISI, n - 1) }, (_, j) => n - 1 - Math.min(MUM_SAYISI, n - 1) + j).map((i) => ({
          zaman: b.time[i]!,
          acilis: b.open[i]!,
          yuksek: b.high[i]!,
          dusuk: b.low[i]!,
          kapanis: b.close[i]!,
        })),
      };
      try {
        h.ai = await yorumla(o.istemci, baglam);
        h.aiHata = null;
      } catch (e) {
        h.aiHata = mesaj(e);
      }
    } else {
      h.aiHata = o.aiYokNedeni;
    }
  }
  k.guncelleme = o.simdi;
  return { kayit: k, hafta: h };
}

const gun = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const yuzde = (x: number) => `${x >= 0 ? "+" : "−"}%${Math.abs(x).toFixed(1).replace(".", ",")}`;
const SINYAL: Record<Sinyal, string> = { al: "AL", sat: "SAT", yok: "yok" };
const YON = { yukari: "yukarı", asagi: "aşağı", kararsiz: "kararsız" } as const;

/** Çalışma özeti (Markdown; Actions özet sayfası ve günlük). */
export function rapor(k: Kayit, h: Hafta): string {
  const p = puanla(k);
  const satir = [
    `## Altın · UT Bot haftalık · ${gun(h.hafta)} haftası`,
    "",
    `- UT Bot sinyali (geçen hafta kapanışında): **${SINYAL[h.sinyal]}**; pozisyon: ${h.pozisyon ? "long" : "yok"}; açılış ${h.acilis.toFixed(2)}`,
  ];
  if (h.ai) {
    const a = h.ai;
    if (h.sinyal === "al") satir.push(`- Yapay zekâ kararı: **${a.karar === "atla" ? "ATLA" : "AL"}** (güven %${a.guven})`);
    satir.push(
      `- Haftalık yön tahmini: ${YON[a.yon]} (güven %${a.yonGuveni})${h.zamaninda ? "" : " — geç verildi, sayılmaz"}`,
      `- Özet: ${a.ozet}`,
      `- Gerekçe: ${a.gerekce}`,
      ...a.riskler.map((r) => `- Risk: ${r}`),
      `- Model: ${a.model}; ${a.arama} arama; ${a.girdiToken} + ${a.ciktiToken} token; ~$${a.maliyet.toFixed(2)}`,
    );
  } else {
    satir.push(`- Yapay zekâ yorumu yok: ${h.aiHata ?? "—"}`);
  }
  const d = (x: typeof p.duz) =>
    `${x.islem} işlem, ${x.kazanan} kârlı, ${yuzde(x.getiri)}${x.acik ? `; açık: ${gun(x.acik.giris)} girişli, ${yuzde(x.acik.getiri)}` : ""}`;
  satir.push(
    "",
    `### Puan (${gun(k.baslangic)}'ten beri)`,
    "",
    `- UT Bot olduğu gibi: ${d(p.duz)}`,
    `- Yapay zekâ süzgeçli: ${d(p.ai)}`,
    `- Atlanan işlemler: ${p.atlanan.islem} (${p.atlanan.zararli} zararlıydı)`,
    `- Yön tahmini: ${p.yon.dogru}/${p.yon.tahmin} doğru`,
  );
  return satir.join("\n");
}

function arg(ad: string): string | undefined {
  const i = process.argv.indexOf(ad);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const yol = arg("--kayit");
  if (!yol) throw new Error("--kayit <dosya> gerekli");
  const deneme = process.argv.includes("--deneme");
  const simdi = arg("--simdi") ? Date.parse(arg("--simdi")!) : Date.now();
  let kayit = yeniKayit();
  if (existsSync(yol)) {
    const x: unknown = JSON.parse(readFileSync(yol, "utf8"));
    if (!kayitMi(x)) throw new Error(`${yol}: beklenmeyen kayıt biçimi`);
    kayit = x;
  }
  const anahtar = !!process.env.ANTHROPIC_API_KEY;
  const istemci = !deneme && anahtar ? await istemciKur() : null;
  const aiYokNedeni = deneme ? "deneme çalışması (yapay zekâ çağrılmadı)" : "ANTHROPIC_API_KEY tanımlı değil (GitHub → Settings → Secrets and variables → Actions)";
  const mumlar = await haftalikMumlar(simdi);
  const s = await calistir({ kayit, mumlar, simdi, istemci, aiYokNedeni });
  mkdirSync(dirname(yol), { recursive: true });
  writeFileSync(yol, JSON.stringify(s.kayit, null, 1) + "\n");
  const md = rapor(s.kayit, s.hafta);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  if (istemci && !s.hafta.ai) {
    console.log(`::error::Yapay zekâ yanıt vermedi: ${s.hafta.aiHata}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(mesaj(e));
    process.exit(1);
  });
}
