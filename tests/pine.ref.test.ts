/**
 * Yerleşik göstergeler ve kütüphane betikleri, bağımsız Python referansıyla (tools/make_fixtures.py) karşılaştırılır.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../src/pine";
import { LIBRARY } from "../src/pine/library";
import type { BarsData, PineOutput, RunResult } from "../src/pine/types";
import { resample, runWithData } from "./helpers";

interface Fixture {
  bars: { time: number[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[]; tfSec: number };
  ref: Record<string, (number | boolean | null)[]>;
}

const FX: Fixture = JSON.parse(readFileSync(new URL("./fixtures/reference.json", import.meta.url), "utf-8"));
const BARS: BarsData = {
  time: Float64Array.from(FX.bars.time),
  open: Float64Array.from(FX.bars.open),
  high: Float64Array.from(FX.bars.high),
  low: Float64Array.from(FX.bars.low),
  close: Float64Array.from(FX.bars.close),
  volume: Float64Array.from(FX.bars.volume),
  tfSec: FX.bars.tfSec,
  symbol: "BTCUSDT",
  lastRealtime: false,
};

function ok(r: RunResult): PineOutput {
  if (!r.ok) throw new Error(JSON.stringify("error" in r ? r.error : r.needData));
  return r.output;
}

function expectSeries(got: ArrayLike<number>, want: (number | boolean | null)[], name: string, tol = 1e-7): void {
  expect(got.length, name).toBe(want.length);
  let bad = 0;
  let first = -1;
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    const g = got[i]!;
    const same =
      w === null ? Number.isNaN(g) : !Number.isNaN(g) && Math.abs(g - Number(w)) <= tol * Math.max(1, Math.abs(Number(w)));
    if (!same) {
      bad++;
      if (first < 0) first = i;
    }
  }
  expect(bad, `${name}: ${bad} uyumsuz (ilk #${first}: ${got[first]} ≠ ${want[first]})`).toBe(0);
}

function plots(code: string, extra?: Record<string, BarsData>): Record<string, Float64Array> {
  const out = ok(run(code, BARS, { extra, timeLimitMs: 20_000 }));
  return Object.fromEntries(out.plots.map((p) => [p.title, p.values]));
}

describe("ta.* yerleşikleri referansla aynı", () => {
  const p = plots(`//@version=5
indicator("ref")
plot(ta.sma(close, 14), "sma14")
plot(ta.ema(close, 20), "ema20")
plot(ta.rma(close, 14), "rma14")
plot(ta.wma(close, 10), "wma10")
plot(ta.atr(14), "atr14")
plot(ta.rsi(close, 14), "rsi14")
[m, s, h] = ta.macd(close, 12, 26, 9)
plot(m, "macd")
plot(s, "macd_signal")
[b, u, l] = ta.bb(close, 20, 2)
plot(u, "bb_upper")
plot(ta.stdev(close, 20), "stdev20")
plot(ta.stoch(close, high, low, 14), "stoch14")
plot(ta.highest(close, 20), "highest20")
plot(ta.hma(close, 9), "hma9")
plot(ta.vwma(close, 20), "vwma20")
plot(ta.rsi(hlc3, 14), "hlc3_rsi")
[st, dir] = ta.supertrend(3.0, 10)
plot(st, "supertrend")
plot(dir, "supertrend_dir")`);
  for (const name of [
    "sma14", "ema20", "rma14", "wma10", "atr14", "rsi14", "macd", "macd_signal", "bb_upper", "stdev20", "stoch14",
    "highest20", "hma9", "vwma20", "hlc3_rsi", "supertrend", "supertrend_dir",
  ]) {
    it(name, () => expectSeries(p[name]!, FX.ref[name]!, name));
  }
});

describe("UT Bot Alerts", () => {
  it("kütüphane (v5) sürümü: iz, Al/Sat referansla birebir", () => {
    const code = LIBRARY.find((x) => x.id === "ut_bot")!.code;
    const out = ok(run(code, BARS));
    expectSeries(out.plots[0]!.values, FX.ref.ut_trail!, "ut_trail");
    const buys = out.shapes.find((s) => s.title === "Al")!.events.map((e) => e.bar);
    const sells = out.shapes.find((s) => s.title === "Sat")!.events.map((e) => e.bar);
    const want = (k: string) => FX.ref[k]!.flatMap((v, i) => (v ? [i] : []));
    expect(buys).toEqual(want("ut_buy"));
    expect(sells).toEqual(want("ut_sell"));
    expect(buys.length).toBeGreaterThan(10);
    expect(out.alerts.map((a) => a.title)).toEqual(["UT Long", "UT Short"]);
    expect(out.barcolors?.filter(Boolean).length).toBeGreaterThan(1000);
  });

  it("v4 tarzı betik (iff, security+heikinashi, satır devamı, transp) değiştirilmeden çalışır", () => {
    const v4 = `//@version=4
study(title="UT Bot v4 tarzı", overlay = true)
a = input(1,     title = "Key Value")
c = input(10,    title = "ATR Period")
h = input(false, title = "Signals from Heikin Ashi Candles")
xATR  = atr(c)
nLoss = a * xATR
src = h ? security(heikinashi(syminfo.tickerid), timeframe.period, close, lookahead = false) : close
xATRTrailingStop = 0.0
xATRTrailingStop := iff(src > nz(xATRTrailingStop[1], 0) and src[1] > nz(xATRTrailingStop[1], 0), max(nz(xATRTrailingStop[1]), src - nLoss),
   iff(src < nz(xATRTrailingStop[1], 0) and src[1] < nz(xATRTrailingStop[1], 0), min(nz(xATRTrailingStop[1]), src + nLoss),
   iff(src > nz(xATRTrailingStop[1], 0), src - nLoss, src + nLoss)))
pos = 0
pos := iff(src[1] < nz(xATRTrailingStop[1], 0) and src > nz(xATRTrailingStop[1], 0), 1,
   iff(src[1] > nz(xATRTrailingStop[1], 0) and src < nz(xATRTrailingStop[1], 0), -1, nz(pos[1], 0)))
xcolor = pos == -1 ? color.red: pos == 1 ? color.green : color.blue
ema   = ema(src,1)
above = crossover(ema, xATRTrailingStop)
below = crossover(xATRTrailingStop, ema)
buy  = src > xATRTrailingStop and above
sell = src < xATRTrailingStop and below
barbuy  = src > xATRTrailingStop
barsell = src < xATRTrailingStop
plotshape(buy,  title = "Buy",  text = 'Buy',  style = shape.labelup,   location = location.belowbar, color= color.green, textcolor = color.white, transp = 0, size = size.tiny)
plotshape(sell, title = "Sell", text = 'Sell', style = shape.labeldown, location = location.abovebar, color= color.red,   textcolor = color.white, transp = 0, size = size.tiny)
barcolor(barbuy  ? color.green : na)
barcolor(barsell ? color.red   : na)
alertcondition(buy,  "UT Long",  "UT Long")
alertcondition(sell, "UT Short", "UT Short")`;
    const out = ok(run(v4, BARS));
    const want = (k: string) => FX.ref[k]!.flatMap((v, i) => (v ? [i] : []));
    expect(out.shapes.find((s) => s.title === "Buy")!.events.map((e) => e.bar)).toEqual(want("ut_buy"));
    expect(out.shapes.find((s) => s.title === "Sell")!.events.map((e) => e.bar)).toEqual(want("ut_sell"));
    expect(out.inputs.map((i) => i.type)).toEqual(["int", "int", "bool"]);
  });

  it("Heikin Ashi açıkken veri ister, verilince çalışır", () => {
    const code = LIBRARY.find((x) => x.id === "ut_bot")!.code;
    const r = run(code, BARS, { inputs: { "Heikin Ashi mumlarından sinyal": true } });
    expect(r.ok).toBe(false);
    if (!r.ok && "needData" in r) expect(r.needData).toEqual([{ symbol: "BTCUSDT", tfSec: 3600, heikinAshi: true }]);
    const ha = heikinAshi(BARS);
    const out = ok(run(code, BARS, { inputs: { "Heikin Ashi mumlarından sinyal": true }, extra: { "BTCUSDT|3600|HA": ha } }));
    expect(out.shapes[0]!.events.length).toBeGreaterThan(5);
  });
});

describe("EMA Trend 4s (botun sistemi)", () => {
  it("4s EMA'lar (kapanmış mum, lookahead + [1]) referansla birebir", () => {
    const code = LIBRARY.find((x) => x.id === "ema_trend_4h")!.code;
    const h4 = resample(BARS, 14400);
    const first = run(code, BARS);
    expect(first.ok).toBe(false);
    if (!first.ok && "needData" in first) expect(first.needData).toEqual([{ symbol: "BTCUSDT", tfSec: 14400, heikinAshi: false }]);
    const out = ok(run(code, BARS, { extra: { "BTCUSDT|14400|": h4 } }));
    const fast = out.plots.find((p) => p.title === "EMA hızlı (4s)")!.values;
    const slow = out.plots.find((p) => p.title === "EMA yavaş (4s)")!.values;
    expectSeries(fast, FX.ref.ema_fast_4h!, "ema_fast_4h");
    expectSeries(slow, FX.ref.ema_slow_4h!, "ema_slow_4h");
    const al = out.shapes.find((s) => s.title === "AL")!.events.length;
    const sat = out.shapes.find((s) => s.title === "SAT")!.events.length;
    expect(al + sat).toBeGreaterThan(2);
    expect(out.warnings.some((w) => w.includes("Çizim"))).toBe(true); // bilgi tablosu yok sayıldı
  });
});

describe("kütüphanedeki tüm betikler hatasız çalışır", () => {
  for (const item of LIBRARY) {
    it(item.name, () => {
      const out = ok(runWithData(item.code, BARS));
      expect(out.plots.length + out.shapes.length).toBeGreaterThan(0);
      expect(out.stats.ms).toBeLessThan(3000);
    });
  }
});

function heikinAshi(b: BarsData): BarsData {
  const N = b.time.length;
  const o = new Float64Array(N);
  const c = new Float64Array(N);
  const h = new Float64Array(N);
  const l = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    c[i] = (b.open[i]! + b.high[i]! + b.low[i]! + b.close[i]!) / 4;
    o[i] = i === 0 ? (b.open[i]! + b.close[i]!) / 2 : (o[i - 1]! + c[i - 1]!) / 2;
    h[i] = Math.max(b.high[i]!, o[i]!, c[i]!);
    l[i] = Math.min(b.low[i]!, o[i]!, c[i]!);
  }
  return { ...b, open: o, high: h, low: l, close: c };
}
