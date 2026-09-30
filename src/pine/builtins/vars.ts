/** Yerleşik değişkenler (open, close, bar_index, barstate.*, syminfo.*…) ve sabitler (color.*, shape.*…). */
import type { Runtime, SeriesCtx } from "../engine";
import { COLORS } from "../values";
import { secToTf } from "./core";
import { TIME_PARTS } from "./core";
import { derived } from "./ta";

/** Tüm mumlar için dizi olarak okunabilen seriler (`close[3]` hızlı yol). */
export function seriesArray(S: SeriesCtx, name: string): Float64Array | null {
  switch (name) {
    case "open":
      return S.open;
    case "high":
      return S.high;
    case "low":
      return S.low;
    case "close":
      return S.close;
    case "volume":
      return S.volume;
    case "time":
      return S.time;
    case "tr":
      return derived(S, "ta.tr");
    case "vwap":
      return derived(S, "ta.vwap");
    case "obv":
      return derived(S, "ta.obv");
    case "accdist":
      return derived(S, "ta.accdist");
    case "n":
      return derived(S, "bar_index");
  }
  if (name in TIME_PARTS) {
    const key = `tp.${name}`;
    let a = S.cache.get(key);
    if (!a) {
      const fn = TIME_PARTS[name]!;
      a = Float64Array.from(S.time, (t) => fn(new Date(t)));
      S.cache.set(key, a);
    }
    return a;
  }
  return derived(S, name);
}

export const SERIES_NAMES = new Set([
  "open", "high", "low", "close", "volume", "time", "time_close", "hl2", "hlc3", "ohlc4", "hlcc4", "bar_index",
  "ta.tr", "ta.vwap", "ta.obv", "ta.accdist", "tr", "vwap", "obv", "accdist", "n",
  "year", "month", "weekofyear", "dayofmonth", "dayofweek", "hour", "minute", "second",
]);

const tickerid = (rt: Runtime) => `${rt.S.heikinAshi ? "HA:" : ""}BINANCE:${rt.S.symbol}.P`;

/** Anlık (geçmişsiz) yerleşik değişkenler. */
export const VARS: Record<string, (rt: Runtime) => unknown> = {
  last_bar_index: (rt) => rt.S.n - 1,
  last_bar_time: (rt) => rt.S.time[rt.S.n - 1],
  timenow: () => Date.now(),
  "barstate.isfirst": (rt) => rt.bar === 0,
  "barstate.islast": (rt) => rt.bar === rt.S.n - 1,
  "barstate.isrealtime": (rt) => rt.bar === rt.S.n - 1 && rt.S.lastRealtime,
  "barstate.ishistory": (rt) => !(rt.bar === rt.S.n - 1 && rt.S.lastRealtime),
  "barstate.isnew": () => true,
  "barstate.isconfirmed": (rt) => !(rt.bar === rt.S.n - 1 && rt.S.lastRealtime),
  "barstate.islastconfirmedhistory": (rt) => rt.bar === rt.S.n - (rt.S.lastRealtime ? 2 : 1),
  "syminfo.tickerid": tickerid,
  tickerid,
  "syminfo.ticker": (rt) => `${rt.S.symbol}.P`,
  "syminfo.root": (rt) => rt.S.symbol.replace(/USDT$/, ""),
  "syminfo.prefix": () => "BINANCE",
  "syminfo.mintick": (rt) => rt.S.mintick,
  "syminfo.pointvalue": () => 1,
  "syminfo.currency": () => "USDT",
  "syminfo.basecurrency": (rt) => rt.S.symbol.replace(/USDT$/, ""),
  "syminfo.description": (rt) => `${rt.S.symbol} Perpetual`,
  "syminfo.type": () => "crypto",
  "syminfo.timezone": () => "Etc/UTC",
  "syminfo.session": () => "24x7",
  "syminfo.volumetype": () => "base",
  "timeframe.period": (rt) => secToTf(rt.main.tfSec),
  period: (rt) => secToTf(rt.main.tfSec),
  "timeframe.main_period": (rt) => secToTf(rt.main.tfSec),
  "timeframe.multiplier": (rt) => {
    const s = rt.main.tfSec;
    if (s % (7 * 86400) === 0) return s / (7 * 86400);
    if (s % 86400 === 0) return s / 86400;
    return s % 60 === 0 ? s / 60 : s;
  },
  interval: (rt) => (rt.main.tfSec % 86400 === 0 ? rt.main.tfSec / 86400 : rt.main.tfSec / 60),
  "timeframe.isintraday": (rt) => rt.main.tfSec < 86400,
  isintraday: (rt) => rt.main.tfSec < 86400,
  "timeframe.isminutes": (rt) => rt.main.tfSec < 86400 && rt.main.tfSec % 60 === 0,
  "timeframe.isseconds": (rt) => rt.main.tfSec < 60,
  "timeframe.isdaily": (rt) => rt.main.tfSec >= 86400 && rt.main.tfSec < 7 * 86400,
  isdaily: (rt) => rt.main.tfSec >= 86400 && rt.main.tfSec < 7 * 86400,
  "timeframe.isweekly": (rt) => rt.main.tfSec >= 7 * 86400 && rt.main.tfSec < 28 * 86400,
  isweekly: (rt) => rt.main.tfSec >= 7 * 86400 && rt.main.tfSec < 28 * 86400,
  "timeframe.ismonthly": (rt) => rt.main.tfSec >= 28 * 86400,
  "timeframe.isdwm": (rt) => rt.main.tfSec >= 86400,
  "chart.is_standard": (rt) => !rt.S.heikinAshi,
  "chart.is_heikinashi": (rt) => rt.S.heikinAshi,
};

