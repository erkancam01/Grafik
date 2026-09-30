/** Zaman dilimleri: arayüz etiketi, Binance aralığı, saniye. */
export interface IntervalDef {
  id: string; // Binance aralığı
  label: string;
  sec: number;
}

export const INTERVALS: IntervalDef[] = [
  { id: "1m", label: "1m", sec: 60 },
  { id: "3m", label: "3m", sec: 180 },
  { id: "5m", label: "5m", sec: 300 },
  { id: "15m", label: "15m", sec: 900 },
  { id: "30m", label: "30m", sec: 1800 },
  { id: "1h", label: "1h", sec: 3600 },
  { id: "2h", label: "2h", sec: 7200 },
  { id: "4h", label: "4h", sec: 14400 },
  { id: "6h", label: "6h", sec: 21600 },
  { id: "8h", label: "8h", sec: 28800 },
  { id: "12h", label: "12h", sec: 43200 },
  { id: "1d", label: "1D", sec: 86400 },
  { id: "3d", label: "3D", sec: 259200 },
  { id: "1w", label: "1W", sec: 604800 },
];

/** Üst çubukta gösterilenler (diğerleri yalnız request.security için). */
export const BAR_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "12h", "1d", "1w"];

export function intervalById(id: string): IntervalDef | undefined {
  return INTERVALS.find((x) => x.id === id);
}

export function intervalBySec(sec: number): IntervalDef | undefined {
  return INTERVALS.find((x) => x.sec === sec);
}

export function supportedTfList(): string {
  return INTERVALS.map((x) => (x.sec >= 86400 ? `${x.sec / 86400}D` : String(x.sec / 60))).join(", ");
}
