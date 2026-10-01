/**
 * Yapay zekâ yorumcusu (ileriye dönük kâğıt deneme). Her gün, günlük mum kapandıktan sonra çalışır: PAXG/USDT günlük ve
 * haftalık mumlarında UT Bot Strateji'yi (varsayılan ayarlar, yalnız long) uygulamanın Pine motoruyla çalıştırır.
 * Önceki mumda sinyal (Al / Sat) varsa, haftalıkta ise her pazartesi (sinyal olmasa da), Claude'dan 0–100 al-sat puanı
 * ve açıklama ister, kaydı günceller.
 * Kullanım: node --import jiti/register tools/ai/yorumcu.ts --kayit <yorumlar.json> [--deneme] [--simdi <ISO>]
 *   --deneme: yapay zekâ çağrılmaz (veri ve UT Bot denetimi). ANTHROPIC_API_KEY yoksa da çağrılmaz.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_SEMBOL, kayitOku, puanAdi, puanla, TF_AD, TF_LISTE, TF_SN, yeniKayit, ZAMANINDA_MS, type Islem, type Kayit, type Olay, type Sinyal, type Tf } from "../../src/ai/yorum";
import { BinanceSource, SPOT } from "../../src/data/binance";
import { run, type BarsData } from "../../src/pine";
import { istemciKur, yorumla, type Baglam, type ClaudeIstemci } from "./claude";

const UT_KOD = readFileSync(fileURLToPath(new URL("../../src/pine/library/ut_bot_strategy.pine", import.meta.url)), "utf8");
const MUM_SAYISI = 12;

/** Binance spot mumları (son eleman oluşan mum). */
export async function mumlariGetir(tf: Tf, simdi: number): Promise<BarsData> {
  const b = await new BinanceSource(SPOT).klines(AI_SEMBOL, tf, 1000);
  const n = b.time.length;
  b.lastRealtime = n > 0 && b.time[n - 1]! + TF_SN[tf] * 1000 > simdi;
  return b;
}

export interface Durum {
  /** Oluşan mumun açılışı. */
  zaman: number;
  sinyal: Sinyal;
  pozisyon: boolean;
  acikIslem: { giris: number; girisFiyat: number } | null;
  acilis: number;
  oncekiKapanis: number;
  iz: number;
  islemler: Islem[];
}

