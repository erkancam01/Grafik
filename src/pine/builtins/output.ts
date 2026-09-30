/** Çizim çıktıları: plot, plotshape, plotchar, plotarrow, barcolor, bgcolor, hline, fill, alertcondition, indicator. */
import { unsupported } from "../errors";
import type { Runtime } from "../engine";
import type { PlotOut, PlotStyle, ShapeLocation, ShapeOut } from "../types";
import { COLORS, isNa, truthy, withTransp } from "../values";
import { def, n, type BuiltinDef } from "./registry";

const NaN_ = Number.NaN;
const DEFAULT_COLOR = COLORS.blue!;

const PLOT_STYLES = new Set<PlotStyle>([
  "line", "linebr", "stepline", "stepline_diamond", "steplinebr", "histogram", "columns", "area", "areabr",
  "circles", "cross",
]);

function colorArg(c: unknown, transp: unknown, fallback: string | null): string | null {
  const v = c === undefined ? fallback : c;
  if (isNa(v) || typeof v !== "string") return null;
  if (transp !== undefined && !isNa(transp)) return withTransp(v, n(transp)) as string;
  return v;
}

function displayOn(d: unknown): boolean {
  return d === undefined || (d !== "none" && d !== "data_window");
}

export interface PlotRef {
  kind: "plot" | "hline";
  site: number;
}

function plotFn(rt: Runtime, site: number, a: unknown[]): PlotRef {
  // series, title, color, linewidth, style, trackprice, histbase, offset, join, editable, show_last, display, format, precision, force_overlay, transp
  if (!rt.isMain) return { kind: "plot", site };
  let p = rt.plots.get(site);
  if (!p) {
    rt.plotNo++;
    const style = (typeof a[4] === "string" && PLOT_STYLES.has(a[4] as PlotStyle) ? a[4] : "line") as PlotStyle;
    p = {
      id: `p${site}`,
      title: typeof a[1] === "string" && a[1] !== "" ? a[1] : rt.plotNo === 1 ? "Plot" : `Plot ${rt.plotNo}`,
      style,
      linewidth: Math.max(1, Math.min(4, Math.floor(n(a[3] ?? 1)) || 1)),
      values: new Float64Array(rt.main.n).fill(NaN_),
      colors: new Array(rt.main.n).fill(null),
      offset: Math.floor(n(a[7] ?? 0)) || 0,
      histbase: a[6] === undefined ? 0 : n(a[6]),
      display: displayOn(a[11]),
      trackprice: a[5] === true,
    } satisfies PlotOut;
    rt.plots.set(site, p);
  }
  const v = typeof a[0] === "boolean" ? (a[0] ? 1 : 0) : n(a[0]);
  p.values[rt.bar] = v;
  p.colors[rt.bar] = colorArg(a[2], a[15], DEFAULT_COLOR);
  return { kind: "plot", site };
}

const LOCATIONS = new Set<ShapeLocation>(["abovebar", "belowbar", "top", "bottom", "absolute"]);

function shapeOut(rt: Runtime, site: number, kind: ShapeOut["kind"], title: unknown, offset: unknown): ShapeOut {
  let s = rt.shapes.get(site);
  if (!s) {
    rt.plotNo++;
    s = {
      id: `s${site}`,
      title: typeof title === "string" && title !== "" ? title : `Şekil ${rt.plotNo}`,
      kind,
      offset: Math.floor(n(offset ?? 0)) || 0,
      events: [],
    };
    rt.shapes.set(site, s);
  }
  return s;
}

