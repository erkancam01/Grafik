/**
 * ta.* teknik analiz fonksiyonları (Pine başvuru uygulamalarıyla aynı tanımlar).
 * Durumlu fonksiyonlar çağrı yeri başına kendi kaynak geçmişini tutar (Pine'daki gibi: koşullu çağrılan
 * bir ta.* fonksiyonu yalnız çağrıldığı mumlarda güncellenir).
 * Karmaşık olanların bir kısmı (supertrend, dmi, sar…) Pine dilinde `prelude.ts` içinde yazılıdır.
 */
import type { Frame, Runtime, SeriesCtx } from "../engine";
import { PineTuple, isNa } from "../values";
import { def, len, n, type BuiltinDef } from "./registry";

const NaN_ = Number.NaN;

// ---------------------------------------------------------------- durumlu ilkel adımlar
export interface Hist {
  h: number[];
}
export interface EmaState extends Hist {
  prev: number;
}

export function hist(): Hist {
  return { h: [] };
}
export function emaState(): EmaState {
  return { h: [], prev: NaN_ };
}

function lastSum(h: number[], L: number): number {
  const m = h.length;
  if (!(L >= 1) || m < L) return NaN_;
  let s = 0;
  for (let i = m - L; i < m; i++) s += h[i]!;
  return s;
}

export function smaStep(s: Hist, src: number, L: number): number {
  s.h.push(src);
  return lastSum(s.h, L) / L;
}

/** Pine ema/rma: ilk değer SMA ile tohumlanır; önceki değer na ise yeniden tohumlanır. */
export function expStep(s: EmaState, src: number, L: number, alpha: number): number {
  s.h.push(src);
  const v = Number.isNaN(s.prev) ? lastSum(s.h, L) / L : alpha * src + (1 - alpha) * s.prev;
  s.prev = v;
  return v;
}

export function emaStep(s: EmaState, src: number, L: number): number {
  return expStep(s, src, L, 2 / (L + 1));
}
export function rmaStep(s: EmaState, src: number, L: number): number {
  return expStep(s, src, L, 1 / L);
}

export function wmaStep(s: Hist, src: number, L: number): number {
  s.h.push(src);
  const m = s.h.length;
  if (!(L >= 1) || m < L) return NaN_;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < L; i++) {
    const w = L - i;
    sum += s.h[m - 1 - i]! * w;
    norm += w;
  }
  return sum / norm;
}

/** Pencere (son L değer) — eksikse null. */
function win(s: Hist, src: number, L: number): number[] | null {
  s.h.push(src);
  const m = s.h.length;
  if (!(L >= 1) || m < L) return null;
  return s.h.slice(m - L);
}

function mean(w: number[]): number {
  let s = 0;
  for (const x of w) s += x;
  return s / w.length;
}

function stdevOf(w: number[], biased: boolean): number {
  const mu = mean(w);
  if (Number.isNaN(mu)) return NaN_;
  let ss = 0;
  for (const x of w) ss += (x - mu) * (x - mu);
  return Math.sqrt(ss / (biased ? w.length : w.length - 1));
}

/** Değer geçmişi: `src[k]` (bu çağrı yerinin önceki çağrıları). */
function ago(s: Hist, k: number): number {
  const i = s.h.length - 1 - k;
  return i >= 0 ? s.h[i]! : NaN_;
}

