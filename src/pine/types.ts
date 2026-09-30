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
  /** Betik alt panelde olsa da fiyat grafiğine çizilir (strateji emirleri). */
  overlay?: boolean;
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
  /** strategy() betiklerinde: emir/işlem sonuçları (Strateji Test Aracı). */
  strategy: StrategyOut | null;
}

// ------------------------------------------------------------------ strateji

export type QtyType = "fixed" | "percent_of_equity" | "cash";
export type CommissionType = "percent" | "cash_per_contract" | "cash_per_order";

export interface StrategyProps {
  initialCapital: number;
  qtyType: QtyType;
  qtyValue: number;
  pyramiding: number;
  commissionType: CommissionType;
  commissionValue: number;
  /** Tik cinsinden (piyasa ve stop emirleri bu kadar kötü dolar). */
  slippage: number;
  processOrdersOnClose: boolean;
  calcOnEveryTick: boolean;
  /** Limit emri ancak fiyat seviyeyi bu kadar tik geçerse dolar. */
  fillLimitsTicks: number;
}

export interface StrategyTradeOut {
  /** 1'den başlayan işlem numarası. */
  n: number;
  dir: 1 | -1;
  qty: number;
  entryId: string;
  entryComment: string;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  /** Açık işlemde boş. */
  exitId: string;
  exitComment: string;
  exitBar: number;
  exitTime: number;
  /** Açık işlemde son kapanış fiyatı. */
  exitPrice: number;
  /** Komisyon düşülmüş kâr/zarar (USDT). */
  profit: number;
  profitPct: number;
  commission: number;
  runup: number;
  drawdown: number;
  cumProfit: number;
  open: boolean;
}

export interface StrategySide {
  netProfit: number;
  netProfitPct: number;
  grossProfit: number;
  grossLoss: number;
  commission: number;
  trades: number;
  wins: number;
  losses: number;
  evens: number;
  winRate: number;
  avgTrade: number;
  avgTradePct: number;
  avgWin: number;
  avgWinPct: number;
  avgLoss: number;
  avgLossPct: number;
  ratioWinLoss: number;
  largestWin: number;
  largestWinPct: number;
  largestLoss: number;
  largestLossPct: number;
  avgBars: number;
  avgBarsWin: number;
  avgBarsLoss: number;
  profitFactor: number;
  maxConsecWins: number;
  maxConsecLosses: number;
}

export interface StrategyOut {
  props: StrategyProps;
  trades: StrategyTradeOut[];
  openTrades: StrategyTradeOut[];
  /** Mum kapanışlarında özsermaye (başlangıç + gerçekleşen + açık kâr/zarar). */
  equity: Float64Array;
  all: StrategySide;
  long: StrategySide;
  short: StrategySide;
  openProfit: number;
  finalEquity: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxRunup: number;
  maxRunupPct: number;
  buyHoldPct: number;
  maxContracts: number;
  /** Emir verilmiş ama dolmamış emir sayısı (son mumda bekleyenler). */
  pendingOrders: number;
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
