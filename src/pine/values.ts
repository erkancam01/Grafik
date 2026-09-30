/** Pine değerleri: `na` = NaN (tüm tipler için), renkler "#RRGGBBAA" dizgisi, diziler ve demetler sınıf. */

export const NA = Number.NaN;

export function isNa(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "number" && Number.isNaN(v));
}

/** Koşul olarak değer: na ve 0 yanlış (Pine v4/v5 örtük dönüşümü). */
export function truthy(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v === undefined || v === null) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  return true;
}

export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return Number.NaN;
}

export class PineArray {
  constructor(public items: unknown[] = []) {}
}

export class PineTuple {
  constructor(public items: unknown[]) {}
}

/** Desteklenmeyen çizim nesneleri (label/line/box/table) için yer tutucu. */
export class PineDrawing {
  constructor(public kind: string) {}
}

// ---------------------------------------------------------------- renkler
export function colorFromRgba(r: number, g: number, b: number, a255: number): string {
  const h = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}${h(a255)}`;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0-255 opaklık */
  a: number;
}

export function parseColor(c: unknown): Rgba | null {
  if (typeof c !== "string" || c[0] !== "#") return null;
  const s = c.slice(1);
  if (s.length !== 6 && s.length !== 8) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) : 255;
  return { r, g, b, a };
}

/** Pine şeffaflığı (0 = opak, 100 = görünmez) ile yeni renk. */
export function withTransp(c: unknown, transp: number): unknown {
  const p = parseColor(c);
  if (!p || Number.isNaN(transp)) return c;
  const t = Math.max(0, Math.min(100, transp));
  return colorFromRgba(p.r, p.g, p.b, 255 * (1 - t / 100));
}

/** Arayüz için CSS rgba(). */
export function cssColor(c: unknown): string | null {
  const p = parseColor(c);
  if (!p) return null;
  return `rgba(${p.r}, ${p.g}, ${p.b}, ${+(p.a / 255).toFixed(3)})`;
}

/** TradingView v5 paleti. */
export const COLORS: Record<string, string> = {
  aqua: "#00BCD4FF",
  black: "#363A45FF",
  blue: "#2962FFFF",
  fuchsia: "#E040FBFF",
  gray: "#787B86FF",
  green: "#4CAF50FF",
  lime: "#00E676FF",
  maroon: "#880E4FFF",
  navy: "#311B92FF",
  olive: "#808000FF",
  orange: "#FF9800FF",
  purple: "#9C27B0FF",
  red: "#F23645FF",
  silver: "#B2B5BEFF",
  teal: "#089981FF",
  white: "#FFFFFFFF",
  yellow: "#FDD835FF",
};

export function normColor(v: string): string {
  return v.length === 7 ? `${v}FF` : v;
}

export function toStr(v: unknown, fmt?: string): string {
  if (isNa(v)) return "NaN";
  if (typeof v === "number") {
    if (fmt && fmt.startsWith("#")) {
      const m = /\.(0+|#+)/.exec(fmt);
      const d = m ? m[1]!.length : 0;
      return v.toFixed(d);
    }
    if (fmt === "percent") return `${(v * 100).toFixed(2)}%`;
    if (fmt === "mintick") return String(v);
    if (Number.isInteger(v)) return String(v);
    return String(+v.toFixed(8));
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof PineArray) return `[${v.items.map((x) => toStr(x)).join(", ")}]`;
  return String(v);
}