export function trAt(S: SeriesCtx, i: number, handleNa: boolean): number {
  const pc = i > 0 ? S.close[i - 1]! : NaN_;
  const h = S.high[i]!;
  const l = S.low[i]!;
  if (Number.isNaN(pc)) return handleNa ? h - l : NaN_;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

// ---------------------------------------------------------------- türetilmiş seriler (tüm mumlar)
function cached(S: SeriesCtx, key: string, build: () => Float64Array): Float64Array {
  let a = S.cache.get(key);
  if (!a) {
    a = build();
    S.cache.set(key, a);
  }
  return a;
}

export function derived(S: SeriesCtx, name: string): Float64Array | null {
  const N = S.n;
  switch (name) {
    case "hl2":
      return cached(S, name, () => Float64Array.from({ length: N }, (_, i) => (S.high[i]! + S.low[i]!) / 2));
    case "hlc3":
      return cached(S, name, () =>
        Float64Array.from({ length: N }, (_, i) => (S.high[i]! + S.low[i]! + S.close[i]!) / 3),
      );
    case "ohlc4":
      return cached(S, name, () =>
        Float64Array.from({ length: N }, (_, i) => (S.open[i]! + S.high[i]! + S.low[i]! + S.close[i]!) / 4),
      );
    case "hlcc4":
      return cached(S, name, () =>
        Float64Array.from({ length: N }, (_, i) => (S.high[i]! + S.low[i]! + 2 * S.close[i]!) / 4),
      );
    case "bar_index":
      return cached(S, name, () => Float64Array.from({ length: N }, (_, i) => i));
    case "time_close":
      return cached(S, name, () => Float64Array.from({ length: N }, (_, i) => S.time[i]! + S.tfSec * 1000));
    case "ta.tr":
      return cached(S, name, () => Float64Array.from({ length: N }, (_, i) => trAt(S, i, false)));
    case "ta.vwap":
      return cached(S, name, () => {
        const out = new Float64Array(N);
        let day = -1;
        let pv = 0;
        let vv = 0;
        for (let i = 0; i < N; i++) {
          const d = Math.floor(S.time[i]! / 86_400_000);
          if (d !== day) {
            day = d;
            pv = 0;
            vv = 0;
          }
          const src = (S.high[i]! + S.low[i]! + S.close[i]!) / 3;
          pv += src * S.volume[i]!;
          vv += S.volume[i]!;
          out[i] = vv > 0 ? pv / vv : NaN_;
        }
        return out;
      });
    case "ta.obv":
      return cached(S, name, () => {
        const out = new Float64Array(N);
        let c = 0;
        for (let i = 0; i < N; i++) {
          const ch = i > 0 ? S.close[i]! - S.close[i - 1]! : NaN_;
          if (!Number.isNaN(ch)) c += Math.sign(ch) * S.volume[i]!;
          out[i] = c;
        }
        return out;
      });
    case "ta.accdist":
      return cached(S, name, () => {
        const out = new Float64Array(N);
        let c = 0;
        for (let i = 0; i < N; i++) {
          const h = S.high[i]!;
          const l = S.low[i]!;
          const k = h === l ? 0 : ((S.close[i]! - l - (h - S.close[i]!)) / (h - l)) * S.volume[i]!;
          c += k;
          out[i] = c;
        }
        return out;
      });
    default:
      return null;
  }
}

// ---------------------------------------------------------------- tanımlar
type St<T> = (rt: Runtime, f: Frame, site: number) => T;
const stOf =
  <T>(init: () => T): St<T> =>
  (rt, f, site) =>
    rt.st(f, site, init);

const H = stOf(hist);
const E = stOf(emaState);

function highestLowest(sign: 1 | -1, bars: boolean): BuiltinDef {
  return def(["source", "length"], (rt, f, site, a) => {
    let src: number;
    let L: number;
    if (a.length === 1 || a[1] === undefined) {
      src = sign === 1 ? rt.S.high[rt.bar]! : rt.S.low[rt.bar]!;
      L = len(a[0]);
    } else {
      src = n(a[0]);
      L = len(a[1]);
    }
    const w = win(H(rt, f, site), src, L);
    if (!w) return NaN_;
    let best = NaN_;
    let bi = -1;
    for (let i = 0; i < w.length; i++) {
      const x = w[i]!;
      if (Number.isNaN(x)) continue;
      if (Number.isNaN(best) || (sign === 1 ? x >= best : x <= best)) {
        best = x;
        bi = i;
      }
    }
    if (bars) return bi < 0 ? NaN_ : -(w.length - 1 - bi);
    return best;
  });
}

function cross(kind: "over" | "under" | "any"): BuiltinDef {
  return def(["source1", "source2"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ pa: NaN_, pb: NaN_ }));
    const x = n(a[0]);
    const y = n(a[1]);
    const over = x > y && s.pa <= s.pb;
    const under = x < y && s.pa >= s.pb;
    s.pa = x;
    s.pb = y;
    return kind === "over" ? over : kind === "under" ? under : over || under;
  });
}

