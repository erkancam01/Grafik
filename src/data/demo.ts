/**
 * Çevrimdışı demo kaynağı (?demo): sembol ve zaman dilimine göre tohumlu, tutarlı sentetik mumlar ve canlı akış.
 * Binance'e erişilemeyen yerlerde arayüzü denemek ve uçtan uca testler için.
 */
import type { BarsData } from "../pine/types";
import { intervalById } from "./intervals";
import type { DataSource, LiveBar, SymbolInfo } from "./source";

/** Yalnız altın (uygulama yalnız altın gösterir). */
const BASE: Record<string, number> = {
  XAUUSDT: 4_190,
  PAXGUSDT: 4_165,
};

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Deterministik gürültü: aynı (sembol, dakika) için hep aynı değer. */
function noise(seed: number, i: number): number {
  let t = (seed ^ Math.imul(i, 0x9e3779b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
}

const MIN = 60_000;

/** 1 dakikalık log-fiyat: yavaş dalgalar + gürültü; her zaman dilimi bundan toplanır (tutarlı). */
function logPriceAt(seed: number, minute: number): number {
  const slow = Math.sin(minute / 5000 + (seed % 7)) * 0.08 + Math.sin(minute / 23000 + (seed % 3)) * 0.15;
  const mid = Math.sin(minute / 700 + (seed % 11)) * 0.02;
  return slow + mid + noise(seed, minute) * 0.002;
}

export class DemoSource implements DataSource {
  readonly name = "demo";
  readonly label = "Demo verisi (çevrimdışı)";
  readonly available: readonly string[] = Object.keys(BASE);

  async symbols(): Promise<SymbolInfo[]> {
    return Object.entries(BASE).map(([symbol, price], i) => ({
      symbol,
      price,
      changePct: ((hash(symbol) % 800) - 400) / 100,
      quoteVolume: 1e9 / (i + 1),
    }));
  }

  private bar(symbol: string, tfSec: number, t0: number): [number, number, number, number, number] {
    const seed = hash(symbol);
    const base = BASE[symbol] ?? 50 + (seed % 1000);
    const m0 = Math.floor(t0 / MIN);
    const steps = Math.max(1, Math.min(tfSec / 60, 240));
    const stride = tfSec / 60 / steps;
    let o = 0;
    let h = -Infinity;
    let l = Infinity;
    let c = 0;
    for (let k = 0; k <= steps; k++) {
      const p = base * Math.exp(logPriceAt(seed, m0 + Math.round(k * stride)));
      if (k === 0) o = p;
      h = Math.max(h, p);
      l = Math.min(l, p);
      c = p;
    }
    const vol = 1000 * (1 + Math.abs(noise(seed + 1, m0)) * 4);
    return [o, h * 1.0005, l * 0.9995, c, vol];
  }

  async klines(symbol: string, interval: string, limit: number, endTime?: number): Promise<BarsData> {
    const iv = intervalById(interval);
    if (!iv) throw new Error(`Desteklenmeyen zaman dilimi: ${interval}`);
    const step = iv.sec * 1000;
    const nowOpen = Math.floor(Date.now() / step) * step;
    const lastOpen = endTime === undefined ? nowOpen : Math.min(nowOpen, Math.floor(endTime / step) * step);
    const N = Math.max(1, Math.min(1500, limit));
    const b: BarsData = {
      time: new Float64Array(N),
      open: new Float64Array(N),
      high: new Float64Array(N),
      low: new Float64Array(N),
      close: new Float64Array(N),
      volume: new Float64Array(N),
      tfSec: iv.sec,
      symbol,
      lastRealtime: lastOpen === nowOpen,
    };
    for (let i = 0; i < N; i++) {
      const t = lastOpen - (N - 1 - i) * step;
      const [o, h, l, c, v] = this.bar(symbol, iv.sec, t);
      b.time[i] = t;
      b.open[i] = o;
      b.high[i] = h;
      b.low[i] = l;
      b.close[i] = c;
      b.volume[i] = v;
    }
    return b;
  }

  subscribe(symbol: string, interval: string, onBar: (b: LiveBar) => void, onStatus?: (live: boolean) => void): () => void {
    const iv = intervalById(interval)!;
    onStatus?.(true);
    const tick = () => {
      const step = iv.sec * 1000;
      const t = Math.floor(Date.now() / step) * step;
      const [o, h, l, c, v] = this.bar(symbol, iv.sec, t);
      const jitter = 1 + noise(hash(symbol), Date.now() / 1000) * 0.0008;
      onBar({ time: t, open: o, high: Math.max(h, c * jitter), low: Math.min(l, c * jitter), close: c * jitter, volume: v, closed: false });
    };
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }
}
