/** Veri kaynağı arayüzü (Binance vadeli / spot / demo) ve ortak yardımcılar. */
import type { BarsData } from "../pine/types";

export interface SymbolInfo {
  symbol: string;
  price: number;
  changePct: number;
  quoteVolume: number;
}

export interface LiveBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

export interface DataSource {
  readonly name: string;
  readonly label: string;
  symbols(): Promise<SymbolInfo[]>;
  /** `endTime` (ms) öncesindeki en çok `limit` mum; endTime yoksa en yeniler. */
  klines(symbol: string, interval: string, limit: number, endTime?: number): Promise<BarsData>;
  /** Canlı mum aboneliği; dönen fonksiyon aboneliği kapatır. */
  subscribe(symbol: string, interval: string, onBar: (b: LiveBar) => void, onStatus?: (live: boolean) => void): () => void;
}

export function emptyBars(symbol: string, tfSec: number): BarsData {
  return {
    time: new Float64Array(0),
    open: new Float64Array(0),
    high: new Float64Array(0),
    low: new Float64Array(0),
    close: new Float64Array(0),
    volume: new Float64Array(0),
    tfSec,
    symbol,
    lastRealtime: false,
  };
}

/** İki mum dizisini birleştirir (zamana göre, yinelenenlerde sonraki kazanır). */
export function mergeBars(older: BarsData, newer: BarsData): BarsData {
  const map = new Map<number, number[]>();
  const put = (b: BarsData) => {
    for (let i = 0; i < b.time.length; i++) {
      map.set(b.time[i]!, [b.open[i]!, b.high[i]!, b.low[i]!, b.close[i]!, b.volume[i]!]);
    }
  };
  put(older);
  put(newer);
  const times = [...map.keys()].sort((a, b) => a - b);
  const col = (k: number) => Float64Array.from(times, (t) => map.get(t)![k]!);
  return {
    time: Float64Array.from(times),
    open: col(0),
    high: col(1),
    low: col(2),
    close: col(3),
    volume: col(4),
    tfSec: newer.tfSec,
    symbol: newer.symbol,
    lastRealtime: newer.lastRealtime,
    mintick: newer.mintick ?? older.mintick,
  };
}

/** Son mumu günceller ya da yeni mum ekler (canlı akış). */
export function applyLiveBar(b: BarsData, lb: LiveBar, now = Date.now()): BarsData {
  const n = b.time.length;
  const last = n ? b.time[n - 1]! : -1;
  if (lb.time < last) return b;
  const realtime = !lb.closed && lb.time + b.tfSec * 1000 > now;
  if (lb.time === last) {
    b.open[n - 1] = lb.open;
    b.high[n - 1] = lb.high;
    b.low[n - 1] = lb.low;
    b.close[n - 1] = lb.close;
    b.volume[n - 1] = lb.volume;
    return { ...b, lastRealtime: realtime };
  }
  const grow = (a: Float64Array, v: number) => {
    const out = new Float64Array(n + 1);
    out.set(a);
    out[n] = v;
    return out;
  };
  return {
    ...b,
    time: grow(b.time, lb.time),
    open: grow(b.open, lb.open),
    high: grow(b.high, lb.high),
    low: grow(b.low, lb.low),
    close: grow(b.close, lb.close),
    volume: grow(b.volume, lb.volume),
    lastRealtime: realtime,
  };
}

/** Heikin Ashi mumları. */
export function heikinAshi(b: BarsData): BarsData {
  const N = b.time.length;
  const o = new Float64Array(N);
  const c = new Float64Array(N);
  const h = new Float64Array(N);
  const l = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    c[i] = (b.open[i]! + b.high[i]! + b.low[i]! + b.close[i]!) / 4;
    o[i] = i === 0 ? (b.open[i]! + b.close[i]!) / 2 : (o[i - 1]! + c[i - 1]!) / 2;
    h[i] = Math.max(b.high[i]!, o[i]!, c[i]!);
    l[i] = Math.min(b.low[i]!, o[i]!, c[i]!);
  }
  return { ...b, open: o, high: h, low: l, close: c };
}

export function sliceBars(b: BarsData, from: number): BarsData {
  return {
    ...b,
    time: b.time.slice(from),
    open: b.open.slice(from),
    high: b.high.slice(from),
    low: b.low.slice(from),
    close: b.close.slice(from),
    volume: b.volume.slice(from),
  };
}