function changeLike(kind: "change" | "mom" | "roc"): BuiltinDef {
  return def(["source", "length"], (rt, f, site, a) => {
    const L = a[1] === undefined ? 1 : Math.floor(n(a[1]));
    if (typeof a[0] === "boolean") {
      const s = rt.st(f, site, () => ({ b: [] as boolean[] }));
      s.b.push(a[0]);
      const i = s.b.length - 1 - L;
      return i >= 0 ? s.b[i] !== a[0] : false;
    }
    const s = H(rt, f, site);
    const src = n(a[0]);
    s.h.push(src);
    const prev = ago(s, L);
    if (kind === "roc") return (100 * (src - prev)) / prev;
    return src - prev;
  });
}

function risingFalling(up: boolean): BuiltinDef {
  return def(["source", "length"], (rt, f, site, a) => {
    const s = H(rt, f, site);
    s.h.push(n(a[0]));
    const L = len(a[1]);
    if (!(L >= 1) || s.h.length <= L) return false;
    for (let i = 0; i < L; i++) {
      const cur = ago(s, i);
      const prv = ago(s, i + 1);
      if (up ? !(cur > prv) : !(cur < prv)) return false;
    }
    return true;
  });
}

function pivot(high: boolean): BuiltinDef {
  return def(["source", "leftbars", "rightbars"], (rt, f, site, a) => {
    let src: number;
    let left: number;
    let right: number;
    if (a.length === 2 || a[2] === undefined) {
      src = high ? rt.S.high[rt.bar]! : rt.S.low[rt.bar]!;
      left = Math.floor(n(a[0]));
      right = Math.floor(n(a[1]));
    } else {
      src = n(a[0]);
      left = Math.floor(n(a[1]));
      right = Math.floor(n(a[2]));
    }
    const s = H(rt, f, site);
    s.h.push(src);
    const m = s.h.length;
    if (!(left >= 0 && right >= 0) || m < left + right + 1) return NaN_;
    const c = s.h[m - 1 - right]!;
    if (Number.isNaN(c)) return NaN_;
    for (let i = 1; i <= left; i++) {
      const x = s.h[m - 1 - right - i]!;
      if (high ? !(c > x) : !(c < x)) return NaN_;
    }
    for (let i = 1; i <= right; i++) {
      const x = s.h[m - 1 - right + i]!;
      if (high ? !(c > x) : !(c < x)) return NaN_;
    }
    return c;
  });
}

