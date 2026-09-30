/**
 * Kütüphane stratejileri bağımsız bir simülasyonla karşılaştırılır: sinyaller referansla doğrulanmış indikatör
 * çıktılarından (UT Bot Al/Sat, EMA/ATR) alınır, emir/işlem hesabı testte ayrıca yazılmıştır.
 */
import { describe, expect, it } from "vitest";
import { run } from "../src/pine";
import { LIBRARY } from "../src/pine/library";
import type { BarsData, PineOutput, RunResult, StrategyOut } from "../src/pine/types";
import { randomBars, resample } from "./helpers";

function ok(r: RunResult): PineOutput {
  if (!r.ok) throw new Error(JSON.stringify("error" in r ? r.error : r.needData));
  return r.output;
}

const code = (id: string) => LIBRARY.find((x) => x.id === id)!.code;

interface SimTrade {
  dir: number;
  entryBar: number;
  entryPrice: number;
  exitBar: number;
  exitPrice: number;
  profit: number;
}

/** Basit hesap: özsermayenin %100'ü, %0,05 komisyon, emir sonraki açılışta. */
class Sim {
  net = 0;
  trade: { dir: number; qty: number; entry: number; comm: number; bar: number; stop: number } | null = null;
  closed: SimTrade[] = [];
  constructor(
    readonly b: BarsData,
    readonly cap = 1000,
    readonly rate = 0.0005,
  ) {}
  eqAt(p: number): number {
    const t = this.trade;
    return this.cap + this.net + (t ? t.dir * (p - t.entry) * t.qty - t.comm : 0);
  }
  qtyAt(i: number): number {
    return this.eqAt(this.b.close[i]!) / this.b.close[i]!;
  }
  close(i: number, px: number): void {
    const t = this.trade!;
    const pnl = t.dir * (px - t.entry) * t.qty - t.comm - t.qty * px * this.rate;
    this.net += pnl;
    this.closed.push({ dir: t.dir, entryBar: t.bar, entryPrice: t.entry, exitBar: i, exitPrice: px, profit: pnl });
    this.trade = null;
  }
  open(i: number, dir: number, qty: number, px: number, stop = Number.NaN): void {
    this.trade = { dir, qty, entry: px, comm: qty * px * this.rate, bar: i, stop };
  }
}

function expectSame(s: StrategyOut, sim: Sim): void {
  expect(s.trades.length).toBe(sim.closed.length);
  s.trades.forEach((t, k) => {
    const w = sim.closed[k]!;
    expect([t.dir, t.entryBar, t.exitBar]).toEqual([w.dir, w.entryBar, w.exitBar]);
    expect(t.entryPrice).toBeCloseTo(w.entryPrice, 9);
    expect(t.exitPrice).toBeCloseTo(w.exitPrice, 9);
    expect(t.profit).toBeCloseTo(w.profit, 6);
  });
  expect(s.all.netProfit).toBeCloseTo(sim.net, 6);
}

describe("UT Bot Strateji", () => {
  const B = randomBars(3000, 7);

  it("işlemler UT Bot Al/Sat sinyalleriyle birebir (ters yöne geçme, sonraki açılış)", () => {
    const ind = ok(run(code("ut_bot"), B));
    const buys = new Set(ind.shapes.find((s) => s.title === "Al")!.events.map((e) => e.bar));
    const sells = new Set(ind.shapes.find((s) => s.title === "Sat")!.events.map((e) => e.bar));
    expect(buys.size).toBeGreaterThan(20);

    const sim = new Sim(B);
    let pending: { dir: number; qty: number } | null = null;
    for (let i = 0; i < B.time.length; i++) {
      if (pending) {
        const px = B.open[i]!;
        if (!(sim.trade && sim.trade.dir === pending.dir)) {
          if (sim.trade) sim.close(i, px);
          sim.open(i, pending.dir, pending.qty, px);
        }
        pending = null;
      }
      const sig = buys.has(i) ? 1 : sells.has(i) ? -1 : 0;
      if (sig) pending = { dir: sig, qty: sim.qtyAt(i) };
    }

    const out = ok(run(code("ut_bot_strategy"), B));
    const s = out.strategy!;
    expectSame(s, sim);
    expect(s.openTrades).toHaveLength(sim.trade ? 1 : 0);
    expect(s.props).toMatchObject({ initialCapital: 1000, qtyType: "percent_of_equity", qtyValue: 100, commissionValue: 0.05 });
  });

  it("yalnız long: Sat sinyali yalnız kapatır", () => {
    const out = ok(run(code("ut_bot_strategy"), B, { inputs: { "İşlem yönü": "Yalnız long" } }));
    const s = out.strategy!;
    expect(s.trades.length).toBeGreaterThan(5);
    expect(s.trades.every((t) => t.dir === 1)).toBe(true);
    expect(s.short.trades).toBe(0);
  });

  it("5000 mumda hızlı", () => {
    const big = randomBars(5000, 11);
    const t0 = performance.now();
    const out = ok(run(code("ut_bot_strategy"), big));
    const ms = performance.now() - t0;
    expect(out.strategy!.trades.length).toBeGreaterThan(50);
    expect(ms).toBeLessThan(1500);
  });
});

