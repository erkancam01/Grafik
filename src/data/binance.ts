/**
 * Binance herkese açık piyasa verisi (anahtarsız): USDT-M vadeli (varsayılan) ya da spot (yedek).
 * REST: mumlar ve 24 saatlik özet; WebSocket: canlı mum. WebSocket kopunca 15 sn'de bir REST yoklaması.
 */
import type { BarsData } from "../pine/types";
import { intervalById } from "./intervals";
import type { DataSource, LiveBar, SymbolInfo } from "./source";

interface Endpoints {
  name: "futures" | "spot";
  label: string;
  rest: string;
  klines: string;
  ticker: string;
  ws: string;
  maxLimit: number;
}

export const FUTURES: Endpoints = {
  name: "futures",
  label: "Binance vadeli (USDT-M)",
  rest: "https://fapi.binance.com",
  klines: "/fapi/v1/klines",
  ticker: "/fapi/v1/ticker/24hr",
  ws: "wss://fstream.binance.com/ws",
  maxLimit: 1500,
};

export const SPOT: Endpoints = {
  name: "spot",
  label: "Binance spot",
  rest: "https://data-api.binance.vision",
  klines: "/api/v3/klines",
  ticker: "/api/v3/ticker/24hr",
  ws: "wss://data-stream.binance.vision/ws",
  maxLimit: 1000,
};

async function getJson(url: string, timeoutMs = 12_000): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = (await r.json()) as { msg?: string };
        if (j?.msg) msg += `: ${j.msg}`;
      } catch {
        /* gövde yok */
      }
      throw new Error(msg);
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

function parseKlines(rows: RawKline[], symbol: string, tfSec: number): BarsData {
  const N = rows.length;
  const b: BarsData = {
    time: new Float64Array(N),
    open: new Float64Array(N),
    high: new Float64Array(N),
    low: new Float64Array(N),
    close: new Float64Array(N),
    volume: new Float64Array(N),
    tfSec,
    symbol,
    lastRealtime: false,
  };
  for (let i = 0; i < N; i++) {
    const r = rows[i]!;
    b.time[i] = r[0];
    b.open[i] = +r[1];
    b.high[i] = +r[2];
    b.low[i] = +r[3];
    b.close[i] = +r[4];
    b.volume[i] = +r[5];
  }
  if (N) b.lastRealtime = rows[N - 1]![6] >= Date.now();
  return b;
}

export class BinanceSource implements DataSource {
  constructor(private readonly ep: Endpoints) {}

  get name(): string {
    return this.ep.name;
  }
  get label(): string {
    return this.ep.label;
  }

  async symbols(): Promise<SymbolInfo[]> {
    const rows = (await getJson(`${this.ep.rest}${this.ep.ticker}`)) as {
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
      quoteVolume: string;
    }[];
    return rows
      .filter((r) => r.symbol.endsWith("USDT") && !r.symbol.includes("_"))
      .map((r) => ({
        symbol: r.symbol,
        price: +r.lastPrice,
        changePct: +r.priceChangePercent,
        quoteVolume: +r.quoteVolume,
      }))
      .filter((r) => r.quoteVolume > 0)
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
  }

  async klines(symbol: string, interval: string, limit: number, endTime?: number): Promise<BarsData> {
    const iv = intervalById(interval);
    if (!iv) throw new Error(`Desteklenmeyen zaman dilimi: ${interval}`);
    const lim = Math.max(1, Math.min(this.ep.maxLimit, Math.floor(limit)));
    const q = new URLSearchParams({ symbol, interval, limit: String(lim) });
    if (endTime !== undefined) q.set("endTime", String(Math.floor(endTime)));
    const rows = (await getJson(`${this.ep.rest}${this.ep.klines}?${q}`)) as RawKline[];
    return parseKlines(rows, symbol, iv.sec);
  }

  subscribe(symbol: string, interval: string, onBar: (b: LiveBar) => void, onStatus?: (live: boolean) => void): () => void {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let poll: ReturnType<typeof setInterval> | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;

    const startPoll = () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          const b = await this.klines(symbol, interval, 2);
          const i = b.time.length - 1;
          if (i >= 0) {
            onBar({
              time: b.time[i]!,
              open: b.open[i]!,
              high: b.high[i]!,
              low: b.low[i]!,
              close: b.close[i]!,
              volume: b.volume[i]!,
              closed: !b.lastRealtime,
            });
          }
        } catch {
          /* bir sonraki yoklamada tekrar */
        }
      }, 15_000);
    };
    const stopPoll = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(`${this.ep.ws}/${symbol.toLowerCase()}@kline_${interval}`);
      } catch {
        onStatus?.(false);
        startPoll();
        return;
      }
      ws.onopen = () => {
        retry = 0;
        stopPoll();
        onStatus?.(true);
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as { k?: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } };
          const k = m.k;
          if (!k) return;
          onBar({ time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closed: k.x });
        } catch {
          /* bozuk ileti */
        }
      };
      ws.onclose = () => {
        onStatus?.(false);
        if (closed) return;
        startPoll();
        const delay = Math.min(30_000, 1000 * 2 ** retry++);
        reconnect = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      stopPoll();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }
}

/** Vadeli uçlar tarayıcıdan erişilebiliyorsa onları, değilse spotu seçer. */
export async function detectBinance(): Promise<BinanceSource> {
  const fut = new BinanceSource(FUTURES);
  try {
    await fut.klines("BTCUSDT", "1h", 1);
    return fut;
  } catch {
    const spot = new BinanceSource(SPOT);
    await spot.klines("BTCUSDT", "1h", 1); // bu da olmazsa hata yukarı çıkar
    return spot;
  }
}
