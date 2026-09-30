/**
 * Yürütme durumu: seri bağlamı (mumlar), çerçeveler (değişken geçmişleri, çağrı yeri durumları), çıktılar.
 *
 * Pine yürütme modeli: betik her mumda baştan çalışır. Değişkenlerin mum başına geçmişi tutulur (`x[1]`).
 * Durumlu yerleşikler (ta.ema…) ve kullanıcı fonksiyonları **çağrı yeri başına** ayrı durum taşır:
 * her çerçeve kendi `st` (yerleşik durumları) ve `kids` (alt fonksiyon çerçeveleri) haritasına sahiptir.
 */
import { PineError } from "./errors";
import type { StrategyEngine } from "./strategy";
import type {
  AlertOut,
  BarsData,
  DataRequest,
  HlineOut,
  IndicatorMeta,
  InputMeta,
  PlotOut,
  ShapeOut,
} from "./types";

export interface SeriesCtx {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  n: number;
  tfSec: number;
  symbol: string;
  lastRealtime: boolean;
  mintick: number;
  heikinAshi: boolean;
  /** Türetilmiş seriler (hl2, ta.tr, ta.vwap…) — bir kez hesaplanır. */
  cache: Map<string, Float64Array>;
}

export function seriesFrom(b: BarsData, heikinAshi = false): SeriesCtx {
  return {
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    n: b.time.length,
    tfSec: b.tfSec,
    symbol: b.symbol,
    lastRealtime: b.lastRealtime,
    mintick: b.mintick ?? inferMintick(b.close),
    heikinAshi,
    cache: new Map(),
  };
}

function inferMintick(close: Float64Array): number {
  const p = close[close.length - 1] ?? 1;
  if (!(p > 0)) return 0.01;
  const digits = Math.max(0, Math.min(8, 5 - Math.floor(Math.log10(p))));
  return Math.pow(10, -digits);
}

export class Frame {
  vals: unknown[];
  hist: unknown[][];
  wbar: number[];
  inited: boolean[];
  st = new Map<number, any>();
  kids = new Map<number, Frame>();

  constructor(nslots: number) {
    this.vals = new Array(nslots).fill(Number.NaN);
    this.hist = Array.from({ length: nslots }, () => []);
    this.wbar = new Array(nslots).fill(-1);
    this.inited = new Array(nslots).fill(false);
  }

  /** Derleme sırasında slot sayısı artmış olabilir (önek fonksiyonları). */
  ensure(nslots: number): void {
    while (this.vals.length < nslots) {
      this.vals.push(Number.NaN);
      this.hist.push([]);
      this.wbar.push(-1);
      this.inited.push(false);
    }
  }
}

export class LimitError extends PineError {
  constructor(msg: string) {
    super(msg, 0, 0, "limit");
  }
}

/** request.security için eksik veri: çalıştırma durur, arayüz veriyi getirip yeniden çalıştırır. */
export class NeedData extends Error {
  constructor(public requests: DataRequest[]) {
    super("need-data");
  }
}

export const DEFAULT_META: IndicatorMeta = {
  title: "İndikatör",
  shorttitle: "İndikatör",
  overlay: false,
  precision: null,
  format: null,
};

export class Runtime {
  S: SeriesCtx;
  readonly main: SeriesCtx;
  bar = 0;
  /** Hata konumu için çalışan deyimin satırı. */
  line = 0;
  gframe!: Frame;
  readonly version: number;

  // girdiler
  readonly inputValues: Record<string, unknown>;
  readonly inputs: InputMeta[] = [];
  readonly inputBySite = new Map<number, InputMeta>();

  // çıktılar
  meta: IndicatorMeta = { ...DEFAULT_META };
  metaSet = false;
  readonly plots = new Map<number, PlotOut>();
  readonly shapes = new Map<number, ShapeOut>();
  barcolors: (string | null)[] | null = null;
  bgcolors: (string | null)[] | null = null;
  readonly hlines = new Map<number, HlineOut>();
  readonly alerts = new Map<number, AlertOut>();
  readonly logs: string[] = [];
  readonly warnings = new Set<string>();
  plotNo = 0;
  /** strategy(…) bildirildiyse emir/işlem motoru. */
  strategy: StrategyEngine | null = null;

  // sınırlar
  ops = 0;
  private readonly deadline: number;
  private readonly maxOps: number;
  readonly started = Date.now();

  // request.security
  readonly extra: Map<string, SeriesCtx>;
  readonly missing: DataRequest[] = [];
  secDepth = 0;
  callDepth = 0;

  constructor(
    main: SeriesCtx,
    version: number,
    opts: { inputs?: Record<string, unknown>; extra?: Map<string, SeriesCtx>; timeLimitMs?: number; maxOps?: number },
  ) {
    this.main = main;
    this.S = main;
    this.version = version;
    this.inputValues = opts.inputs ?? {};
    this.extra = opts.extra ?? new Map();
    this.deadline = this.started + (opts.timeLimitMs ?? 4000);
    this.maxOps = opts.maxOps ?? 60_000_000;
  }

  get n(): number {
    return this.S.n;
  }

  /** Ana grafik bağlamında mı (request.security ifadesi değil)? */
  get isMain(): boolean {
    return this.secDepth === 0;
  }

  st<T>(f: Frame, site: number, init: () => T): T {
    let s = f.st.get(site) as T | undefined;
    if (s === undefined) {
      s = init();
      f.st.set(site, s);
    }
    return s;
  }

  warn(msg: string): void {
    this.warnings.add(msg);
  }

  tick(k = 1): void {
    this.ops += k;
    if ((this.ops & 4095) < k) {
      if (this.ops > this.maxOps) throw new LimitError("İşlem sınırı aşıldı (betik çok ağır ya da sonsuz döngü)");
      if (Date.now() > this.deadline) throw new LimitError("Süre sınırı aşıldı (betik çok yavaş ya da sonsuz döngü)");
    }
  }

  /** Değişkene yazma: güncel değer + bu mumun geçmişi. */
  assign(f: Frame, s: number, v: unknown): void {
    f.vals[s] = v;
    f.wbar[s] = this.bar;
    f.hist[s]![this.bar] = v;
  }

  /** Bu mumdaki değer: bu mumda yazılmadıysa na (var değişkenleri hariç). */
  read(f: Frame, s: number, isVar: boolean): unknown {
    if (isVar || f.wbar[s] === this.bar) return f.vals[s];
    return Number.NaN;
  }

  /** `x[k]` geçmiş okuması. */
  readHist(f: Frame, s: number, k: number, isVar: boolean): unknown {
    if (k === 0) return this.read(f, s, isVar);
    const idx = this.bar - k;
    if (idx < 0 || !(k > 0)) return Number.NaN;
    const h = f.hist[s]!;
    const v = h[idx];
    if (v !== undefined) return v;
    if (isVar) {
      for (let j = idx - 1; j >= 0; j--) {
        const w = h[j];
        if (w !== undefined) return w;
      }
    }
    return Number.NaN;
  }
}
