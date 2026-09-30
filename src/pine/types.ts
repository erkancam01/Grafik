/** Yorumlayıcının dış arayüzü: girdi mum verisi ve çıktı çizim verisi (worker ↔ arayüz). */

export interface BarsData {
  /** Mum açılış zamanı (ms, UTC). */
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  /** Zaman dilimi saniye cinsinden (1D = 86400). */
  tfSec: number;
  /** Binance sembolü (ör. BTCUSDT). */
  symbol: string;
  /** Son mum hâlâ oluşuyor mu (canlı). */
  lastRealtime: boolean;
  /** Fiyat adımı (syminfo.mintick). */
  mintick?: number;
}

export interface DataRequest {
  symbol: string;
  tfSec: number;
  heikinAshi: boolean;
}

export function dataKey(r: DataRequest): string {
  return `${r.symbol}|${r.tfSec}|${r.heikinAshi ? "HA" : ""}`;
}

export type InputType = "int" | "float" | "bool" | "string" | "source" | "timeframe" | "color" | "symbol" | "session" | "time" | "price" | "text_area";

export interface InputMeta {
  key: string;
  title: string;
  type: InputType;
  defval: unknown;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: unknown[];
  tooltip?: string;
  group?: string;
  inline?: string;
}

export type PlotStyle =
  | "line"
  | "linebr"
  | "stepline"
  | "stepline_diamond"
  | "steplinebr"
  | "histogram"
  | "columns"
  | "area"
  | "areabr"
  | "circles"
  | "cross";

export interface PlotOut {
  id: string;
  title: string;
  style: PlotStyle;
  linewidth: number;
  values: Float64Array;
  /** Mum başına renk ("#RRGGBBAA"); null = görünmez. */
  colors: (string | null)[];
  offset: number;
  histbase: number;
  display: boolean;
  trackprice: boolean;
}

export type ShapeLocation = "abovebar" | "belowbar" | "top" | "bottom" | "absolute";

export interface ShapeEvent {
  bar: number;
  price: number | null;
  location: ShapeLocation;
  shape: string;
  color: string | null;
  text: string;
  textcolor: string | null;
  size: string;
}

export interface ShapeOut {
  id: string;
  title: string;
  kind: "shape" | "char" | "arrow";
  offset: number;
  events: ShapeEvent[];
}

export interface HlineOut {
  price: number;
  title: string;
  color: string | null;
  style: "solid" | "dashed" | "dotted";
  linewidth: number;
}

export interface AlertOut {
  title: string;
  message: string;
  bars: number[];
}

export interface IndicatorMeta {
  title: string;
  shorttitle: string;
  overlay: boolean;
  precision: number | null;
  format: string | null;
}

export interface PineOutput {
  meta: IndicatorMeta;
  inputs: InputMeta[];
  plots: PlotOut[];
  shapes: ShapeOut[];
  barcolors: (string | null)[] | null;
  bgcolors: (string | null)[] | null;
  hlines: HlineOut[];
  alerts: AlertOut[];
  logs: string[];
  warnings: string[];
  stats: { bars: number; ms: number; ops: number };
}

export interface RunOptions {
  inputs?: Record<string, unknown>;
  /** Ek veri: request.security için (anahtar: dataKey). */
  extra?: Record<string, BarsData>;
  timeLimitMs?: number;
  maxOps?: number;
}

export type RunResult =
  | { ok: true; output: PineOutput }
  | { ok: false; needData: DataRequest[] }
  | { ok: false; error: { message: string; line: number; col: number; kind: string } };