describe("EMA Trend 4s Strateji (bot sistemi)", () => {
  const H1 = randomBars(4800, 5, 3600, Date.UTC(2025, 0, 1));
  const H4 = resample(H1, 14400);

  it("4s grafikte: sinyal değişiminde giriş/ters çevirme, giriş ± 3×ATR stop", () => {
    const ind = ok(
      run(`indicator("x")\nplot(ta.ema(close, 20))\nplot(ta.ema(close, 100))\nplot(ta.atr(14))`, H4),
    );
    const [fast, slow, atr] = ind.plots.map((p) => p.values);
    const state = (i: number) => (fast![i]! > slow![i]! ? 1 : fast![i]! < slow![i]! ? -1 : 0);

    const sim = new Sim(H4);
    let pending: { dir: number; qty: number; atr: number } | "close_all" | null = null;
    for (let i = 0; i < H4.time.length; i++) {
      const o = H4.open[i]!;
      if (pending === "close_all") {
        if (sim.trade) sim.close(i, o);
      } else if (pending) {
        if (sim.trade && sim.trade.dir === -pending.dir) sim.close(i, o);
        if (!sim.trade) sim.open(i, pending.dir, pending.qty, o, o - pending.dir * 3 * pending.atr);
      }
      pending = null;
      const t = sim.trade;
      if (t) {
        const beyondOpen = t.dir > 0 ? H4.open[i]! <= t.stop : H4.open[i]! >= t.stop;
        const hit = t.dir > 0 ? H4.low[i]! <= t.stop : H4.high[i]! >= t.stop;
        if (t.bar < i && beyondOpen) sim.close(i, H4.open[i]!);
        else if (hit) sim.close(i, t.stop);
      }
      const st = state(i);
      const prev = i > 0 ? state(i - 1) : st;
      if (st !== prev) {
        if (st !== 0 && !Number.isNaN(atr![i]!)) pending = { dir: st, qty: sim.qtyAt(i), atr: atr![i]! };
        else if (st === 0 && sim.trade) pending = "close_all";
      }
    }

    const s = ok(run(code("ema_trend_4h_strategy"), H4)).strategy!;
    expect(sim.closed.length).toBeGreaterThan(5);
    expect(sim.closed.some((t) => t.exitPrice !== H4.open[t.exitBar])).toBe(true); // stop çalışmış işlemler var
    expectSame(s, sim);
  });

  it("1s grafikte girişler 4s grafikteki girişlerle aynı zamanda ve fiyatta", () => {
    const on4 = ok(run(code("ema_trend_4h_strategy"), H4)).strategy!;
    const on1 = ok(run(code("ema_trend_4h_strategy"), H1, { extra: { "BTCUSDT|14400|": H4 } })).strategy!;
    const entries = (s: StrategyOut) => [...s.trades, ...s.openTrades].map((t) => [t.entryTime, +t.entryPrice.toFixed(9), t.dir]);
    expect(entries(on4).length).toBeGreaterThan(5);
    expect(entries(on1)).toEqual(entries(on4));
  });
});