function plotShapeLike(kind: "shape" | "char"): BuiltinDef {
  const params =
    kind === "shape"
      ? ["series", "title", "style", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay", "transp"]
      : ["series", "title", "char", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay", "transp"];
  return def(params, (rt, _f, site, a) => {
    if (!rt.isMain) return NaN_;
    const s = shapeOut(rt, site, kind, a[1], a[5]);
    if (!displayOn(a[11])) return NaN_;
    const loc = (typeof a[3] === "string" && LOCATIONS.has(a[3] as ShapeLocation) ? a[3] : "abovebar") as ShapeLocation;
    const v = a[0];
    const on = loc === "absolute" ? !isNa(v) && typeof v === "number" : truthy(v);
    if (!on) return NaN_;
    const shape = kind === "shape" ? (typeof a[2] === "string" ? a[2] : "xcross") : "char";
    const text = kind === "char" ? `${typeof a[2] === "string" ? a[2] : "★"}${typeof a[6] === "string" && a[6] ? ` ${a[6]}` : ""}` : typeof a[6] === "string" ? a[6] : "";
    s.events.push({
      bar: rt.bar,
      price: loc === "absolute" ? n(v) : null,
      location: loc,
      shape,
      color: colorArg(a[4], a[15], DEFAULT_COLOR),
      text,
      textcolor: colorArg(a[7], undefined, null),
      size: typeof a[9] === "string" ? a[9] : "auto",
    });
    return NaN_;
  });
}

export const OUTPUT: Record<string, BuiltinDef> = {
  plot: def(
    ["series", "title", "color", "linewidth", "style", "trackprice", "histbase", "offset", "join", "editable", "show_last", "display", "format", "precision", "force_overlay", "transp"],
    (rt, _f, site, a) => plotFn(rt, site, a),
  ),
  plotshape: plotShapeLike("shape"),
  plotchar: plotShapeLike("char"),
  plotarrow: def(
    ["series", "title", "colorup", "colordown", "offset", "minheight", "maxheight", "editable", "show_last", "display", "format", "precision", "force_overlay", "transp"],
    (rt, _f, site, a) => {
      if (!rt.isMain) return NaN_;
      const s = shapeOut(rt, site, "arrow", a[1], a[4]);
      const v = n(a[0]);
      if (Number.isNaN(v) || v === 0 || !displayOn(a[9])) return NaN_;
      const up = v > 0;
      s.events.push({
        bar: rt.bar,
        price: null,
        location: up ? "belowbar" : "abovebar",
        shape: up ? "arrowup" : "arrowdown",
        color: colorArg(up ? a[2] : a[3], a[13], up ? COLORS.lime! : COLORS.red!),
        text: "",
        textcolor: null,
        size: "auto",
      });
      return NaN_;
    },
  ),
  barcolor: def(["color", "offset", "editable", "show_last", "title", "display", "transp"], (rt, _f, _s, a) => {
    if (!rt.isMain) return NaN_;
    const c = colorArg(a[0], a[6], null);
    if (c === null) return NaN_;
    rt.barcolors ??= new Array(rt.main.n).fill(null);
    const off = Math.floor(n(a[1] ?? 0)) || 0;
    const i = rt.bar + off;
    if (i >= 0 && i < rt.main.n) rt.barcolors[i] = c;
    return NaN_;
  }),
  bgcolor: def(["color", "offset", "editable", "show_last", "title", "display", "force_overlay", "transp"], (rt, _f, _s, a) => {
    if (!rt.isMain) return NaN_;
    const c = colorArg(a[0], a[7], null);
    if (c === null) return NaN_;
    rt.bgcolors ??= new Array(rt.main.n).fill(null);
    const off = Math.floor(n(a[1] ?? 0)) || 0;
    const i = rt.bar + off;
    if (i >= 0 && i < rt.main.n) rt.bgcolors[i] = c;
    return NaN_;
  }),
  hline: def(["price", "title", "color", "linestyle", "linewidth", "editable", "display"], (rt, _f, site, a) => {
    if (rt.isMain && !rt.hlines.has(site) && displayOn(a[6])) {
      const st = a[3] === "solid" || a[3] === "dotted" ? a[3] : "dashed";
      rt.hlines.set(site, {
        price: n(a[0]),
        title: typeof a[1] === "string" ? a[1] : "",
        color: colorArg(a[2], undefined, COLORS.gray!),
        style: st,
        linewidth: Math.max(1, Math.floor(n(a[4] ?? 1)) || 1),
      });
    }
    return { kind: "hline", site } satisfies PlotRef;
  }),
  fill: def([], (rt) => {
    rt.warn("fill() (iki çizgi arası dolgu) henüz desteklenmiyor; dolgu çizilmedi");
    return NaN_;
  }),
  alertcondition: def(["condition", "title", "message"], (rt, _f, site, a) => {
    if (!rt.isMain) return NaN_;
    let al = rt.alerts.get(site);
    if (!al) {
      al = {
        title: typeof a[1] === "string" && a[1] ? a[1] : `Alarm ${rt.alerts.size + 1}`,
        message: typeof a[2] === "string" ? a[2] : "",
        bars: [],
      };
      rt.alerts.set(site, al);
    }
    if (truthy(a[0])) al.bars.push(rt.bar);
    return NaN_;
  }),
  alert: def(["message", "freq"], (rt, _f, site, a) => {
    if (!rt.isMain) return NaN_;
    let al = rt.alerts.get(site);
    if (!al) {
      al = { title: "alert()", message: "", bars: [] };
      rt.alerts.set(site, al);
    }
    al.bars.push(rt.bar);
    al.message = String(a[0] ?? "");
    return NaN_;
  }),
  indicator: def(
    ["title", "shorttitle", "overlay", "format", "precision", "scale", "max_bars_back", "timeframe", "timeframe_gaps", "explicit_plot_zorder", "max_lines_count", "max_labels_count", "max_boxes_count", "calc_bars_count", "max_polylines_count", "dynamic_requests", "behind_chart"],
    (rt, _f, _s, a) => {
      if (!rt.metaSet && rt.isMain) {
        rt.metaSet = true;
        const title = typeof a[0] === "string" && a[0] ? a[0] : "İndikatör";
        rt.meta = {
          title,
          shorttitle: typeof a[1] === "string" && a[1] ? a[1] : title,
          overlay: a[2] === true,
          format: typeof a[3] === "string" ? a[3] : null,
          precision: a[4] === undefined ? null : Math.floor(n(a[4])),
        };
        if (typeof a[7] === "string" && a[7] !== "") {
          rt.warn("indicator(timeframe=…) desteklenmiyor; grafik zaman diliminde hesaplandı");
        }
      }
      return NaN_;
    },
  ),
  strategy: def([], (rt) => {
    throw unsupported(`Strateji betikleri desteklenmiyor (yalnız indicator/study). #${rt.bar}`);
  }),
  library: def([], () => {
    throw unsupported("library betikleri desteklenmiyor");
  }),
};
