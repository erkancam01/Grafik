/** Kalıcı ayarlar (tarayıcıda, localStorage): sembol, zaman dilimi, tema, favoriler, indikatörler, kodlar. */
import { useCallback, useEffect, useRef, useState } from "react";

export type Theme = "dark" | "light";

export interface Settings {
  symbol: string;
  interval: string;
  theme: Theme;
  favorites: string[];
}

export interface ActiveIndicator {
  uid: string;
  source: { kind: "library"; id: string } | { kind: "user"; id: string };
  inputs: Record<string, unknown>;
  visible: boolean;
}

export interface UserScript {
  id: string;
  name: string;
  code: string;
  updatedAt: number;
}

/** Uygulama yalnız altın gösterir: XAUUSDT (Binance vadeli) ve PAXGUSDT (Binance spot, uzun geçmiş). */
export const DEFAULT_FAVORITES = ["XAUUSDT", "PAXGUSDT"];

export const DEFAULT_SETTINGS: Settings = {
  symbol: "XAUUSDT",
  interval: "4h",
  theme: "dark",
  favorites: DEFAULT_FAVORITES,
};

export const DEFAULT_INDICATORS: ActiveIndicator[] = [
  { uid: "i1", source: { kind: "library", id: "ut_bot" }, inputs: {}, visible: true },
];

export const NEW_SCRIPT = `//@version=5
indicator("Benim indikatörüm", overlay = true)
len = input.int(20, "Uzunluk", minval = 1)
plot(ta.ema(close, len), "EMA", color = color.orange, linewidth = 2)
`;

export function uid(prefix = "i"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as T;
    if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) return { ...fallback, ...v };
    return v;
  } catch {
    return fallback;
  }
}

function save(key: string, v: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* kota/özel mod: yok say */
  }
}

/** localStorage'a yazılan durum. */
export function usePersistent<T>(key: string, fallback: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => load(key, fallback));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    save(key, v);
  }, [key, v]);
  const set = useCallback((x: T | ((p: T) => T)) => setV(x as T), []);
  return [v, set];
}
