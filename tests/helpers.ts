import type { BarsData } from "../src/pine/types";

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

/** Mumları daha büyük zaman dilimine toplar (Binance mumları gibi, epoch hizalı). */
export function resample(b: BarsData, tfSec: number): BarsData {
  const out = {
    time: [] as number[],
    open: [] as number[],
    high: [] as number[],
    low: [] as number[],
    close: [] as number[],
    volume: [] as number[],
  };
  for (let i = 0; i < b.time.length; i++) {
    const t = Math.floor(b.time[i]! / (tfSec * 1000)) * tfSec * 1000;
    const k = out.time.length - 1;
    if (k >= 0 && out.time[k] === t) {
      out.high[k] = Math.max(out.high[k]!, b.high[i]!);
      out.low[k] = Math.min(out.low[k]!, b.low[i]!);
      out.close[k] = b.close[i]!;
      out.volume[k]! += b.volume[i]!;
    } else {
      out.time.push(t);
      out.open.push(b.open[i]!);
      out.high.push(b.high[i]!);
      out.low.push(b.low[i]!);
      out.close.push(b.close[i]!);
      out.volume.push(b.volume[i]!);
    }
  }
  return {
    time: Float64Array.from(out.time),
    open: Float64Array.from(out.open),
    high: Float64Array.from(out.high),
    low: Float64Array.from(out.low),
    close: Float64Array.from(out.close),
    volume: Float64Array.from(out.volume),
    tfSec,
    symbol: b.symbol,
    lastRealtime: false,
  };
}
