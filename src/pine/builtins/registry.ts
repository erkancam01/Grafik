/** Yerleşik fonksiyon tanımı: parametre adları (adlı argüman eşlemesi için) + uygulama. */
import type { Frame, Runtime } from "../engine";

export type BuiltinFn = (rt: Runtime, f: Frame, site: number, a: unknown[]) => unknown;

export interface BuiltinDef {
  params: string[];
  fn: BuiltinFn;
}

export function def(params: string[], fn: BuiltinFn): BuiltinDef {
  return { params, fn };
}

export function n(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return Number.NaN;
}

/** Uzunluk argümanı: tam sayıya indirilir; geçersizse NaN. */
export function len(v: unknown): number {
  const x = Math.floor(n(v));
  return x >= 1 ? x : Number.NaN;
}