/** UT Bot Strateji (yalnız long): önceki mumun sinyali, pozisyon ve tüm işlemler. */
export function utBotDurumu(b: BarsData): Durum {
  const n = b.time.length;
  if (n < 30) throw new Error(`Yetersiz veri (${n} mum)`);
  if (!b.lastRealtime) throw new Error("Yeni mum henüz yok (Binance); biraz sonra yeniden çalıştırın");
  const r = run(UT_KOD, b, { inputs: { "İşlem yönü": "Yalnız long" } });
  if (!r.ok) throw new Error(`UT Bot çalışmadı: ${"error" in r ? r.error.message : "eksik veri"}`);
  const st = r.output.strategy!;
  const W = b.time[n - 1]!;
  const tum = [...st.trades, ...st.openTrades].sort((x, y) => x.entryTime - y.entryTime);
  const sinyal: Sinyal = tum.some((t) => t.entryTime === W) ? "al" : st.trades.some((t) => t.exitTime === W) ? "sat" : "yok";
  const acik = st.openTrades[0] ?? null;
  const iz = r.output.plots.find((p) => p.title === "İz süren stop")?.values[n - 2] ?? Number.NaN;
  return {
    zaman: W,
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

function baglam(e: Olay, d: Durum, b: BarsData, simdi: number): Baglam {
  const n = b.time.length;
  const k = Math.min(MUM_SAYISI, n - 1);
  return {
    simdi,
    tf: e.tf,
    zaman: e.zaman,
    sinyal: e.sinyal,
    pozisyon: d.pozisyon,
    acikIslem: d.acikIslem,
    acilis: d.acilis,
    oncekiKapanis: d.oncekiKapanis,
    iz: d.iz,
    mumlar: Array.from({ length: k }, (_, j) => n - 1 - k + j).map((i) => ({
      zaman: b.time[i]!,
      acilis: b.open[i]!,
      yuksek: b.high[i]!,
      dusuk: b.low[i]!,
      kapanis: b.close[i]!,
    })),
  };
}

/**
 * Kaydı günceller: kapanan mumların kapanışı, işlemler; günlükte sinyal varsa, haftalıkta her hafta yeni olay. Yeni ya
 * da daha önce yanıtsız kalmış olay için istemci varsa Claude'a sorulur (zaman o anınki olur).
 */
export async function calistir(o: {
  kayit: Kayit;
  mumlar: Record<Tf, BarsData>;
  simdi: number;
  istemci: ClaudeIstemci | null;
  aiYokNedeni: string;
}): Promise<{ kayit: Kayit; yeni: Olay[] }> {
  const k: Kayit = structuredClone(o.kayit);
  const sorulacak: [Olay, Durum, BarsData][] = [];
  const yeni: Olay[] = [];
  for (const tf of TF_LISTE) {
    const b = o.mumlar[tf];
    const d = utBotDurumu(b);
    const n = b.time.length;
    for (const e of k.olaylar) {
      if (e.tf !== tf || e.kapanis !== null) continue;
      const i = b.time.indexOf(e.zaman);
      if (i >= 0 && i < n - 1) e.kapanis = b.close[i]!;
    }
    k.islemler[tf] = d.islemler.filter((t) => t.giris >= k.baslangic);
    let e = k.olaylar.find((x) => x.tf === tf && x.zaman === d.zaman);
    if (!e && (tf === "1w" || d.sinyal !== "yok")) {
      e = {
        tf,
        zaman: d.zaman,
        sinyal: d.sinyal,
        karar: o.simdi,
        zamaninda: o.simdi - d.zaman <= ZAMANINDA_MS,
        pozisyon: d.pozisyon,
        acilis: d.acilis,
        oncekiKapanis: d.oncekiKapanis,
        iz: d.iz,
        ai: null,
        aiHata: null,
        kapanis: null,
      };
      k.olaylar.push(e);
      yeni.push(e);
    }
    if (e && !e.ai) sorulacak.push([e, d, b]);
  }
  k.olaylar.sort((x, y) => x.zaman - y.zaman || TF_SN[y.tf] - TF_SN[x.tf]);
  for (const [e, d, b] of sorulacak) {
    if (!o.istemci) {
      e.aiHata = o.aiYokNedeni;
      continue;
    }
    e.karar = o.simdi;
    e.zamaninda = o.simdi - e.zaman <= ZAMANINDA_MS;
    try {
      e.ai = await yorumla(o.istemci, baglam(e, d, b, o.simdi));
      e.aiHata = null;
    } catch (err) {
      e.aiHata = mesaj(err);
    }
  }
  k.guncelleme = o.simdi;
  return { kayit: k, yeni };
}

const gun = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const yuzde = (x: number) => `${x >= 0 ? "+" : "−"}%${Math.abs(x).toFixed(1).replace(".", ",")}`;
const SINYAL: Record<Sinyal, string> = { al: "AL", sat: "SAT", yok: "sinyal yok" };

/** Çalışma özeti (Markdown; Actions özet sayfası ve günlük). */
export function rapor(k: Kayit, olaylar: Olay[]): string {
  const p = puanla(k);
  const satir = ["## Altın · UT Bot + yapay zekâ puanı", ""];
  const son = olaylar.length ? olaylar : k.olaylar.slice(-1);
  for (const e of son) {
    satir.push(`### ${TF_AD[e.tf]} · ${gun(e.zaman)} · ${SINYAL[e.sinyal]}${e.zamaninda ? "" : " (geç, sayılmaz)"}`, "");
    if (e.ai) {
      const a = e.ai;
      satir.push(
        `- Yapay zekâ puanı: **${a.puan}/100** (${puanAdi(a.puan).ad})`,
        `- Açıklama: ${a.aciklama}`,
        `- Haberler: ${a.ozet}`,
        ...a.riskler.map((r) => `- Risk: ${r}`),
        `- Model: ${a.model}; ${a.arama} arama; ${a.girdiToken} + ${a.ciktiToken} token; ~$${a.maliyet.toFixed(2)}`,
        "",
      );
    } else satir.push(`- Yapay zekâ puanı yok: ${e.aiHata ?? "—"}`, "");
  }
  if (!olaylar.length) satir.push("Bugün yeni sinyal yok.", "");
  const d = (x: (typeof p.tf)["1d"]["duz"]) =>
    `${x.islem} işlem, ${x.kazanan} kârlı, ${yuzde(x.getiri)}${x.acik ? `; açık: ${gun(x.acik.giris)} girişli, ${yuzde(x.acik.getiri)}` : ""}`;
  satir.push(`### Puan (${gun(k.baslangic)}'ten beri)`, "");
  for (const tf of TF_LISTE) {
    const q = p.tf[tf];
    satir.push(`- ${TF_AD[tf]} UT Bot: ${d(q.duz)}`, `- ${TF_AD[tf]} yapay zekâ (puan ≥ 50): ${d(q.ai)}; atlanan ${q.atlanan.islem} (${q.atlanan.zararli} zararlıydı)`);
  }
  satir.push(`- Haftalık puanın yön isabeti: ${p.hafta.dogru}/${p.hafta.tahmin}`);
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
    const x = kayitOku(JSON.parse(readFileSync(yol, "utf8")));
    if (!x) throw new Error(`${yol}: beklenmeyen kayıt biçimi`);
    kayit = x;
  }
  const anahtar = !!process.env.ANTHROPIC_API_KEY;
  const istemci = !deneme && anahtar ? await istemciKur() : null;
  const aiYokNedeni = deneme ? "deneme çalışması (yapay zekâ çağrılmadı)" : "ANTHROPIC_API_KEY tanımlı değil (GitHub → Settings → Secrets and variables → Actions)";
  const mumlar = { "1d": await mumlariGetir("1d", simdi), "1w": await mumlariGetir("1w", simdi) };
  const s = await calistir({ kayit, mumlar, simdi, istemci, aiYokNedeni });
  mkdirSync(dirname(yol), { recursive: true });
  writeFileSync(yol, JSON.stringify(s.kayit, null, 1) + "\n");
  const md = rapor(s.kayit, s.yeni);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  const yanitsiz = istemci ? s.kayit.olaylar.filter((e) => !e.ai && e.karar === simdi) : [];
  if (yanitsiz.length) {
    for (const e of yanitsiz) console.log(`::error::Yapay zekâ yanıt vermedi (${TF_AD[e.tf]} ${gun(e.zaman)}): ${e.aiHata}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(mesaj(e));
    process.exit(1);
  });
}
