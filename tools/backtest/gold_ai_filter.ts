/**
 * Yapay zekâ konjonktür süzgeci, geriye dönük (A_STUDY, protocol.ts; takvim ve kural konjonktur.ts). Altında UT Bot
 * Strateji (varsayılan ayarlar) 1 saat / 4 saat / 1 gün / 1 hafta, iki biçim; her sinyalde karar anındaki haber görüşü
 * ve üst zaman dilimi trendiyle "al / alma". Çıkışlar UT Bot'un kendi ters sinyali, bu yüzden süzgeç motorun işlem
 * listesinden işlem atlamakla birebir aynıdır (atlanan sinyalden sonra bir sonraki sinyale kadar pozisyon yok).
 * Kullanım: node --import jiti/register tools/backtest/gold_ai_filter.ts  →  .cache/results/gold_ai_filter.md
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resample } from "../../src/data/source";
import { haberAt, kararGrafik, kararHaber, kararHaberGrafik, UST_TREND, type Gorus } from "./konjonktur";
import { loadBars, ROOT, type Trade } from "./lib";
import { Pool } from "./pool";
import { A_STUDY } from "./protocol";

const SYM = "SPOT-PAXGUSDT";
const TF_AD: Record<number, string> = { 3600: "1 saat", 14_400: "4 saat", 86_400: "1 gün", 604_800: "1 hafta" };
const BICIMLER: [string, Record<string, unknown>][] = [
  ["Al→long, Sat→short", {}],
  ["yalnız long", { "İşlem yönü": "Yalnız long" }],
];
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d).replace(".", ",") : "—");
const yuzde = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}%${f(Math.abs(x), d)}` : "—");
const gun = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Üst zaman diliminde trend: son kapanmış mumda kapanış EMA'nın üstündeyse +1. */
function trendBul(tf: number, n: number): (t: number) => 1 | -1 {
  const b = resample(loadBars(SYM, "15m"), tf);
  const N = b.time.length;
  const kapanis = new Float64Array(N);
  const yon = new Int8Array(N);
  const a = 2 / (n + 1);
  let ema = b.close[0]!;
  for (let i = 0; i < N; i++) {
    ema = i === 0 ? b.close[0]! : a * b.close[i]! + (1 - a) * ema;
    yon[i] = b.close[i]! > ema ? 1 : -1;
    kapanis[i] = b.time[i]! + tf * 1000;
  }
  return (t) => {
    let lo = 0;
    let hi = N; // ilk kapanis > t
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (kapanis[m]! <= t) lo = m + 1;
      else hi = m;
    }
    return lo > 0 ? (yon[lo - 1] as 1 | -1) : 1;
  };
}

interface Ozet {
  n: number;
  kazanma: number;
  ort: number;
  pf: number;
  net: number;
  dusus: number;
}

function ozet(ts: readonly Trade[]): Ozet {
  const s = [...ts].sort((x, y) => x.exitTime - y.exitTime);
  let pos = 0;
  let neg = 0;
  let wins = 0;
  let eq = 1;
  let tepe = 1;
  let dusus = 0;
  for (const t of s) {
    if (t.ret > 0) {
      wins++;
      pos += t.ret;
    } else neg -= t.ret;
    eq *= 1 + t.ret / 100;
    tepe = Math.max(tepe, eq);
    dusus = Math.max(dusus, 1 - eq / tepe);
  }
  const n = s.length;
  return { n, kazanma: n ? (wins / n) * 100 : NaN, ort: n ? (pos - neg) / n : NaN, pf: neg > 0 ? pos / neg : pos > 0 ? Infinity : NaN, net: (eq - 1) * 100, dusus: dusus * 100 };
}

const bilesik = (ts: readonly Trade[]) => (ts.reduce((m, t) => m * (1 + t.ret / 100), 1) - 1) * 100;

/** Tohumlu rastgele sayı (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Aynı sayıda işlemi rastgele tutan süzgeç: asıl kararın neti dağılımın yüzde kaçının üstünde ve dağılımın ortancası. */
function rastgele(ts: readonly Trade[], k: number, net: number, cekilis: number, seed: number): { yuzdelik: number; ortanca: number } {
  const r = rng(seed);
  const idx = ts.map((_, i) => i);
  const nets: number[] = [];
  for (let c = 0; c < cekilis; c++) {
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(r() * (idx.length - i));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    nets.push(bilesik(idx.slice(0, k).map((i) => ts[i]!)));
  }
  nets.sort((x, y) => x - y);
  const alt = nets.filter((x) => x < net).length + 0.5 * nets.filter((x) => x === net).length;
  return { yuzdelik: (alt / cekilis) * 100, ortanca: nets[Math.floor(cekilis / 2)]! };
}

const SUZGECLER = ["UT Bot (olduğu gibi)", "Yalnız haber", "Yalnız grafik", "Yapay zekâ: haber + grafik"] as const;

