/** math.*, str.*, color.*, nz/na/fixnan/iff, zaman fonksiyonları, array.*, timeframe.*, ticker.*. */
import { runtimeError } from "../errors";
import type { Runtime } from "../engine";
import {
  COLORS,
  PineArray,
  colorFromRgba,
  isNa,
  parseColor,
  toStr,
  truthy,
  withTransp,
} from "../values";
import { def, n, type BuiltinDef } from "./registry";

const NaN_ = Number.NaN;

// ---------------------------------------------------------------- zaman dilimleri
/** Pine zaman dilimi dizgisi → saniye ("240" → 14400, "D" → 86400). Geçersizse NaN. */
export function tfToSec(tf: unknown): number {
  if (typeof tf !== "string") return NaN_;
  const s = tf.trim().toUpperCase();
  if (s === "") return NaN_;
  const m = /^(\d*)([SDWM]?)$/.exec(s);
  if (!m) return NaN_;
  const k = m[1] === "" ? 1 : Number(m[1]);
  switch (m[2]) {
    case "":
      return k * 60;
    case "S":
      return k;
    case "D":
      return k * 86400;
    case "W":
      return k * 7 * 86400;
    case "M":
      return k * 30 * 86400;
    default:
      return NaN_;
  }
}

/** Saniye → Pine zaman dilimi dizgisi. */
export function secToTf(sec: number): string {
  if (sec % (7 * 86400) === 0) return `${sec / (7 * 86400) === 1 ? "" : sec / (7 * 86400)}W`;
  if (sec % 86400 === 0) return `${sec / 86400 === 1 ? "" : sec / 86400}D`;
  if (sec % 60 === 0) return String(sec / 60);
  return `${sec}S`;
}

// ---------------------------------------------------------------- zaman
function utc(t: unknown): Date | null {
  const x = n(t);
  return Number.isNaN(x) ? null : new Date(x);
}

export const TIME_PARTS: Record<string, (d: Date) => number> = {
  year: (d) => d.getUTCFullYear(),
  month: (d) => d.getUTCMonth() + 1,
  weekofyear: (d) => {
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const day = new Date(t).getUTCDay() || 7;
    const th = new Date(t + (4 - day) * 86400000);
    const y0 = Date.UTC(th.getUTCFullYear(), 0, 1);
    return Math.ceil(((th.getTime() - y0) / 86400000 + 1) / 7);
  },
  dayofmonth: (d) => d.getUTCDate(),
  dayofweek: (d) => d.getUTCDay() + 1,
  hour: (d) => d.getUTCHours(),
  minute: (d) => d.getUTCMinutes(),
  second: (d) => d.getUTCSeconds(),
};

function bucketStart(t: number, sec: number): number {
  if (sec >= 7 * 86400) {
    // Pine haftası pazartesi başlar (Binance 1w de pazartesi)
    const monday0 = Date.UTC(1970, 0, 5);
    return monday0 + Math.floor((t - monday0) / (sec * 1000)) * sec * 1000;
  }
  return Math.floor(t / (sec * 1000)) * sec * 1000;
}

// ---------------------------------------------------------------- dizi yardımcıları
function arr(v: unknown, fn: string): PineArray {
  if (!(v instanceof PineArray)) throw runtimeError(`${fn}: dizi bekleniyordu`);
  return v;
}
function idx(a: PineArray, i: unknown, fn: string): number {
  let k = Math.floor(n(i));
  if (k < 0) k += a.items.length;
  if (!(k >= 0 && k < a.items.length)) {
    throw runtimeError(`${fn}: dizin ${String(i)} dizi sınırı dışında (boyut ${a.items.length})`);
  }
  return k;
}
function nums(a: PineArray): number[] {
  return a.items.map((x) => n(x)).filter((x) => !Number.isNaN(x));
}
function newArr(size: unknown, init: unknown): PineArray {
  const k = Math.max(0, Math.floor(n(size ?? 0)) || 0);
  return new PineArray(new Array(k).fill(init === undefined ? NaN_ : init));
}

