/**
 * Pine çıktısı → lightweight-charts veri yapıları (saf fonksiyonlar; test edilebilir).
 * Zaman: grafik yerel saatte gösterilsin diye UTC saniyeye yerel saat farkı eklenir.
 */
import type { PlotOut, PlotStyle, ShapeEvent, ShapeOut } from "../pine/types";
import { cssColor } from "../pine/values";

export type ChartTime = number; // saniye (yerel kaydırmalı)

export function toChartTime(ms: number): ChartTime {
  const offsetMin = new Date(ms).getTimezoneOffset();
  return Math.floor(ms / 1000) - offsetMin * 60;
}

export interface LinePoint {
  time: ChartTime;
  value?: number;
  color?: string;
}

export type SeriesKind = "line" | "histogram" | "area" | "points";

export function seriesKind(style: PlotStyle): SeriesKind {
  switch (style) {
    case "histogram":
    case "columns":
      return "histogram";
    case "area":
    case "areabr":
      return "area";
    case "circles":
    case "cross":
      return "points";
    default:
      return "line";
  }
}

/** Boşluklarda kopan stiller (linebr, areabr…); "line" boşlukların üzerinden bağlanır (Pine'daki gibi). */
export function breaksOnNa(style: PlotStyle): boolean {
  return style === "linebr" || style === "areabr" || style === "steplinebr" || style === "histogram" || style === "columns" || style === "circles" || style === "cross";
}

/** Plot değerleri → seri noktaları (ofset uygulanır; ileri kayan değerler için gelecek zamanlar üretilir). */
export function plotPoints(p: PlotOut, times: ChartTime[], stepSec: number): LinePoint[] {
  const n = times.length;
  const out: LinePoint[] = [];
  const brk = breaksOnNa(p.style);
  for (let i = 0; i < n; i++) {
    const j = i + p.offset;
    if (j < 0) continue;
    const t = j < n ? times[j]! : times[n - 1]! + (j - n + 1) * stepSec;
    const v = p.values[i]!;
    const c = p.colors[i];
    const css = c ? cssColor(c) : null;
    if (Number.isNaN(v) || css === null) {
      if (brk) out.push({ time: t });
      continue;
    }
    out.push({ time: t, value: v, color: css });
  }
  return out;
}

export function firstColor(p: PlotOut): string {
  for (let i = p.colors.length - 1; i >= 0; i--) {
    const c = p.colors[i];
    if (c) return cssColor(c) ?? "#2962FF";
  }
  return "#2962FF";
}

export interface MarkerSpec {
  time: ChartTime;
  position: "aboveBar" | "belowBar" | "inBar" | "atPriceTop" | "atPriceBottom" | "atPriceMiddle";
  shape: "circle" | "square" | "arrowUp" | "arrowDown";
  color: string;
  text?: string;
  size?: number;
  price?: number;
}

const SIZE: Record<string, number> = { tiny: 0.6, small: 0.9, normal: 1.2, auto: 1, large: 1.6, huge: 2.1 };

function markerShape(e: ShapeEvent): MarkerSpec["shape"] {
  switch (e.shape) {
    case "labelup":
    case "arrowup":
    case "triangleup":
      return "arrowUp";
    case "labeldown":
    case "arrowdown":
    case "triangledown":
      return "arrowDown";
    case "circle":
    case "char":
      return "circle";
    default:
      return "square";
  }
}

export function shapeMarkers(s: ShapeOut, times: ChartTime[]): MarkerSpec[] {
  const out: MarkerSpec[] = [];
  for (const e of s.events) {
    const j = e.bar + s.offset;
    if (j < 0 || j >= times.length) continue;
    const color = (e.color && cssColor(e.color)) || "#2962FF";
    const absolute = e.location === "absolute" && e.price !== null && !Number.isNaN(e.price);
    const m: MarkerSpec = {
      time: times[j]!,
      position: absolute ? "atPriceMiddle" : e.location === "belowbar" || e.location === "bottom" ? "belowBar" : "aboveBar",
      shape: markerShape(e),
      color,
      size: SIZE[e.size] ?? 1,
    };
    if (absolute) m.price = e.price!;
    const text = e.shape === "char" ? e.text : e.text;
    if (text) m.text = text;
    out.push(m);
  }
  return out;
}

/** Mum renkleri: son göstergenin rengi kazanır; null = varsayılan. */
export function mergeBarColors(list: ((string | null)[] | null)[], n: number): (string | null)[] | null {
  let out: (string | null)[] | null = null;
  for (const bc of list) {
    if (!bc) continue;
    out ??= new Array(n).fill(null);
    for (let i = 0; i < n && i < bc.length; i++) if (bc[i]) out[i] = cssColor(bc[i]);
  }
  return out;
}

/** Fiyat büyüklüğüne göre ondalık (Binance/TradingView'a yakın: BTC 1, SOL 2, LINK 3, XRP 4). */
export function priceDigits(price: number): number {
  const p = Math.abs(price);
  if (!(p > 0)) return 2;
  if (p >= 10000) return 1;
  if (p >= 100) return 2;
  if (p >= 10) return 3;
  if (p >= 1) return 4;
  return Math.min(8, 4 - Math.floor(Math.log10(p)));
}

/** Fiyat ekseni biçimi: mumların altındaki boşlukta çıkan eksi etiketler gizlenir (fiyat eksi olamaz). */
export function priceAxisFormat(digits: number) {
  return {
    type: "custom" as const,
    minMove: Math.pow(10, -digits),
    formatter: (p: number) => (p < 0 ? "" : p.toFixed(digits)),
  };
}

export function fmtNum(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  return v.toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
