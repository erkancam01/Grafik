import { describe, expect, it } from "vitest";
import { run } from "../src/pine";
import { LIBRARY } from "../src/pine/library";
import type { PineOutput, RunResult } from "../src/pine/types";
import { randomBars, resample, runWithData } from "./helpers";

function ok(r: RunResult): PineOutput {
  if (!r.ok) throw new Error(JSON.stringify("error" in r ? r.error : r.needData));
  return r.output;
}

const H1 = randomBars(48, 3, 3600, Date.UTC(2026, 0, 1));
const H4 = resample(H1, 14400);
const EXTRA = { "BTCUSDT|14400|": H4 };

describe("request.security anlamı", () => {
  it("lookahead_off: üst mum yalnız kapandığı mumda görünür", () => {
    const code = `indicator("t")\nplot(request.security(syminfo.tickerid, "240", close))`;
    const v = ok(run(code, H1, { extra: EXTRA })).plots[0]!.values;
    // 00:00-03:00 saatlik mumlar: ilk 4s mum henüz kapanmadı → na; 03:00 mumu kapanışta 4s kapanışı
    expect(Number.isNaN(v[0]!)).toBe(true);
    expect(Number.isNaN(v[2]!)).toBe(true);
    expect(v[3]).toBe(H4.close[0]);
    expect(v[4]).toBe(H4.close[0]);
    expect(v[7]).toBe(H4.close[1]);
  });

  it("lookahead_on + [1]: yeni 4s mumun başından itibaren önceki kapanmış mum (bakış-ileri yok)", () => {
    const code = `indicator("t")\nplot(request.security(syminfo.tickerid, "240", close[1], lookahead = barmerge.lookahead_on))`;
    const v = ok(run(code, H1, { extra: EXTRA })).plots[0]!.values;
    expect(Number.isNaN(v[3]!)).toBe(true);
    expect(v[4]).toBe(H4.close[0]);
    expect(v[7]).toBe(H4.close[0]);
    expect(v[8]).toBe(H4.close[1]);
  });

  it("gaps_on: değer yalnız üst mumun ilk göründüğü mumda", () => {
    const code = `indicator("t")\nplot(request.security(syminfo.tickerid, "240", close, gaps = barmerge.gaps_on))`;
    const v = ok(run(code, H1, { extra: EXTRA })).plots[0]!.values;
    expect(v[3]).toBe(H4.close[0]);
    expect(Number.isNaN(v[4]!)).toBe(true);
  });

  it("genel değişkenler üst zaman diliminde yeniden hesaplanır; := ile değişen açık hata verir", () => {
    const code = `indicator("t")
len = input.int(3, "L")
src = close
e = request.security(syminfo.tickerid, "240", ta.sma(src, len))
plot(e)`;
    const v = ok(run(code, H1, { extra: EXTRA })).plots[0]!.values;
    const sma3 = (H4.close[0]! + H4.close[1]! + H4.close[2]!) / 3;
    expect(v[11]).toBeCloseTo(sma3, 10);
    const bad = run(`indicator("t")\nx = close\nx := x * 2\nplot(request.security(syminfo.tickerid, "240", x))`, H1, { extra: EXTRA });
    expect(bad.ok).toBe(false);
    if (!bad.ok && "error" in bad) expect(bad.error.message).toContain("request.security");
  });

  it("başka sembol ve demet ifadesi; eksik veri isteği toplanır", () => {
    const code = `indicator("t")
[a, b] = request.security("BINANCE:ETHUSDT.P", "D", [open, close])
c = request.security("SOLUSDT", "60", close)
plot(a)
plot(c)`;
    const r = run(code, H1);
    expect(r.ok).toBe(false);
    if (!r.ok && "needData" in r) {
      expect(r.needData).toEqual([
        { symbol: "ETHUSDT", tfSec: 86400, heikinAshi: false },
        { symbol: "SOLUSDT", tfSec: 3600, heikinAshi: false },
      ]);
    }
    const eth = { ...resample(H1, 86400), symbol: "ETHUSDT" };
    const sol = { ...H1, symbol: "SOLUSDT" };
    const out = ok(run(code, H1, { extra: { "ETHUSDT|86400|": eth, "SOLUSDT|3600|": sol } }));
    expect(out.plots[0]!.values[23]).toBe(eth.open[0]);
    expect(out.plots[1]!.values[5]).toBe(sol.close[5]);
  });
});

describe("performans", () => {
  it("UT Bot 5000 mumda hızlı", () => {
    const big = randomBars(5000, 9, 900);
    const code = LIBRARY.find((x) => x.id === "ut_bot")!.code;
    const t0 = performance.now();
    const out = ok(run(code, big));
    const ms = performance.now() - t0;
    expect(out.stats.bars).toBe(5000);
    expect(ms).toBeLessThan(1500);
  });

  it("tüm kütüphane 5000 mumda makul sürede", () => {
    const big = randomBars(5000, 5, 900);
    const t0 = performance.now();
    for (const item of LIBRARY) ok(runWithData(item.code, big));
    expect(performance.now() - t0).toBeLessThan(6000);
  });
});
