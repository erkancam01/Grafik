/**
 * Grafik: mumlar + hacim + indikatör katmanları (fiyat paneline bindirme ya da alt paneller), işaretçiler,
 * mum renkleri, arka plan bantları, yatay çizgiler; sol üstte açıklama satırı (OHLC + indikatör değerleri).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BarsData, PineOutput } from "../pine/types";
import { cssColor } from "../pine/values";
import type { Theme } from "../store/state";
import {
  firstColor,
  fmtNum,
  mergeBarColors,
  plotPoints,
  priceDigits,
  seriesKind,
  shapeMarkers,
  toChartTime,
  type ChartTime,
  type MarkerSpec,
} from "./render";

export interface ChartIndicator {
  uid: string;
  /** Her yeni hesaplamada artar (katmanlar yeniden kurulur). */
  rev: number;
  title: string;
  output: PineOutput | null;
  /** Çıktının hesaplandığı mumların ilk zamanı (eski çıktıyı yeni veriye uygulamamak için). */
  firstTime: number | null;
  visible: boolean;
  status: "loading" | "ok" | "error";
  error: string | null;
  warnings: string[];
}

interface Props {
  bars: BarsData | null;
  viewKey: string;
  theme: Theme;
  indicators: ChartIndicator[];
  header: ReactNode;
  renderControls: (ind: ChartIndicator) => ReactNode;
  onNeedMore: () => void;
  /** Bu zaman aralığını göster (ör. strateji işlem listesinden seçilen işlem); `seq` her istekte artar. */
  focus?: { from: number; to: number; seq: number } | null;
}

interface Palette {
  bg: string;
  fg: string;
  grid: string;
  line: string;
  up: string;
  down: string;
}

const PALETTE: Record<Theme, Palette> = {
  dark: { bg: "#131722", fg: "#d1d4dc", grid: "rgba(42,46,57,0.6)", line: "#2a2e39", up: "#26a69a", down: "#ef5350" },
  light: { bg: "#ffffff", fg: "#131722", grid: "rgba(224,227,235,0.7)", line: "#e0e3eb", up: "#089981", down: "#f23645" },
};

type AnySeries = ISeriesApi<SeriesType>;

interface Layer {
  series: AnySeries[];
  markers: ISeriesMarkersPluginApi<Time>[];
  priceLines: [AnySeries, IPriceLine][];
}

function withAlpha(css: string, a: number): string {
  const m = /rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(css);
  return m ? `rgba(${m[1]},${m[2]},${m[3]}, ${a})` : css;
}

function chartOptions(t: Theme, intraday: boolean) {
  const p = PALETTE[t];
  return {
    layout: {
      background: { color: p.bg },
      textColor: p.fg,
      fontSize: 11,
      panes: { separatorColor: p.line, separatorHoverColor: p.line, enableResize: true },
      attributionLogo: true,
    },
    grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
    rightPriceScale: { borderColor: p.line },
    timeScale: { borderColor: p.line, timeVisible: intraday, secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: CrosshairMode.Normal },
    localization: { locale: "tr-TR" },
  };
}