function consts(prefix: string, names: string[], value: (x: string) => unknown = (x) => x): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const x of names) o[`${prefix}.${x}`] = value(x);
  return o;
}

export const CONSTS: Record<string, unknown> = {
  ...Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [`color.${k}`, v])),
  ...consts("plot", [
    "style_line", "style_linebr", "style_stepline", "style_stepline_diamond", "style_steplinebr", "style_histogram",
    "style_columns", "style_area", "style_areabr", "style_circles", "style_cross",
  ], (x) => x.replace("style_", "")),
  ...consts("shape", [
    "xcross", "cross", "circle", "triangleup", "triangledown", "flag", "arrowup", "arrowdown", "labelup",
    "labeldown", "square", "diamond",
  ]),
  ...consts("location", ["abovebar", "belowbar", "top", "bottom", "absolute"]),
  ...consts("size", ["auto", "tiny", "small", "normal", "large", "huge"]),
  ...consts("hline", ["style_solid", "style_dotted", "style_dashed"], (x) => x.replace("style_", "")),
  ...consts("display", ["all", "none", "data_window", "pane", "price_scale", "status_line", "pine_screener"]),
  ...consts("format", ["inherit", "price", "percent", "volume", "mintick"]),
  "barmerge.gaps_on": "gaps_on",
  "barmerge.gaps_off": "gaps_off",
  "barmerge.lookahead_on": "lookahead_on",
  "barmerge.lookahead_off": "lookahead_off",
  "order.ascending": "ascending",
  "order.descending": "descending",
  "math.pi": Math.PI,
  "math.e": Math.E,
  "math.phi": 1.618033988749895,
  "math.rphi": 0.618033988749895,
  "dayofweek.sunday": 1,
  "dayofweek.monday": 2,
  "dayofweek.tuesday": 3,
  "dayofweek.wednesday": 4,
  "dayofweek.thursday": 5,
  "dayofweek.friday": 6,
  "dayofweek.saturday": 7,
  "currency.USD": "USD",
  "currency.USDT": "USDT",
  "session.regular": "regular",
  "session.extended": "extended",
  "adjustment.none": "none",
  "adjustment.splits": "splits",
  "adjustment.dividends": "dividends",
  "alert.freq_all": "all",
  "alert.freq_once_per_bar": "once_per_bar",
  "alert.freq_once_per_bar_close": "once_per_bar_close",
  "scale.right": "right",
  "scale.left": "left",
  "scale.none": "none",
  "barstate.isnew": true,
  // v4 girdi tipleri (input(type=…))
  "input.integer": "int",
  "input.resolution": "timeframe",
  "input.bool": "bool",
  "input.float": "float",
  "input.string": "string",
  "input.source": "source",
  "input.session": "session",
  "input.symbol": "symbol",
  "input.color": "color",
  "input.time": "time",
};

/** Desteklenmeyen çizim nesnesi ad alanları: çağrılar yok sayılır, sabitler ad olarak döner. */
export const DRAWING_NS = ["label", "line", "box", "table", "linefill", "polyline", "chart.point", "text", "xloc", "yloc", "extend", "position", "font"];

export function drawingNs(name: string): string | null {
  for (const ns of DRAWING_NS) if (name.startsWith(`${ns}.`)) return ns;
  return null;
}
