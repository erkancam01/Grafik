/**
 * İndikatör hesaplama akışı: betiği çalıştır → request.security veri isterse getir → yeniden çalıştır.
 * Ek veri önbelleği canlı akışta tazelenir.
 */
import { intervalBySec, supportedTfList } from "../data/intervals";
import { heikinAshi, mergeBars, type DataSource } from "../data/source";
import type { BarsData, DataRequest, PineOutput, RunResult } from "../pine/types";
import { dataKey } from "../pine/types";

export interface Runner {
  run(code: string, bars: BarsData, inputs: Record<string, unknown>, extra: Record<string, BarsData>): Promise<RunResult>;
}

export type IndicatorResult =
  | { ok: true; output: PineOutput }
  | { ok: false; error: { message: string; line: number; col: number; kind: string } };

const MAX_BARS = 5000;

/** Geriye doğru sayfalayarak en çok `count` mum getirir. */
export async function loadHistory(
  src: DataSource,
  symbol: string,
  interval: string,
  count: number,
  endTime?: number,
): Promise<BarsData> {
  let out: BarsData | null = null;
  let end = endTime;
  let left = Math.min(count, MAX_BARS);
  while (left > 0) {
    const page = Math.min(left, 1000);
    const b = await src.klines(symbol, interval, page, end);
    out = out ? mergeBars(b, out) : b;
    if (b.time.length < page || b.time.length === 0) break;
    left -= b.time.length;
    end = b.time[0]! - 1;
  }
  return out!;
}

interface CacheEntry {
  bars: BarsData;
  fetchedAt: number;
  wanted: number;
}

export class ExtraData {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly src: DataSource) {}

  clear(): void {
    this.cache.clear();
  }

  async get(req: DataRequest, main: BarsData): Promise<BarsData> {
    const iv = intervalBySec(req.tfSec);
    if (!iv) {
      throw new Error(`request.security: bu zaman dilimi desteklenmiyor (${req.tfSec} sn). Desteklenen: ${supportedTfList()}`);
    }
    const key = `${dataKey(req)}`;
    const n = main.time.length;
    const span = n ? main.time[n - 1]! - main.time[0]! + main.tfSec * 1000 : 0;
    const want = Math.min(MAX_BARS, Math.ceil(span / (req.tfSec * 1000)) + (req.tfSec >= main.tfSec ? 400 : 0));
    const hit = this.cache.get(key);
    let base: BarsData;
    if (hit && hit.wanted >= want) {
      base = hit.bars;
      if (Date.now() - hit.fetchedAt > 30_000) {
        const fresh = await this.src.klines(req.symbol, iv.id, 3);
        base = mergeBars(base, fresh);
        this.cache.set(key, { bars: base, fetchedAt: Date.now(), wanted: hit.wanted });
      }
    } else {
      base = await loadHistory(this.src, req.symbol, iv.id, Math.max(2, want));
      this.cache.set(key, { bars: base, fetchedAt: Date.now(), wanted: want });
    }
    return req.heikinAshi ? heikinAshi(base) : base;
  }
}

export async function computeIndicator(
  runner: Runner,
  extraData: ExtraData,
  code: string,
  main: BarsData,
  inputs: Record<string, unknown>,
): Promise<IndicatorResult> {
  const extra: Record<string, BarsData> = {};
  for (let round = 0; round < 5; round++) {
    const r = await runner.run(code, main, inputs, extra);
    if (r.ok) return r;
    if ("error" in r) return r;
    for (const req of r.needData) {
      const k = dataKey(req);
      if (extra[k]) continue;
      try {
        extra[k] = await extraData.get(req, main);
      } catch (e) {
        return {
          ok: false,
          error: { message: e instanceof Error ? e.message : String(e), line: 0, col: 0, kind: "data" },
        };
      }
    }
  }
  return { ok: false, error: { message: "request.security verisi getirilemedi", line: 0, col: 0, kind: "data" } };
}
