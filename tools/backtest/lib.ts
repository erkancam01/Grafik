/** Deneme düzeneği ortak araçları: önbellekteki mumlar, strateji koşusu ve işlem ölçütleri. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { heikinAshi, resample } from "../../src/data/source";
import { compile, dataKey, run, type BarsData, type DataRequest, type PineOutput } from "../../src/pine";
import type { Compiled } from "../../src/pine/compiler";
import { COMMISSION, WARMUP_DAYS } from "./protocol";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BARS_DIR = `${ROOT}.cache/bars`;
const DAY = 86_400_000;
const IST = 3 * 3_600_000;

/** `import_market_data.py` çıktısı: art arda Float64 sütunlar (zaman, açılış, yüksek, düşük, kapanış, hacim). */
export function loadBars(symbol: string, tf: "1m" | "5m" = "5m"): BarsData {
  const buf = readFileSync(`${BARS_DIR}/${symbol}_${tf}.f64`);
  const all = new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const n = all.length / 6;
  const col = (k: number) => all.subarray(k * n, (k + 1) * n);
  return { time: col(0), open: col(1), high: col(2), low: col(3), close: col(4), volume: col(5), tfSec: tf === "1m" ? 60 : 300, symbol, lastRealtime: false };
}

/** `a`'da `x`'ten küçük olmayan ilk indeks. */
export function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m]! < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Açılış zamanı [from, to] aralığındaki mumlar (kopyasız). */
export function sliceTime(b: BarsData, from: number, to: number): BarsData {
  const i0 = lowerBound(b.time, from);
  const i1 = lowerBound(b.time, to + 1);
  const s = (a: Float64Array) => a.subarray(i0, i1);
  return { ...b, time: s(b.time), open: s(b.open), high: s(b.high), low: s(b.low), close: s(b.close), volume: s(b.volume) };
}

export interface Trade {
  dir: number;
  entryTime: number;
  exitTime: number;
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  /** Komisyon dahil getiri (% , pozisyon değerine göre). */
  ret: number;
  exit: string;
  /** TP ve SL/BE seviyelerinin ikisi de çıkış mumunun içinde (motor mum içi sırayı varsayar). */
  amb: boolean;
  /** Çıkış mumunda geçerli kâr al ve zarar kes / başa baş seviyeleri (TP/SL/BE çıkışlarında; yoksa NaN). */
  tp: number;
  sl: number;
}

export interface Job {
  script: string;
  symbol: string;
  from: number;
  to: number;
  inputs: Record<string, unknown>;
  /** % / taraf (varsayılan COMMISSION). */
  comm?: number;
  /** Test başından önce yüklenen gün (varsayılan WARMUP_DAYS; günlük trend için daha uzun). */
  warmupDays?: number;
  /** Grafik zaman dilimi, saniye (varsayılan 300 = 5 dk; 900 = 15 dk, 5 dk mumlardan üretilir). */
  tf?: number;
  /**
   * Uygulamadaki gibi yükleme (src/App.tsx, src/indicators/compute.ts): grafik = son max(5000, test başı + 300)
   * mum; üst zaman dilimi = grafiğin kapsadığı süre + 400 mum. `now` = uygulamanın saati (ms).
   */
  appLike?: { now: number };
}

export interface JobResult {
  trades: Trade[];
  warnings: string[];
  bars: number;
  ms: number;
}

const num = (out: PineOutput, inputs: Record<string, unknown>, title: string): number => {
  const v = inputs[title] ?? out.inputs.find((x) => x.key === title)?.defval;
  return typeof v === "number" ? v : Number.NaN;
};

/** Mumları ve derlenmiş betikleri önbelleğe alan koşucu (her işçide bir tane). */
export class Runner {
  private bars = new Map<string, BarsData>();
  private scripts = new Map<string, Compiled>();
  private extras = new Map<string, BarsData>();

  private barsTf(symbol: string, tf: number): BarsData {
    const key = `${symbol}|${tf}`;
    let b = this.bars.get(key);
    if (!b) {
      const m5 = loadBars(symbol, "5m");
      this.bars.set(key, (b = tf === 300 ? m5 : resample(m5, tf)));
    }
    return b;
  }

