import { heikinAshi, resample } from "../src/data/source";
import { run } from "../src/pine";
import { dataKey, type BarsData, type RunOptions, type RunResult } from "../src/pine/types";

export { resample };

/** Çalıştırır; request.security isteklerini (üst zaman dilimi, Heikin Ashi) aynı mumlardan üreterek karşılar. */
export function runWithData(code: string, bars: BarsData, opts: RunOptions = {}): RunResult {
  const extra: Record<string, BarsData> = { ...opts.extra };
  let r = run(code, bars, { ...opts, extra });
  for (let round = 0; round < 5 && !r.ok && "needData" in r; round++) {
    for (const q of r.needData) {
      const base = q.symbol === bars.symbol ? bars : { ...bars, symbol: q.symbol };
      const tf = q.tfSec === bars.tfSec ? base : resample(base, q.tfSec);
      extra[dataKey(q)] = q.heikinAshi ? heikinAshi(tf) : tf;
    }
    r = run(code, bars, { ...opts, extra });
  }
  return r;
}

/** Tohumlu rastgele sayı üreteci (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Kapanışlardan basit mumlar (açılış = önceki kapanış). */
export function barsFromCloses(closes: number[], tfSec = 3600, start = Date.UTC(2026, 0, 1)): BarsData {
  const N = closes.length;
  const b: BarsData = {
    time: new Float64Array(N),
    open: new Float64Array(N),
    high: new Float64Array(N),
    low: new Float64Array(N),
    close: new Float64Array(N),
    volume: new Float64Array(N),
    tfSec,
    symbol: "BTCUSDT",
    lastRealtime: false,
  };
  for (let i = 0; i < N; i++) {
    const c = closes[i]!;
    const o = i > 0 ? closes[i - 1]! : c;
    b.time[i] = start + i * tfSec * 1000;
    b.open[i] = o;
    b.close[i] = c;
    b.high[i] = Math.max(o, c) + 0.5;
    b.low[i] = Math.min(o, c) - 0.5;
    b.volume[i] = 100 + (i % 7) * 10;
  }
  return b;
}

/** Tohumlu rastgele yürüyüş mumları (trend + dalgalanma rejimleri). */
export function randomBars(N: number, seed = 1, tfSec = 3600, start = Date.UTC(2025, 0, 1)): BarsData {
  const r = rng(seed);
  const b: BarsData = {
    time: new Float64Array(N),
    open: new Float64Array(N),
    high: new Float64Array(N),
    low: new Float64Array(N),
    close: new Float64Array(N),
    volume: new Float64Array(N),
    tfSec,
    symbol: "BTCUSDT",
    lastRealtime: false,
  };
  let p = 100;
  for (let i = 0; i < N; i++) {
    const drift = Math.sin(i / 150) * 0.002;
    const o = p;
    const ret = drift + (r() - 0.5) * 0.02;
    const c = o * (1 + ret);
    const h = Math.max(o, c) * (1 + r() * 0.006);
    const l = Math.min(o, c) * (1 - r() * 0.006);
    b.time[i] = start + i * tfSec * 1000;
    b.open[i] = o;
    b.high[i] = h;
    b.low[i] = l;
    b.close[i] = c;
    b.volume[i] = 1000 + r() * 500;
    p = c;
  }
  return b;
}