export const TA: Record<string, BuiltinDef> = {
  "ta.sma": def(["source", "length"], (rt, f, site, a) => smaStep(H(rt, f, site), n(a[0]), len(a[1]))),
  "ta.ema": def(["source", "length"], (rt, f, site, a) => emaStep(E(rt, f, site), n(a[0]), len(a[1]))),
  "ta.rma": def(["source", "length"], (rt, f, site, a) => rmaStep(E(rt, f, site), n(a[0]), len(a[1]))),
  "ta.wma": def(["source", "length"], (rt, f, site, a) => wmaStep(H(rt, f, site), n(a[0]), len(a[1]))),
  "ta.swma": def(["source"], (rt, f, site, a) => {
    const s = H(rt, f, site);
    s.h.push(n(a[0]));
    if (s.h.length < 4) return NaN_;
    return (ago(s, 3) + 2 * ago(s, 2) + 2 * ago(s, 1) + ago(s, 0)) / 6;
  }),
  "ta.alma": def(["series", "length", "offset", "sigma", "floor"], (rt, f, site, a) => {
    const L = len(a[1]);
    const w = win(H(rt, f, site), n(a[0]), L);
    if (!w) return NaN_;
    const off = n(a[2] ?? 0.85);
    const sigma = n(a[3] ?? 6);
    const m = a[4] === true ? Math.floor(off * (L - 1)) : off * (L - 1);
    const sd = L / sigma;
    let norm = 0;
    let sum = 0;
    for (let i = 0; i < L; i++) {
      const wt = Math.exp(-((i - m) * (i - m)) / (2 * sd * sd));
      norm += wt;
      sum += w[i]! * wt; // w[0] en eski
    }
    return sum / norm;
  }),
  "ta.tr": def(["handle_na"], (rt, _f, _site, a) => trAt(rt.S, rt.bar, a[0] === true)),
  "ta.atr": def(["length"], (rt, f, site, a) => rmaStep(E(rt, f, site), trAt(rt.S, rt.bar, true), len(a[0]))),
  "ta.rsi": def(["source", "length"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ src: hist(), up: emaState(), dn: emaState() }));
    const x = n(a[0]);
    const L = len(a[1]);
    s.src.h.push(x);
    const p = ago(s.src, 1);
    const u = rmaStep(s.up, Number.isNaN(p) ? NaN_ : Math.max(x - p, 0), L);
    const d = rmaStep(s.dn, Number.isNaN(p) ? NaN_ : Math.max(p - x, 0), L);
    if (Number.isNaN(u) || Number.isNaN(d)) return NaN_;
    return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  }),
  "ta.macd": def(["source", "fastlen", "slowlen", "siglen"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ f: emaState(), s: emaState(), g: emaState() }));
    const x = n(a[0]);
    const m = emaStep(s.f, x, len(a[1])) - emaStep(s.s, x, len(a[2]));
    const sig = emaStep(s.g, m, len(a[3]));
    return new PineTuple([m, sig, m - sig]);
  }),
  "ta.stoch": def(["source", "high", "low", "length"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ h: hist(), l: hist() }));
    const L = len(a[3]);
    const wh = win(s.h, n(a[1]), L);
    const wl = win(s.l, n(a[2]), L);
    if (!wh || !wl) return NaN_;
    const hh = Math.max(...wh.filter((x) => !Number.isNaN(x)));
    const ll = Math.min(...wl.filter((x) => !Number.isNaN(x)));
    const rng = hh - ll;
    return rng === 0 ? NaN_ : (100 * (n(a[0]) - ll)) / rng;
  }),
  "ta.cci": def(["source", "length"], (rt, f, site, a) => {
    const x = n(a[0]);
    const w = win(H(rt, f, site), x, len(a[1]));
    if (!w) return NaN_;
    const mu = mean(w);
    let dev = 0;
    for (const v of w) dev += Math.abs(v - mu);
    dev /= w.length;
    return dev === 0 ? NaN_ : (x - mu) / (0.015 * dev);
  }),
  "ta.bb": def(["series", "length", "mult"], (rt, f, site, a) => {
    const w = win(H(rt, f, site), n(a[0]), len(a[1]));
    if (!w) return new PineTuple([NaN_, NaN_, NaN_]);
    const basis = mean(w);
    const dev = n(a[2]) * stdevOf(w, true);
    return new PineTuple([basis, basis + dev, basis - dev]);
  }),
  "ta.highest": highestLowest(1, false),
  "ta.lowest": highestLowest(-1, false),
  "ta.highestbars": highestLowest(1, true),
  "ta.lowestbars": highestLowest(-1, true),
  "ta.range": def(["source", "length"], (rt, f, site, a) => {
    const w = win(H(rt, f, site), n(a[0]), len(a[1]));
    if (!w) return NaN_;
    const v = w.filter((x) => !Number.isNaN(x));
    return v.length ? Math.max(...v) - Math.min(...v) : NaN_;
  }),
  "ta.crossover": cross("over"),
  "ta.crossunder": cross("under"),
  "ta.cross": cross("any"),
  "ta.change": changeLike("change"),
  "ta.mom": changeLike("mom"),
  "ta.roc": changeLike("roc"),
  "ta.stdev": def(["source", "length", "biased"], (rt, f, site, a) => {
    const w = win(H(rt, f, site), n(a[0]), len(a[1]));
    return w ? stdevOf(w, a[2] !== false) : NaN_;
  }),
  "ta.variance": def(["source", "length", "biased"], (rt, f, site, a) => {
    const w = win(H(rt, f, site), n(a[0]), len(a[1]));
    if (!w) return NaN_;
    const sd = stdevOf(w, a[2] !== false);
    return sd * sd;
  }),
  "ta.dev": def(["source", "length"], (rt, f, site, a) => {
    const w = win(H(rt, f, site), n(a[0]), len(a[1]));
    if (!w) return NaN_;
    const mu = mean(w);
    let d = 0;
    for (const v of w) d += Math.abs(v - mu);
    return d / w.length;
  }),
  "ta.median": def(["source", "length"], (rt, f, site, a) => {
    const w = win(H(rt, f, site), n(a[0]), len(a[1]));
    if (!w || w.some((x) => Number.isNaN(x))) return NaN_;
    const s = [...w].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  }),
  "ta.percentrank": def(["source", "length"], (rt, f, site, a) => {
    const s = H(rt, f, site);
    const x = n(a[0]);
    s.h.push(x);
    const L = len(a[1]);
    if (!(L >= 1) || s.h.length < L + 1) return NaN_;
    let c = 0;
    for (let i = 1; i <= L; i++) if (ago(s, i) <= x) c++;
    return (100 * c) / L;
  }),
  "ta.linreg": def(["source", "length", "offset"], (rt, f, site, a) => {
    const L = len(a[1]);
    const w = win(H(rt, f, site), n(a[0]), L);
    if (!w) return NaN_;
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < L; i++) {
      sx += i;
      sy += w[i]!;
      sxy += i * w[i]!;
      sxx += i * i;
    }
    const slope = (L * sxy - sx * sy) / (L * sxx - sx * sx);
    const icpt = (sy - slope * sx) / L;
    return icpt + slope * (L - 1 - Math.floor(n(a[2] ?? 0)));
  }),
  "ta.correlation": def(["source1", "source2", "length"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ x: hist(), y: hist() }));
    const L = len(a[2]);
    const wx = win(s.x, n(a[0]), L);
    const wy = win(s.y, n(a[1]), L);
    if (!wx || !wy) return NaN_;
    const mx = mean(wx);
    const my = mean(wy);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < L; i++) {
      const dx = wx[i]! - mx;
      const dy = wy[i]! - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    return sxy / Math.sqrt(sxx * syy);
  }),
  "ta.cum": def(["source"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ c: 0 }));
    const x = n(a[0]);
    if (!Number.isNaN(x)) s.c += x;
    return s.c;
  }),
  "ta.vwap": def(["source", "anchor", "stdev_mult"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ day: -1, pv: 0, v: 0 }));
    const anchor = a[1];
    const t = rt.S.time[rt.bar]!;
    const d = Math.floor(t / 86_400_000);
    const reset = anchor === undefined ? d !== s.day : anchor === true;
    if (reset) {
      s.pv = 0;
      s.v = 0;
    }
    s.day = d;
    const vol = rt.S.volume[rt.bar]!;
    s.pv += n(a[0]) * vol;
    s.v += vol;
    return s.v > 0 ? s.pv / s.v : NaN_;
  }),
  "ta.valuewhen": def(["condition", "source", "occurrence"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ vals: [] as unknown[] }));
    if (a[0] === true || (typeof a[0] === "number" && a[0] !== 0 && !Number.isNaN(a[0]))) s.vals.push(a[1]);
    const k = Math.floor(n(a[2] ?? 0));
    const i = s.vals.length - 1 - k;
    return i >= 0 ? s.vals[i] : NaN_;
  }),
  "ta.barssince": def(["condition"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ last: -1, count: 0 }));
    s.count++;
    if (a[0] === true || (typeof a[0] === "number" && a[0] !== 0 && !Number.isNaN(a[0]))) s.last = s.count;
    return s.last < 0 ? NaN_ : s.count - s.last;
  }),
  "ta.pivothigh": pivot(true),
  "ta.pivotlow": pivot(false),
  "ta.rising": risingFalling(true),
  "ta.falling": risingFalling(false),
  "math.sum": def(["source", "length"], (rt, f, site, a) => {
    const s = H(rt, f, site);
    s.h.push(n(a[0]));
    return lastSum(s.h, len(a[1]));
  }),
};

/** v4'te önek olmadan kullanılan adlar. */
export const TA_V4_ALIASES = [
  "sma", "ema", "rma", "wma", "swma", "alma", "vwma", "hma", "atr", "rsi", "macd", "stoch", "cci", "mfi", "bb",
  "bbw", "kc", "kcw", "dmi", "supertrend", "sar", "highest", "lowest", "highestbars", "lowestbars", "crossover",
  "crossunder", "cross", "change", "mom", "roc", "stdev", "variance", "dev", "median", "percentrank", "linreg",
  "correlation", "cum", "valuewhen", "barssince", "pivothigh", "pivotlow", "rising", "falling", "wpr", "tsi",
  "cmo", "range",
];

export function isTrue(v: unknown): boolean {
  return v === true || (typeof v === "number" && v !== 0 && !isNa(v));
}