async function main(): Promise<void> {
  const { from, to } = A_STUDY.window;
  const pool = new Pool();
  const isler = A_STUDY.tfs.flatMap((tf) => BICIMLER.map(([ad, inputs]) => ({ tf, ad, inputs })));
  const sonuc = await Promise.all(
    isler.map((j) => pool.run({ script: `${ROOT}src/pine/library/ut_bot_strategy.pine`, symbol: SYM, from, to, inputs: j.inputs, tf: j.tf, data: "15m", warmupDays: 200 })),
  );
  await pool.close();

  const md: string[] = [
    "# Altında UT Bot + yapay zekâ konjonktür süzgeci (geriye dönük)",
    "",
    `Spot PAXG/USDT, ${gun(from)} → ${gun(to)}, UT Bot varsayılan (anahtar 1, ATR 10), komisyon %0,05/taraf.`,
    "Karar: konjonktür olumlu → yalnız long, olumsuz → yalnız short, karışık → üst zaman dilimi trendi (konjonktur.ts).",
    "Uyarı: takvim sonradan ne olduğunu bilen biri tarafından yazıldı; sonuç iyimser bir üst sınırdır.",
    "",
  ];
  const ayrinti: string[] = ["", "## Sinyal sinyal kararlar (haftalık ve günlük)", ""];

  isler.forEach((j, k) => {
    const ts = sonuc[k]!.trades;
    const ust = UST_TREND[j.tf]!;
    const trend = trendBul(ust.tf, ust.ema);
    const kararlar = ts.map((t) => {
      const h = haberAt(t.entryTime);
      const tr = trend(t.entryTime);
      const yon = (t.dir > 0 ? 1 : -1) as 1 | -1;
      return {
        t,
        h,
        tr,
        haber: kararHaber(yon, h.gorus as Gorus),
        grafik: kararGrafik(yon, tr),
        ai: kararHaberGrafik(yon, h.gorus as Gorus, tr),
      };
    });
    const secim: Record<(typeof SUZGECLER)[number], Trade[]> = {
      "UT Bot (olduğu gibi)": ts,
      "Yalnız haber": kararlar.filter((x) => x.haber).map((x) => x.t),
      "Yalnız grafik": kararlar.filter((x) => x.grafik).map((x) => x.t),
      "Yapay zekâ: haber + grafik": kararlar.filter((x) => x.ai).map((x) => x.t),
    };
    const atlanan = kararlar.filter((x) => !x.ai).map((x) => x.t);
    const ai = secim["Yapay zekâ: haber + grafik"];
    const ctl = rastgele(ts, ai.length, ozet(ai).net, A_STUDY.randomDraws, 1000 + k);
    const habereGore = kararlar.filter((x) => x.h.gorus !== 0).length;

    md.push(`## ${TF_AD[j.tf]} · ${j.ad}`, "", `Grafik okuması: ${ust.ad}. Kararların ${habereGore}/${ts.length}'i habere, kalanı grafiğe göre.`, "");
    md.push("| süzgeç | işlem | kazanma % | ort. işlem % | PF | net % | maks. düşüş % |", "|---|---|---|---|---|---|---|");
    for (const s of SUZGECLER) {
      const o = ozet(secim[s]);
      md.push(`| ${s} | ${o.n} | ${f(o.kazanma)} | ${f(o.ort, 3)} | ${f(o.pf, 2)} | ${yuzde(o.net)} | ${f(o.dusus)} |`);
    }
    const oa = ozet(atlanan);
    md.push(
      "",
      `- Yapay zekânın atladığı ${oa.n} işlem: kazanma %${f(oa.kazanma)}, ort. ${f(oa.ort, 3)}%, birlikte ${yuzde(oa.net)}.`,
      `- Rastgele süzgeç (aynı sayıda işlem, ${A_STUDY.randomDraws} çekiliş): ortanca ${yuzde(ctl.ortanca)}; yapay zekâ çekilişlerin %${f(ctl.yuzdelik, 0)}'inden iyi.`,
    );
    // yıllar
    const yillar = [...new Set(ts.map((t) => new Date(t.entryTime).getUTCFullYear()))].sort();
    const yil = (xs: Trade[], y: number) => xs.filter((t) => new Date(t.entryTime).getUTCFullYear() === y);
    md.push(
      `- Yıllar (UT Bot → yapay zekâ, net): ${yillar.map((y) => `${y}: ${yuzde(bilesik(yil(ts, y)), 0)} → ${yuzde(bilesik(yil(ai, y)), 0)}`).join("; ")}`,
      "",
    );
    if (j.tf >= 86_400) {
      ayrinti.push(`### ${TF_AD[j.tf]} · ${j.ad}`, "", "| giriş | yön | haber görüşü (son haber) | trend | karar | işlem % |", "|---|---|---|---|---|---|");
      for (const x of kararlar) {
        const g = x.h.gorus === 1 ? "olumlu" : x.h.gorus === -1 ? "olumsuz" : "karışık";
        ayrinti.push(
          `| ${gun(x.t.entryTime)} | ${x.t.dir > 0 ? "long" : "short"} | ${g} (${x.h.tarih}: ${x.h.haber.slice(0, 70)}${x.h.haber.length > 70 ? "…" : ""}) | ${x.tr > 0 ? "yukarı" : "aşağı"} | ${x.ai ? "AL" : "alma"} | ${yuzde(x.t.ret, 2)} |`,
        );
      }
      ayrinti.push("");
    }
  });

  const text = [...md, ...ayrinti].join("\n");
  mkdirSync(`${ROOT}.cache/results`, { recursive: true });
  writeFileSync(`${ROOT}.cache/results/gold_ai_filter.md`, text + "\n");
  console.log(md.join("\n"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