  private script(path: string): Compiled {
    let c = this.scripts.get(path);
    if (!c) this.scripts.set(path, (c = compile(readFileSync(path, "utf8"))));
    return c;
  }

  /** request.security verisi: aynı aralıktaki 5 dk mumlardan üst zaman dilimi / Heikin Ashi. */
  private extraFor(from: number, to: number, q: DataRequest): BarsData {
    const key = `${from}|${to}|${dataKey(q)}`;
    let x = this.extras.get(key);
    if (!x) {
      const base = sliceTime(this.barsTf(q.symbol, 300), from, to);
      const tf = q.tfSec === 300 ? base : resample(base, q.tfSec);
      this.extras.set(key, (x = q.heikinAshi ? heikinAshi(tf) : tf));
    }
    return x;
  }

  /** Uygulamadaki gibi: grafiğin süresi + 400 üst zaman dilimi mumu, en yeni mumla biten. */
  private extraAppLike(chart: BarsData, q: DataRequest): BarsData {
    const n = chart.time.length;
    const span = chart.time[n - 1]! - chart.time[0]! + chart.tfSec * 1000;
    const want = Math.min(50_000, Math.ceil(span / (q.tfSec * 1000)) + (q.tfSec >= chart.tfSec ? 400 : 0));
    const all = this.barsTf(q.symbol, 300);
    const tf = q.tfSec === 300 ? all : resample(all, q.tfSec);
    const m = tf.time.length;
    const x = sliceTime(tf, tf.time[Math.max(0, m - want)]!, tf.time[m - 1]!);
    return q.heikinAshi ? heikinAshi(x) : x;
  }

  run(job: Job): JobResult {
    const t0 = performance.now();
    const c = this.script(job.script);
    const tfSec = job.tf ?? 300;
    let from = job.from - (job.warmupDays ?? WARMUP_DAYS) * DAY;
    let to = job.to + DAY; // aralıktan sonra en az bir mum: açık pozisyon "Dönem sonu" ile kapanır
    let b = sliceTime(this.barsTf(job.symbol, tfSec), from, to);
    if (job.appLike) {
      const all = this.barsTf(job.symbol, tfSec);
      const want = Math.min(50_000, Math.max(5000, Math.ceil((job.appLike.now - job.from) / (tfSec * 1000)) + 300));
      const n = all.time.length;
      b = sliceTime(all, all.time[Math.max(0, n - want)]!, all.time[n - 1]!);
      from = b.time[0]!;
      to = b.time[b.time.length - 1]!;
    }
    const inputs: Record<string, unknown> = {
      ...job.inputs,
      "__s.comm_type": "percent",
      "__s.comm": job.comm ?? COMMISSION,
      "__s.from": job.from,
      "__s.to": job.to,
    };
    const extra: Record<string, BarsData> = {};
    for (let round = 0; round < 5; round++) {
      const r = run(c, b, { inputs, extra, timeLimitMs: 3_600_000, maxOps: Number.MAX_SAFE_INTEGER });
      if (r.ok) return { ...collect(r.output, b, inputs), bars: b.time.length, ms: performance.now() - t0 };
      if ("error" in r) throw new Error(`${job.symbol}: satır ${r.error.line}: ${r.error.message}`);
      if (q0(r.needData)) throw new Error(`${job.symbol}: veri isteği çözülemedi`);
      for (const q of r.needData) extra[dataKey(q)] = job.appLike ? this.extraAppLike(b, q) : this.extraFor(from, to, q);
    }
    throw new Error(`${job.symbol}: request.security 5 turda çözülemedi`);
  }
}

const q0 = (reqs: DataRequest[]) => reqs.some((q) => q.tfSec < 300);