export function ChartView({ bars, viewKey, theme, indicators, header, renderControls, onNeedMore, focus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const candleMarkers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const layer = useRef<Layer>({ series: [], markers: [], priceLines: [] });
  const timesRef = useRef<ChartTime[]>([]);
  const indexOf = useRef(new Map<number, number>());
  const lastView = useRef("");
  const lastShape = useRef<{ first: number; n: number; colorsKey: string } | null>(null);
  const needMore = useRef(onNeedMore);
  needMore.current = onNeedMore;
  const [hover, setHover] = useState<number | null>(null);

  const intraday = (bars?.tfSec ?? 3600) < 86400;

  // grafik bir kez
  useEffect(() => {
    const el = host.current!;
    const chart = createChart(el, { autoSize: true, ...chartOptions(theme, intraday) });
    const p = PALETTE[theme];
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: p.up,
      downColor: p.down,
      borderVisible: false,
      wickUpColor: p.up,
      wickDownColor: p.down,
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.18 } });
    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });
    candleMarkers.current = createSeriesMarkers(candle, []);
    chart.subscribeCrosshairMove((param) => {
      if (typeof param.time === "number") setHover(indexOf.current.get(param.time) ?? null);
      else setHover(null);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < 15 && timesRef.current.length > 0) needMore.current();
    });
    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // tema
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const p = PALETTE[theme];
    chart.applyOptions(chartOptions(theme, intraday));
    candleRef.current?.applyOptions({ upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down });
    lastShape.current = null; // hacim renkleri yeniden
  }, [theme, intraday]);

  const visibleOutputs = useMemo(
    () =>
      indicators.filter(
        (i) => i.visible && i.output && bars && bars.time.length > 0 && i.firstTime === bars.time[0] && i.output.stats.bars <= bars.time.length,
      ),
    [indicators, bars],
  );
  const barColors = useMemo(
    () => (bars ? mergeBarColors(visibleOutputs.map((i) => i.output!.barcolors), bars.time.length) : null),
    [visibleOutputs, bars],
  );
  const colorsKey = useMemo(() => visibleOutputs.map((i) => `${i.uid}:${i.rev}`).join("|"), [visibleOutputs]);

  // mumlar + hacim
  useEffect(() => {
    const candle = candleRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!candle || !vol || !chart) return;
    if (!bars || bars.time.length === 0) {
      candle.setData([]);
      vol.setData([]);
      timesRef.current = [];
      indexOf.current = new Map();
      lastShape.current = null;
      return;
    }
    const n = bars.time.length;
    const p = PALETTE[theme];
    const times = timesRef.current.length === n && timesRef.current[0] === toChartTime(bars.time[0]!) && timesRef.current[n - 1] === toChartTime(bars.time[n - 1]!)
      ? timesRef.current
      : Array.from(bars.time, (t) => toChartTime(t));
    const prev = lastShape.current;
    const digits = priceDigits(bars.close[n - 1]!);
    candle.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: Math.pow(10, -digits) } });
    const candleAt = (i: number) => {
      const c = barColors?.[i];
      const base = { time: times[i] as UTCTimestamp, open: bars.open[i]!, high: bars.high[i]!, low: bars.low[i]!, close: bars.close[i]! };
      return c ? { ...base, color: c, borderColor: c, wickColor: c } : base;
    };
    const volAt = (i: number) => ({
      time: times[i] as UTCTimestamp,
      value: bars.volume[i]!,
      color: bars.close[i]! >= bars.open[i]! ? `${p.up}40` : `${p.down}40`,
    });
    const sameStart = prev && prev.first === bars.time[0] && prev.colorsKey === colorsKey;
    if (sameStart && (n === prev.n || n === prev.n + 1) && lastView.current === viewKey) {
      candle.update(candleAt(n - 1));
      vol.update(volAt(n - 1));
    } else {
      candle.setData(Array.from({ length: n }, (_, i) => candleAt(i)));
      vol.setData(Array.from({ length: n }, (_, i) => volAt(i)));
      if (lastView.current !== viewKey) {
        lastView.current = viewKey;
        const width = host.current?.clientWidth ?? 600;
        const show = Math.max(40, Math.min(n, Math.floor(width / 6)));
        chart.timeScale().setVisibleLogicalRange({ from: n - show, to: n + 5 });
      } else if (prev && prev.first !== bars.time[0] && n > prev.n) {
        // sola geçmiş eklendi: görünür aralığı kaydır
        const added = n - prev.n;
        const r = chart.timeScale().getVisibleLogicalRange();
        if (r) chart.timeScale().setVisibleLogicalRange({ from: r.from + added, to: r.to + added });
      }
    }
    timesRef.current = times;
    if (indexOf.current.size !== n || prev?.first !== bars.time[0]) {
      const m = new Map<number, number>();
      times.forEach((t, i) => m.set(t, i));
      indexOf.current = m;
    } else {
      indexOf.current.set(times[n - 1]!, n - 1);
    }
    lastShape.current = { first: bars.time[0]!, n, colorsKey };
  }, [bars, barColors, colorsKey, viewKey, theme]);

  // indikatör katmanları (çıktılar değişince yeniden kurulur)
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle || !bars) return;
    const L = layer.current;
    for (const [s, pl] of L.priceLines) {
      try {
        s.removePriceLine(pl);
      } catch {
        /* seri kaldırılmış */
      }
    }
    for (const m of L.markers) m.detach();
    for (const s of L.series) chart.removeSeries(s);
    layer.current = { series: [], markers: [], priceLines: [] };
    const NL = layer.current;
    const times = Array.from(bars.time, (t) => toChartTime(t));
    const step = bars.tfSec;
    const overlayMarkers: MarkerSpec[] = [];
    const mainDigits = priceDigits(bars.close[bars.time.length - 1] ?? 1);
    let pane = 1;
    for (const ind of visibleOutputs) {
      const out = ind.output!;
      const hasPane = out.plots.some((p) => p.display) || out.hlines.length > 0 || !!out.bgcolors;
      const paneIndex = out.meta.overlay || !hasPane ? 0 : pane++;
      const t = times.slice(0, out.stats.bars);
      let maxAbs = 0;
      for (const p of out.plots) for (const v of p.values) if (!Number.isNaN(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
      const digits = out.meta.overlay ? mainDigits : (out.meta.precision ?? Math.min(6, priceDigits(maxAbs || 1)));
      const priceFormat = { type: "price" as const, precision: digits, minMove: Math.pow(10, -digits) };
      if (out.bgcolors) {
        const id = `bg_${ind.uid}`;
        const s = chart.addSeries(
          HistogramSeries,
          {
            priceScaleId: id,
            lastValueVisible: false,
            priceLineVisible: false,
            base: 0,
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 1 } }),
          },
          paneIndex,
        );
        chart.priceScale(id, paneIndex).applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
        s.setData(
          t.map((tt, i) => {
            const c = out.bgcolors![i] ? cssColor(out.bgcolors![i]) : null;
            return c ? { time: tt as UTCTimestamp, value: 1, color: c } : { time: tt as UTCTimestamp };
          }),
        );
        s.setSeriesOrder(0);
        NL.series.push(s);
      }
      let first: AnySeries | null = null;
      for (const p of out.plots) {
        if (!p.display) continue;
        const kind = seriesKind(p.style);
        const color = firstColor(p);
        const common = { priceLineVisible: p.trackprice, lastValueVisible: true, priceFormat };
        let s: AnySeries;
        if (kind === "histogram") {
          s = chart.addSeries(HistogramSeries, { ...common, color, base: p.histbase }, paneIndex);
        } else if (kind === "area") {
          s = chart.addSeries(
            AreaSeries,
            { ...common, lineColor: color, topColor: withAlpha(color, 0.3), bottomColor: withAlpha(color, 0), lineWidth: p.linewidth as 1 | 2 | 3 | 4 },
            paneIndex,
          );
        } else {
          s = chart.addSeries(
            LineSeries,
            {
              ...common,
              color,
              lineWidth: p.linewidth as 1 | 2 | 3 | 4,
              lineType: p.style.startsWith("stepline") ? LineType.WithSteps : LineType.Simple,
              lineVisible: kind !== "points",
              pointMarkersVisible: kind === "points",
              ...(kind === "points" ? { pointMarkersRadius: 1 + p.linewidth } : {}),
              crosshairMarkerVisible: kind !== "points",
            },
            paneIndex,
          );
        }
        s.setData(plotPoints(p, t, step) as never);
        NL.series.push(s);
        first ??= s;
      }
      if (out.hlines.length) {
        let hostSeries: AnySeries | null = first ?? (paneIndex === 0 ? candle : null);
        if (!hostSeries) {
          const prices = out.hlines.map((h) => h.price).filter((x) => !Number.isNaN(x));
          const lo = Math.min(...prices);
          const hi = Math.max(...prices);
          const pad = (hi - lo) * 0.1 || 1;
          hostSeries = chart.addSeries(
            LineSeries,
            { lineVisible: false, lastValueVisible: false, priceLineVisible: false, autoscaleInfoProvider: () => ({ priceRange: { minValue: lo - pad, maxValue: hi + pad } }) },
            paneIndex,
          );
          hostSeries.setData(t.map((tt) => ({ time: tt as UTCTimestamp })));
          NL.series.push(hostSeries);
        }
        for (const h of out.hlines) {
          if (Number.isNaN(h.price)) continue;
          const pl = hostSeries.createPriceLine({
            price: h.price,
            color: (h.color && cssColor(h.color)) || "#787B86",
            lineWidth: Math.min(4, h.linewidth) as 1 | 2 | 3 | 4,
            lineStyle: h.style === "solid" ? LineStyle.Solid : h.style === "dotted" ? LineStyle.Dotted : LineStyle.Dashed,
            axisLabelVisible: false,
            title: "",
          });
          NL.priceLines.push([hostSeries, pl]);
        }
      }
      const paneMs: MarkerSpec[] = [];
      for (const s of out.shapes) {
        const ms = shapeMarkers(s, t);
        if (paneIndex === 0 || s.overlay) overlayMarkers.push(...ms);
        else paneMs.push(...ms);
      }
      if (first && paneMs.length) {
        NL.markers.push(createSeriesMarkers(first, paneMs.sort((a, b) => a.time - b.time) as never));
      }
    }
    candleMarkers.current?.setMarkers(overlayMarkers.sort((a, b) => a.time - b.time) as never);
    const panes = chart.panes();
    panes.forEach((pn, i) => pn.setStretchFactor(i === 0 ? 3 : 1));
    // yalnız çıktı/görünürlük değişince (canlı tikte değil)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorsKey, theme]);

  // odak: seçilen zaman aralığına git
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !focus || !bars || bars.time.length === 0) return;
    const idx = (t: number) => {
      let lo = 0;
      let hi = bars.time.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bars.time[mid]! < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const a = idx(focus.from);
    const b = Math.max(a, idx(focus.to));
    const pad = Math.max(15, Math.round((b - a) * 0.4));
    chart.timeScale().setVisibleLogicalRange({ from: a - pad, to: b + pad });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq]);

  // açıklama satırı değerleri
  const n = bars?.time.length ?? 0;
  const hi = hover ?? n - 1;
  const ohlc =
    bars && hi >= 0 && hi < n ? { o: bars.open[hi]!, h: bars.high[hi]!, l: bars.low[hi]!, c: bars.close[hi]! } : null;
  const digits = bars && n ? priceDigits(bars.close[n - 1]!) : 2;
  const up = ohlc ? ohlc.c >= ohlc.o : true;

  return (
    <div className="relative h-full w-full">
      <div ref={host} className="absolute inset-0" data-testid="chart" />
      <div className="pointer-events-none absolute left-2 right-16 top-1.5 z-10 space-y-0.5 text-[12px]">
        <div className="flex flex-wrap items-center gap-x-2">
          {header}
          {ohlc && (
            <span className="flex gap-x-1.5 tabular-nums text-muted" data-testid="ohlc">
              <span>
                A <b className={up ? "text-up" : "text-down"}>{fmtNum(ohlc.o, digits)}</b>
              </span>
              <span>
                Y <b className={up ? "text-up" : "text-down"}>{fmtNum(ohlc.h, digits)}</b>
              </span>
              <span>
                D <b className={up ? "text-up" : "text-down"}>{fmtNum(ohlc.l, digits)}</b>
              </span>
              <span>
                K <b className={up ? "text-up" : "text-down"}>{fmtNum(ohlc.c, digits)}</b>
              </span>
            </span>
          )}
        </div>
        {indicators.map((ind) => {
          const out = ind.output;
          const vals =
            out && ind.visible && hi >= 0
              ? out.plots
                  .filter((p) => p.display)
                  .slice(0, 4)
                  .map((p) => ({ v: hi < p.values.length ? p.values[hi]! : Number.NaN, c: firstColor(p), t: p.title }))
              : [];
          const d = out ? (out.meta.overlay ? digits : (out.meta.precision ?? 2)) : 2;
          return (
            <div key={ind.uid} className="flex flex-wrap items-center gap-x-1.5" data-testid="legend-row">
              <span className={ind.visible ? "text-fg" : "text-subtle line-through"}>{ind.title}</span>
              <span className="pointer-events-auto flex items-center">{renderControls(ind)}</span>
              {ind.status === "loading" && <span className="text-subtle">hesaplanıyor…</span>}
              {ind.status === "error" && (
                <span className="max-w-[70vw] truncate text-down" title={ind.error ?? ""} data-testid="legend-error">
                  {ind.error}
                </span>
              )}
              {vals.map((x, i) => (
                <span key={i} className="tabular-nums" style={{ color: x.c }} title={x.t}>
                  {fmtNum(x.v, d)}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