function mathVarargs(fn: (xs: number[]) => number): BuiltinDef {
  return def([], (_rt, _f, _s, a) => {
    const xs = a.map((x) => n(x));
    if (xs.some((x) => Number.isNaN(x))) return NaN_;
    return fn(xs);
  });
}

function strFormat(fmt: string, args: unknown[]): string {
  return fmt.replace(/\{(\d+)(?:,\s*number\s*,?\s*([^}]*))?\}/g, (_m, i: string, f?: string) => {
    const v = args[Number(i)];
    if (f && typeof v === "number") {
      const m = /\.(0+|#+)/.exec(f);
      return v.toFixed(m ? m[1]!.length : 0);
    }
    return toStr(v);
  });
}

// ---------------------------------------------------------------- tanımlar
export const CORE: Record<string, BuiltinDef> = {
  // na / nz
  na: def(["x"], (_rt, _f, _s, a) => isNa(a[0])),
  nz: def(["source", "replacement"], (_rt, _f, _s, a) => (isNa(a[0]) ? (a[1] === undefined ? 0 : a[1]) : a[0])),
  fixnan: def(["source"], (rt, f, site, a) => {
    const s = rt.st(f, site, () => ({ last: NaN_ as unknown }));
    if (!isNa(a[0])) s.last = a[0];
    return s.last;
  }),
  iff: def(["condition", "then", "_else"], (_rt, _f, _s, a) => (truthy(a[0]) ? a[1] : a[2])),

  // math
  "math.abs": def(["number"], (_rt, _f, _s, a) => Math.abs(n(a[0]))),
  "math.max": mathVarargs((xs) => Math.max(...xs)),
  "math.min": mathVarargs((xs) => Math.min(...xs)),
  "math.avg": mathVarargs((xs) => xs.reduce((p, x) => p + x, 0) / xs.length),
  "math.round": def(["number", "precision"], (_rt, _f, _s, a) => {
    const x = n(a[0]);
    if (a[1] === undefined) return Math.sign(x) * Math.round(Math.abs(x));
    const p = Math.pow(10, Math.floor(n(a[1])));
    return Math.round(x * p) / p;
  }),
  "math.floor": def(["number"], (_rt, _f, _s, a) => Math.floor(n(a[0]))),
  "math.ceil": def(["number"], (_rt, _f, _s, a) => Math.ceil(n(a[0]))),
  "math.sqrt": def(["number"], (_rt, _f, _s, a) => Math.sqrt(n(a[0]))),
  "math.pow": def(["base", "exponent"], (_rt, _f, _s, a) => Math.pow(n(a[0]), n(a[1]))),
  "math.log": def(["number"], (_rt, _f, _s, a) => Math.log(n(a[0]))),
  "math.log10": def(["number"], (_rt, _f, _s, a) => Math.log10(n(a[0]))),
  "math.exp": def(["number"], (_rt, _f, _s, a) => Math.exp(n(a[0]))),
  "math.sign": def(["number"], (_rt, _f, _s, a) => Math.sign(n(a[0]))),
  "math.sin": def(["angle"], (_rt, _f, _s, a) => Math.sin(n(a[0]))),
  "math.cos": def(["angle"], (_rt, _f, _s, a) => Math.cos(n(a[0]))),
  "math.tan": def(["angle"], (_rt, _f, _s, a) => Math.tan(n(a[0]))),
  "math.asin": def(["angle"], (_rt, _f, _s, a) => Math.asin(n(a[0]))),
  "math.acos": def(["angle"], (_rt, _f, _s, a) => Math.acos(n(a[0]))),
  "math.atan": def(["angle"], (_rt, _f, _s, a) => Math.atan(n(a[0]))),
  "math.todegrees": def(["radians"], (_rt, _f, _s, a) => (n(a[0]) * 180) / Math.PI),
  "math.toradians": def(["degrees"], (_rt, _f, _s, a) => (n(a[0]) * Math.PI) / 180),
  "math.round_to_mintick": def(["number"], (rt, _f, _s, a) => {
    const t = rt.S.mintick;
    return Math.round(n(a[0]) / t) * t;
  }),
  "math.random": def(["min", "max", "seed"], (_rt, _f, _s, a) => {
    const lo = a[0] === undefined ? 0 : n(a[0]);
    const hi = a[1] === undefined ? 1 : n(a[1]);
    return lo + Math.random() * (hi - lo);
  }),

  // str
  "str.tostring": def(["value", "format"], (_rt, _f, _s, a) => toStr(a[0], typeof a[1] === "string" ? a[1] : undefined)),
  "str.tonumber": def(["string"], (_rt, _f, _s, a) => {
    const x = Number(a[0]);
    return typeof a[0] === "string" && a[0].trim() !== "" && Number.isFinite(x) ? x : NaN_;
  }),
  "str.format": def(["formatString"], (_rt, _f, _s, a) => strFormat(String(a[0] ?? ""), a.slice(1))),
  "str.length": def(["string"], (_rt, _f, _s, a) => String(a[0] ?? "").length),
  "str.contains": def(["source", "str"], (_rt, _f, _s, a) => String(a[0] ?? "").includes(String(a[1] ?? ""))),
  "str.startswith": def(["source", "str"], (_rt, _f, _s, a) => String(a[0] ?? "").startsWith(String(a[1] ?? ""))),
  "str.endswith": def(["source", "str"], (_rt, _f, _s, a) => String(a[0] ?? "").endsWith(String(a[1] ?? ""))),
  "str.pos": def(["source", "str"], (_rt, _f, _s, a) => {
    const i = String(a[0] ?? "").indexOf(String(a[1] ?? ""));
    return i < 0 ? NaN_ : i;
  }),
  "str.replace_all": def(["source", "target", "replacement"], (_rt, _f, _s, a) =>
    String(a[0] ?? "").split(String(a[1] ?? "")).join(String(a[2] ?? "")),
  ),
  "str.replace": def(["source", "target", "replacement", "occurrence"], (_rt, _f, _s, a) =>
    String(a[0] ?? "").replace(String(a[1] ?? ""), String(a[2] ?? "")),
  ),
  "str.lower": def(["source"], (_rt, _f, _s, a) => String(a[0] ?? "").toLowerCase()),
  "str.upper": def(["source"], (_rt, _f, _s, a) => String(a[0] ?? "").toUpperCase()),
  "str.trim": def(["source"], (_rt, _f, _s, a) => String(a[0] ?? "").trim()),
  "str.repeat": def(["source", "repeat", "separator"], (_rt, _f, _s, a) =>
    new Array(Math.max(0, Math.floor(n(a[1])) || 0)).fill(String(a[0] ?? "")).join(String(a[2] ?? "")),
  ),
  "str.substring": def(["source", "begin_pos", "end_pos"], (_rt, _f, _s, a) =>
    String(a[0] ?? "").substring(Math.floor(n(a[1])), a[2] === undefined ? undefined : Math.floor(n(a[2]))),
  ),
  "str.split": def(["string", "separator"], (_rt, _f, _s, a) =>
    new PineArray(String(a[0] ?? "").split(String(a[1] ?? ""))),
  ),

  // color
  "color.new": def(["color", "transp"], (_rt, _f, _s, a) => (isNa(a[0]) ? NaN_ : withTransp(a[0], n(a[1])))),
  "color.rgb": def(["red", "green", "blue", "transp"], (_rt, _f, _s, a) => {
    const t = a[3] === undefined ? 0 : n(a[3]);
    return colorFromRgba(n(a[0]), n(a[1]), n(a[2]), 255 * (1 - t / 100));
  }),
  "color.r": def(["color"], (_rt, _f, _s, a) => parseColor(a[0])?.r ?? NaN_),
  "color.g": def(["color"], (_rt, _f, _s, a) => parseColor(a[0])?.g ?? NaN_),
  "color.b": def(["color"], (_rt, _f, _s, a) => parseColor(a[0])?.b ?? NaN_),
  "color.t": def(["color"], (_rt, _f, _s, a) => {
    const p = parseColor(a[0]);
    return p ? Math.round((1 - p.a / 255) * 100) : NaN_;
  }),
  "color.from_gradient": def(["value", "bottom_value", "top_value", "bottom_color", "top_color"], (_rt, _f, _s, a) => {
    const v = n(a[0]);
    const lo = n(a[1]);
    const hi = n(a[2]);
    const c1 = parseColor(a[3]);
    const c2 = parseColor(a[4]);
    if (!c1 || !c2 || Number.isNaN(v)) return NaN_;
    const t = hi === lo ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return colorFromRgba(
      c1.r + (c2.r - c1.r) * t,
      c1.g + (c2.g - c1.g) * t,
      c1.b + (c2.b - c1.b) * t,
      c1.a + (c2.a - c1.a) * t,
    );
  }),
  // v4: color(c, transp)
  color: def(["color", "transp"], (_rt, _f, _s, a) => (a[1] === undefined ? a[0] : withTransp(a[0], n(a[1])))),

  // zaman
  time: def(["timeframe", "session", "timezone"], (rt, _f, _s, a) => {
    const t = rt.S.time[rt.bar]!;
    if (a[0] === undefined || a[0] === "") return t;
    const sec = tfToSec(a[0]);
    return Number.isNaN(sec) ? t : bucketStart(t, sec);
  }),
  time_close: def(["timeframe", "session", "timezone"], (rt, _f, _s, a) => {
    const t = rt.S.time[rt.bar]!;
    const sec = a[0] === undefined || a[0] === "" ? rt.S.tfSec : tfToSec(a[0]);
    return Number.isNaN(sec) ? NaN_ : bucketStart(t, sec) + sec * 1000;
  }),
  timestamp: def(["year", "month", "day", "hour", "minute", "second"], (_rt, _f, _s, a) => {
    if (typeof a[0] === "string" && a.length === 1) {
      const t = Date.parse(a[0]);
      return Number.isNaN(t) ? NaN_ : t;
    }
    // timestamp(timezone, y, m, d, …) biçimi
    const xs = typeof a[0] === "string" ? a.slice(1) : a;
    const [y, mo, d, h, mi, s] = xs.map((x) => (x === undefined ? 0 : n(x)));
    return Date.UTC(y!, (mo || 1) - 1, d || 1, h || 0, mi || 0, s || 0);
  }),
  "timeframe.in_seconds": def(["timeframe"], (rt, _f, _s, a) =>
    a[0] === undefined || a[0] === "" ? rt.main.tfSec : tfToSec(a[0]),
  ),
  "timeframe.from_seconds": def(["seconds"], (_rt, _f, _s, a) => secToTf(Math.floor(n(a[0])))),
  "timeframe.change": def(["timeframe"], (rt, _f, _s, a) => {
    const sec = tfToSec(a[0]);
    if (Number.isNaN(sec) || rt.bar === 0) return rt.bar === 0;
    return bucketStart(rt.S.time[rt.bar]!, sec) !== bucketStart(rt.S.time[rt.bar - 1]!, sec);
  }),
  "ticker.heikinashi": def(["symbol"], (_rt, _f, _s, a) => `HA:${String(a[0] ?? "").replace(/^HA:/, "")}`),
  heikinashi: def(["symbol"], (_rt, _f, _s, a) => `HA:${String(a[0] ?? "").replace(/^HA:/, "")}`),
  "ticker.new": def(["prefix", "ticker", "session", "adjustment"], (_rt, _f, _s, a) => `${String(a[0])}:${String(a[1])}`),
  tickerid: def(["prefix", "ticker", "session", "adjustment"], (_rt, _f, _s, a) => `${String(a[0])}:${String(a[1])}`),
  "ticker.standard": def(["symbol"], (_rt, _f, _s, a) => String(a[0] ?? "").replace(/^HA:/, "")),
  "ticker.modify": def(["tickerid", "session", "adjustment"], (_rt, _f, _s, a) => a[0]),

  // array
  "array.new": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1])),
  "array.new_float": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1])),
  "array.new_int": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1])),
  "array.new_bool": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1] ?? false)),
  "array.new_string": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1] ?? "")),
  "array.new_color": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1])),
  "array.new_label": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1])),
  "array.new_line": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1])),
  "array.new_box": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1])),
  "array.new_table": def(["size", "initial_value"], (_rt, _f, _s, a) => newArr(a[0], a[1])),
  "array.from": def([], (_rt, _f, _s, a) => new PineArray([...a])),
  "array.size": def(["id"], (_rt, _f, _s, a) => arr(a[0], "array.size").items.length),
  "array.get": def(["id", "index"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.get");
    return x.items[idx(x, a[1], "array.get")];
  }),
  "array.set": def(["id", "index", "value"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.set");
    x.items[idx(x, a[1], "array.set")] = a[2];
    return NaN_;
  }),
  "array.push": def(["id", "value"], (_rt, _f, _s, a) => {
    arr(a[0], "array.push").items.push(a[1]);
    return NaN_;
  }),
  "array.unshift": def(["id", "value"], (_rt, _f, _s, a) => {
    arr(a[0], "array.unshift").items.unshift(a[1]);
    return NaN_;
  }),
  "array.pop": def(["id"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.pop");
    if (!x.items.length) throw runtimeError("array.pop: dizi boş");
    return x.items.pop();
  }),
  "array.shift": def(["id"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.shift");
    if (!x.items.length) throw runtimeError("array.shift: dizi boş");
    return x.items.shift();
  }),
  "array.insert": def(["id", "index", "value"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.insert");
    x.items.splice(Math.floor(n(a[1])), 0, a[2]);
    return NaN_;
  }),
  "array.remove": def(["id", "index"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.remove");
    return x.items.splice(idx(x, a[1], "array.remove"), 1)[0];
  }),
  "array.clear": def(["id"], (_rt, _f, _s, a) => {
    arr(a[0], "array.clear").items.length = 0;
    return NaN_;
  }),
  "array.first": def(["id"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.first");
    return x.items.length ? x.items[0] : NaN_;
  }),
  "array.last": def(["id"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.last");
    return x.items.length ? x.items[x.items.length - 1] : NaN_;
  }),
  "array.sum": def(["id"], (_rt, _f, _s, a) => nums(arr(a[0], "array.sum")).reduce((p, x) => p + x, 0)),
  "array.avg": def(["id"], (_rt, _f, _s, a) => {
    const xs = nums(arr(a[0], "array.avg"));
    return xs.length ? xs.reduce((p, x) => p + x, 0) / xs.length : NaN_;
  }),
  "array.max": def(["id", "nth"], (_rt, _f, _s, a) => {
    const xs = nums(arr(a[0], "array.max")).sort((x, y) => y - x);
    return xs[Math.floor(n(a[1] ?? 0))] ?? NaN_;
  }),
  "array.min": def(["id", "nth"], (_rt, _f, _s, a) => {
    const xs = nums(arr(a[0], "array.min")).sort((x, y) => x - y);
    return xs[Math.floor(n(a[1] ?? 0))] ?? NaN_;
  }),
  "array.median": def(["id"], (_rt, _f, _s, a) => {
    const xs = nums(arr(a[0], "array.median")).sort((x, y) => x - y);
    if (!xs.length) return NaN_;
    const m = xs.length >> 1;
    return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
  }),
  "array.stdev": def(["id", "biased"], (_rt, _f, _s, a) => {
    const xs = nums(arr(a[0], "array.stdev"));
    if (!xs.length) return NaN_;
    const mu = xs.reduce((p, x) => p + x, 0) / xs.length;
    const ss = xs.reduce((p, x) => p + (x - mu) * (x - mu), 0);
    return Math.sqrt(ss / (a[1] === false ? xs.length - 1 : xs.length));
  }),
  "array.includes": def(["id", "value"], (_rt, _f, _s, a) => arr(a[0], "array.includes").items.includes(a[1])),
  "array.indexof": def(["id", "value"], (_rt, _f, _s, a) => arr(a[0], "array.indexof").items.indexOf(a[1])),
  "array.lastindexof": def(["id", "value"], (_rt, _f, _s, a) => arr(a[0], "array.lastindexof").items.lastIndexOf(a[1])),
  "array.reverse": def(["id"], (_rt, _f, _s, a) => {
    arr(a[0], "array.reverse").items.reverse();
    return NaN_;
  }),
  "array.sort": def(["id", "order"], (_rt, _f, _s, a) => {
    const desc = a[1] === "descending";
    arr(a[0], "array.sort").items.sort((x, y) => (desc ? n(y) - n(x) : n(x) - n(y)));
    return NaN_;
  }),
  "array.slice": def(["id", "index_from", "index_to"], (_rt, _f, _s, a) =>
    new PineArray(arr(a[0], "array.slice").items.slice(Math.floor(n(a[1])), Math.floor(n(a[2])))),
  ),
  "array.copy": def(["id"], (_rt, _f, _s, a) => new PineArray([...arr(a[0], "array.copy").items])),
  "array.concat": def(["id1", "id2"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.concat");
    x.items.push(...arr(a[1], "array.concat").items);
    return x;
  }),
  "array.fill": def(["id", "value", "index_from", "index_to"], (_rt, _f, _s, a) => {
    const x = arr(a[0], "array.fill");
    x.items.fill(a[1], a[2] === undefined ? 0 : Math.floor(n(a[2])), a[3] === undefined ? undefined : Math.floor(n(a[3])));
    return NaN_;
  }),
  "array.join": def(["id", "separator"], (_rt, _f, _s, a) =>
    arr(a[0], "array.join").items.map((x) => toStr(x)).join(String(a[1] ?? ",")),
  ),
  "array.range": def(["id"], (_rt, _f, _s, a) => {
    const xs = nums(arr(a[0], "array.range"));
    return xs.length ? Math.max(...xs) - Math.min(...xs) : NaN_;
  }),
  "array.abs": def(["id"], (_rt, _f, _s, a) => new PineArray(arr(a[0], "array.abs").items.map((x) => Math.abs(n(x))))),

  // diğer
  max_bars_back: def(["var", "num"], () => NaN_),
  "runtime.error": def(["message"], (_rt, _f, _s, a) => {
    throw runtimeError(String(a[0] ?? "runtime.error"));
  }),
  "log.info": def(["message"], (rt, _f, _s, a) => logMsg(rt, "bilgi", a)),
  "log.warning": def(["message"], (rt, _f, _s, a) => logMsg(rt, "uyarı", a)),
  "log.error": def(["message"], (rt, _f, _s, a) => logMsg(rt, "hata", a)),
};

function logMsg(rt: Runtime, level: string, a: unknown[]): number {
  if (rt.logs.length < 200) rt.logs.push(`[${level}] #${rt.bar}: ${strFormat(String(a[0] ?? ""), a.slice(1))}`);
  return NaN_;
}

/** v4 ve kısaltmalar: önek olmadan kullanılan math/str adları. */
export const CORE_V4_ALIASES: Record<string, string> = {
  abs: "math.abs",
  max: "math.max",
  min: "math.min",
  avg: "math.avg",
  round: "math.round",
  floor: "math.floor",
  ceil: "math.ceil",
  sqrt: "math.sqrt",
  pow: "math.pow",
  log: "math.log",
  log10: "math.log10",
  exp: "math.exp",
  sign: "math.sign",
  sin: "math.sin",
  cos: "math.cos",
  tan: "math.tan",
  asin: "math.asin",
  acos: "math.acos",
  atan: "math.atan",
  sum: "math.sum",
  tostring: "str.tostring",
  tonumber: "str.tonumber",
  study: "indicator",
  security: "request.security",
};

export { bucketStart, utc, COLORS };