function collect(out: PineOutput, b: BarsData, inputs: Record<string, unknown>): Omit<JobResult, "bars" | "ms"> {
  const s = out.strategy;
  if (!s) throw new Error("strategy() çıktısı yok");
  const atrPlot = out.plots.find((p) => p.title === "ATR giriş")?.values;
  const bePlot = out.plots.find((p) => p.title === "BE açık")?.values;
  const tpK = num(out, inputs, "Kâr al (ATR katı)");
  const slK = num(out, inputs, "Zarar kes (ATR katı)");
  const bePct = num(out, inputs, "Başa baş payı (%)");
  const trades = s.trades.map((t): Trade => {
    let amb = false;
    let tp = Number.NaN;
    let sl = Number.NaN;
    const k = t.exitBar - 1; // çıkış mumunda geçerli seviyeler bir önceki mum kapanışında belirlenmiştir
    if (atrPlot && k >= 0 && (t.exitComment === "TP" || t.exitComment === "SL" || t.exitComment === "BE")) {
      const atr = atrPlot[k]!;
      const d = t.dir;
      tp = t.entryPrice + d * tpK * atr;
      sl = bePlot && bePlot[k] === 1 ? t.entryPrice * (1 + (d * bePct) / 100) : t.entryPrice - d * slK * atr;
      const hi = b.high[t.exitBar]!;
      const lo = b.low[t.exitBar]!;
      amb = d > 0 ? lo <= sl && hi >= tp : hi >= sl && lo <= tp;
    }
    return {
      dir: t.dir,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryBar: t.entryBar,
      exitBar: t.exitBar,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      ret: t.profitPct,
      exit: t.exitComment || t.exitId,
      amb,
      tp,
      sl,
    };
  });
  return { trades, warnings: out.warnings };
}

// ------------------------------------------------------------------ ölçütler

export interface Stats {
  n: number;
  wins: number;
  winRate: number;
  sumRet: number;
  avgRet: number;
  /** Getiri % toplamlarıyla kâr faktörü (pozisyon büyüklüğünden bağımsız). */
  pf: number;
  maxConsecLoss: number;
  amb: number;
  avgBars: number;
  exits: Record<string, number>;
}

export function stats(ts: readonly Trade[]): Stats {
  let wins = 0;
  let pos = 0;
  let neg = 0;
  let run = 0;
  let maxRun = 0;
  let amb = 0;
  let bars = 0;
  const exits: Record<string, number> = {};
  for (const t of ts) {
    if (t.ret > 0) {
      wins++;
      pos += t.ret;
      run = 0;
    } else {
      neg -= t.ret;
      run++;
      if (run > maxRun) maxRun = run;
    }
    if (t.amb) amb++;
    bars += t.exitBar - t.entryBar + 1;
    exits[t.exit] = (exits[t.exit] ?? 0) + 1;
  }
  const n = ts.length;
  return {
    n,
    wins,
    winRate: n ? (wins / n) * 100 : Number.NaN,
    sumRet: pos - neg,
    avgRet: n ? (pos - neg) / n : Number.NaN,
    pf: neg > 0 ? pos / neg : pos > 0 ? Number.POSITIVE_INFINITY : Number.NaN,
    maxConsecLoss: maxRun,
    amb,
    avgBars: n ? bars / n : Number.NaN,
    exits,
  };
}

/** Kazanma oranı için Wilson %95 güven aralığı (yüzde). */
export function wilson(wins: number, n: number): [number, number] {
  if (!n) return [Number.NaN, Number.NaN];
  const z = 1.96;
  const p = wins / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [(mid - half) * 100, (mid + half) * 100];
}

/** İstanbul saatine göre çeyrek etiketi (ör. "2025Ç2"). */
export function quarterOf(t: number): string {
  const d = new Date(t + IST);
  return `${d.getUTCFullYear()}Ç${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** İstanbul saatine göre gün (ör. 20250401) — gün-blok bootstrap için. */
export function dayOf(t: number): number {
  const d = new Date(t + IST);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Ortalama işlem getirisi için gün-blok bootstrap %95 aralığı (coinler aynı günleri paylaşır). */
export function bootstrapAvgRet(ts: readonly Trade[], iters = 2000, seed = 1): [number, number] {
  const byDay = new Map<number, number[]>();
  for (const t of ts) {
    const k = dayOf(t.entryTime);
    let a = byDay.get(k);
    if (!a) byDay.set(k, (a = []));
    a.push(t.ret);
  }
  const days = [...byDay.values()];
  if (!days.length) return [Number.NaN, Number.NaN];
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const means: number[] = [];
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < days.length; k++) {
      const d = days[Math.floor(rnd() * days.length)]!;
      for (const r of d) sum += r;
      n += d.length;
    }
    means.push(n ? sum / n : 0);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(iters * 0.025)]!, means[Math.floor(iters * 0.975)]!];
}
