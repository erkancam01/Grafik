import { describe, expect, it } from "vitest";
import { run } from "../src/pine";
import type { BarsData, PineOutput, RunResult, StrategyOut } from "../src/pine/types";
import { barsFromCloses } from "./helpers";

function ok(r: RunResult): PineOutput {
  if (!r.ok) throw new Error(JSON.stringify("error" in r ? r.error : r.needData));
  return r.output;
}

/** Açık OHLC satırlarından mumlar (fiyat adımı 0,01). */
function ohlc(rows: [number, number, number, number][], lastRealtime = false): BarsData {
  const N = rows.length;
  const b: BarsData = {
    time: Float64Array.from(rows, (_, i) => Date.UTC(2026, 0, 1) + i * 3600_000),
    open: Float64Array.from(rows, (r) => r[0]),
    high: Float64Array.from(rows, (r) => r[1]),
    low: Float64Array.from(rows, (r) => r[2]),
    close: Float64Array.from(rows, (r) => r[3]),
    volume: new Float64Array(N).fill(100),
    tfSec: 3600,
    symbol: "BTCUSDT",
    lastRealtime,
    mintick: 0.01,
  };
  return b;
}

/** Düz mumlar: açılış = kapanış = p, yüksek/düşük ±0,5. */
function flat(prices: number[]): [number, number, number, number][] {
  return prices.map((p) => [p, p + 0.5, p - 0.5, p]);
}

function strat(code: string, bars: BarsData, inputs?: Record<string, unknown>): { out: PineOutput; s: StrategyOut } {
  const out = ok(run(code, bars, { inputs }));
  if (!out.strategy) throw new Error("strateji çıktısı yok");
  return { out, s: out.strategy };
}

const plotVals = (out: PineOutput, i = 0) => [...out.plots[i]!.values].map((v) => (Number.isNaN(v) ? null : +v.toFixed(8)));

describe("strateji: piyasa emirleri", () => {
  it("emir bir sonraki mumun açılışında dolar; pozisyon betiğe o mumda görünür", () => {
    const code = `//@version=5
strategy("t", overlay = true, initial_capital = 1000)
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 3
    strategy.close("L")
plot(strategy.position_size)
plot(strategy.position_size[1])`;
    const { out, s } = strat(code, ohlc(flat([100, 101, 102, 103, 104, 105])));
    expect(plotVals(out, 0)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(plotVals(out, 1)).toEqual([null, 0, 0, 1, 1, 0]);
    expect(s.trades).toHaveLength(1);
    const t = s.trades[0]!;
    expect([t.entryBar, t.entryPrice, t.exitBar, t.exitPrice, t.qty]).toEqual([2, 102, 4, 104, 1]);
    expect(t.profit).toBeCloseTo(2, 10);
    expect(s.all.netProfit).toBeCloseTo(2, 10);
    expect(s.finalEquity).toBeCloseTo(1002, 10);
    // grafikte işaretçiler: giriş (alış, mum altı) ve çıkış (satış, mum üstü)
    const fills = out.shapes.find((x) => x.id === "strategy_fills")!;
    expect(fills.overlay).toBe(true);
    expect(fills.events.map((e) => [e.bar, e.location, e.text])).toEqual([
      [2, "belowbar", "L"],
      [4, "abovebar", "Kapat"],
    ]);
  });

  it("process_orders_on_close: aynı mumun kapanışında dolar", () => {
    const code = `strategy("t", process_orders_on_close = true)
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 3
    strategy.close("L")`;
    const { s } = strat(code, ohlc([[100, 101, 99, 100.5], [101, 102, 100, 101.5], [102, 103, 101, 102.5], [103, 104, 102, 103.5], [104, 105, 103, 104.5]]));
    const t = s.trades[0]!;
    expect([t.entryBar, t.entryPrice, t.exitBar, t.exitPrice]).toEqual([1, 101.5, 3, 103.5]);
  });

  it("strategy.close(immediately = true) kapanışta dolar", () => {
    const code = `strategy("t")
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 3
    strategy.close("L", immediately = true)`;
    const { s } = strat(code, ohlc([[100, 101, 99, 100.5], [101, 102, 100, 101.5], [102, 103, 101, 102.5], [103, 104, 102, 103.5], [104, 105, 103, 104.5]]));
    expect([s.trades[0]!.entryPrice, s.trades[0]!.exitBar, s.trades[0]!.exitPrice]).toEqual([102, 3, 103.5]);
  });

  it("ters yönde giriş pozisyonu çevirir", () => {
    const code = `strategy("t")
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 3
    strategy.entry("S", strategy.short)
plot(strategy.position_size)`;
    const { out, s } = strat(code, ohlc(flat([100, 101, 102, 103, 104, 105])));
    expect(plotVals(out)).toEqual([0, 0, 1, 1, -1, -1]);
    expect(s.trades).toHaveLength(1);
    expect(s.trades[0]!.exitId).toBe("S");
    expect(s.trades[0]!.profit).toBeCloseTo(2, 10);
    expect(s.openTrades).toHaveLength(1);
    expect(s.openTrades[0]!.dir).toBe(-1);
    expect(s.openTrades[0]!.entryPrice).toBe(104);
    expect(s.openTrades[0]!.profit).toBeCloseTo(-1, 10); // 104 → son kapanış 105
    expect(s.openProfit).toBeCloseTo(-1, 10);
  });

  it("pyramiding aynı yöndeki giriş sayısını sınırlar", () => {
    const code = (p: number) => `strategy("t", pyramiding = ${p})
strategy.entry("L", strategy.long)
plot(strategy.opentrades)`;
    const bars = ohlc(flat([100, 101, 102, 103, 104, 105]));
    expect(plotVals(strat(code(0), bars).out)).toEqual([0, 1, 1, 1, 1, 1]);
    expect(plotVals(strat(code(3), bars).out)).toEqual([0, 1, 2, 3, 3, 3]);
  });

  it("aynı mumda kapat + yeniden gir: kapanış önce işlenir", () => {
    const code = `strategy("t")
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 3
    strategy.close("L")
    strategy.entry("L", strategy.long)
plot(strategy.position_size)`;
    const { out, s } = strat(code, ohlc(flat([100, 101, 102, 103, 104, 105])));
    expect(plotVals(out)).toEqual([0, 0, 1, 1, 1, 1]);
    expect(s.trades).toHaveLength(1);
    expect(s.openTrades[0]!.entryPrice).toBe(104);
  });
});

describe("strateji: limit / stop ve mum içi yol", () => {
  it("stop giriş: mum içinde seviyeden, boşlukta açılıştan dolar", () => {
    const code = `strategy("t")
if bar_index == 0
    strategy.entry("A", strategy.long, stop = 105)
if bar_index == 2
    strategy.entry("B", strategy.long, stop = 105)`;
    const rows: [number, number, number, number][] = [
      [100, 101, 99, 100],
      [100, 106, 99, 104], // A: 105'ten dolar
      [104, 104.5, 103, 104],
      [107, 108, 106, 107], // B: boşluk → 107
    ];
    const { s } = strat(`${code}\nif bar_index == 1\n    strategy.close("A", immediately = true)`, ohlc(rows));
    expect(s.trades[0]!.entryPrice).toBe(105);
    expect(s.openTrades[0]!.entryId).toBe("B");
    expect(s.openTrades[0]!.entryPrice).toBe(107);
  });

  it("limit giriş: fiyat seviyeye inince dolar, dolana kadar bekler", () => {
    const code = `strategy("t")
if bar_index == 0
    strategy.entry("L", strategy.long, limit = 95)`;
    const { s } = strat(code, ohlc([[100, 101, 99, 100], [100, 101, 97, 98], [98, 99, 94, 96], [96, 97, 95.5, 96]]));
    expect(s.openTrades[0]!.entryBar).toBe(2);
    expect(s.openTrades[0]!.entryPrice).toBe(95);
  });

  it("çıkış kümesi: yola göre önce stop ya da önce kâr al; giriş mumunda da çalışır", () => {
    const code = `strategy("t")
if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("X", "L", stop = 95, limit = 110)`;
    // düşük açılışa daha yakın → açılış → düşük → yüksek: önce stop
    const lowFirst = strat(code, ohlc([[100, 100.5, 99.5, 100], [100, 111, 94, 100]])).s;
    expect([lowFirst.trades[0]!.exitBar, lowFirst.trades[0]!.exitPrice, lowFirst.trades[0]!.exitId]).toEqual([1, 95, "X"]);
    // yüksek açılışa daha yakın → açılış → yüksek → düşük: önce kâr al
    const highFirst = strat(code, ohlc([[100, 100.5, 99.5, 100], [100, 111, 85, 100]])).s;
    expect([highFirst.trades[0]!.exitBar, highFirst.trades[0]!.exitPrice]).toEqual([1, 110]);
  });

  it("profit/loss tik cinsinden giriş fiyatına göre; stop boşlukta açılıştan", () => {
    const code = `strategy("t")
if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("X", "L", profit = 1000, loss = 500)`;
    // giriş 100 → kâr al 110, stop 95; ikinci mum 93'ten açılıyor (boşluk) → 93
    const { s } = strat(code, ohlc([[100, 100.5, 99.5, 100], [100, 101, 99, 100], [93, 94, 92, 93]]));
    expect([s.trades[0]!.exitBar, s.trades[0]!.exitPrice]).toEqual([2, 93]);
    expect(s.trades[0]!.profit).toBeCloseTo(-7, 10);
  });

  it("iz süren stop: en iyi fiyattan offset geride dolar", () => {
    const code = `strategy("t")
if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("T", "L", trail_points = 0, trail_offset = 200)`;
    // açılış 100 → 99,5 → 110 → 107: en iyi 110, stop 108
    const { s } = strat(code, ohlc([[100, 100.5, 99.5, 100], [100, 110, 99.5, 107]]));
    expect([s.trades[0]!.exitBar, s.trades[0]!.exitPrice]).toEqual([1, 108]);
  });

  it("iz süren stop durumu mumlar arasında korunur (her mumda yeniden çağrılsa da)", () => {
    const code = `strategy("t")
if bar_index == 0
    strategy.entry("L", strategy.long)
strategy.exit("T", "L", trail_price = 105, trail_offset = 300)`;
    // 1. mum 106'ya çıkar (etkin, en iyi 106 → stop 103), 2. mum 104'e iner (dolmaz), 3. mum 102,5 → 103
    const rows: [number, number, number, number][] = [
      [100, 100.5, 99.5, 100],
      [100, 106, 99.8, 105],
      [105, 105.2, 104, 104.5],
      [104.5, 104.6, 102.5, 103],
    ];
    const { s } = strat(code, ohlc(rows));
    expect([s.trades[0]!.exitBar, s.trades[0]!.exitPrice]).toEqual([3, 103]);
  });

  it("kısmi kâr al: TP1 %50 bir kez, TP2 kalanı kapatır", () => {
    const code = `strategy("t")
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if strategy.position_size > 0 or bar_index == 0
    strategy.exit("TP1", "L", qty_percent = 50, limit = 105)
    strategy.exit("TP2", "L", limit = 110)`;
    const rows: [number, number, number, number][] = [
      [100, 100.5, 99.5, 100],
      [100, 106, 99.8, 105.5], // TP1: 1 adet @105
      [105.5, 106, 105, 105.5], // TP1 yeniden çağrılsa da tekrar dolmaz
      [105.5, 111, 105, 110.5], // TP2: 1 adet @110
    ];
    const { s } = strat(code, ohlc(rows));
    expect(s.trades.map((t) => [t.exitId, t.exitBar, t.qty, t.exitPrice])).toEqual([
      ["TP1", 1, 1, 105],
      ["TP2", 3, 1, 110],
    ]);
    expect(s.openTrades).toHaveLength(0);
  });

  it("pozisyon kapanınca ona bağlı çıkış emri iptal olur", () => {
    const code = `strategy("t")
if bar_index == 0
    strategy.entry("L", strategy.long)
    strategy.exit("X", "L", stop = 90)
if bar_index == 1
    strategy.close("L")
if bar_index == 3
    strategy.entry("L", strategy.long)`;
    const rows = flat([100, 100, 100, 100, 100, 89, 89]);
    const { s } = strat(code, ohlc(rows));
    // ikinci giriş (4. mum) eski stop'a bağlanmaz: 5. mumda 89'a düşse de açık kalır
    expect(s.trades).toHaveLength(1);
    expect(s.openTrades).toHaveLength(1);
  });
});

describe("strateji: miktar, komisyon, istatistik", () => {
  it("özsermaye yüzdesi: miktar emrin verildiği mumun kapanışı ve özsermayesiyle", () => {
    const code = `strategy("t", initial_capital = 1000, default_qty_type = strategy.percent_of_equity, default_qty_value = 50)
if bar_index == 1
    strategy.entry("L", strategy.long)`;
    const { s } = strat(code, ohlc(flat([100, 125, 130])));
    expect(s.openTrades[0]!.qty).toBeCloseTo(4, 10); // 1000 × %50 / 125
  });

  it("nakit miktar ve yüzde komisyon", () => {
    const code = `strategy("t", default_qty_type = strategy.cash, default_qty_value = 500, commission_type = strategy.commission.percent, commission_value = 0.1)
if bar_index == 0
    strategy.entry("L", strategy.long)
if bar_index == 1
    strategy.close("L")`;
    const { s } = strat(code, ohlc(flat([100, 100, 110])));
    const t = s.trades[0]!;
    expect(t.qty).toBeCloseTo(5, 10);
    expect(t.commission).toBeCloseTo(0.5 + 0.55, 10);
    expect(t.profit).toBeCloseTo(50 - 1.05, 10);
    expect(s.all.commission).toBeCloseTo(1.05, 10);
  });

  it("istatistikler: kazanma oranı, kâr faktörü, ardışık kayıp, yön ayrımı", () => {
    const code = `strategy("t")
if bar_index % 2 == 0
    strategy.entry(bar_index % 4 == 0 ? "L" : "S", bar_index % 4 == 0 ? strategy.long : strategy.short)
if bar_index % 2 == 1
    strategy.close_all()`;
    // L: 100→104 (+4), S: 104→103 (+1), L: 103→101 (-2), S: 101→106 (-5)
    const { s } = strat(code, ohlc(flat([100, 100, 104, 104, 103, 103, 101, 101, 106, 106])));
    expect(s.trades.map((t) => +t.profit.toFixed(8))).toEqual([4, 1, -2, -5]);
    expect(s.all.trades).toBe(4);
    expect(s.all.winRate).toBe(50);
    expect(s.all.profitFactor).toBeCloseTo(5 / 7, 10);
    expect(s.all.maxConsecLosses).toBe(2);
    expect(s.long.netProfit).toBeCloseTo(2, 10);
    expect(s.short.netProfit).toBeCloseTo(-4, 10);
    expect(s.trades.at(-1)!.cumProfit).toBeCloseTo(-2, 10);
    expect(s.maxDrawdown).toBeGreaterThanOrEqual(7);
  });

  it("strategy.* değişkenleri ve closedtrades fonksiyonları", () => {
    const code = `strategy("t", initial_capital = 1000)
if bar_index == 0
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 2
    strategy.close("L", comment = "çık")
plot(strategy.equity)
plot(strategy.netprofit)
plot(strategy.closedtrades > 0 ? strategy.closedtrades.exit_price(0) : na)
plot(strategy.position_avg_price)`;
    const { out } = strat(code, ohlc(flat([100, 100, 103, 105])));
    expect(plotVals(out, 0)).toEqual([1000, 1000, 1006, 1010]);
    expect(plotVals(out, 1)).toEqual([0, 0, 0, 10]);
    expect(plotVals(out, 2)).toEqual([null, null, null, 105]);
    expect(plotVals(out, 3)).toEqual([null, 100, 100, null]);
  });

  it("ayar formundan gelen özellikler betiktekileri geçersiz kılar", () => {
    const code = `strategy("t", initial_capital = 1000, commission_value = 0.05)
if bar_index == 0
    strategy.entry("L", strategy.long)`;
    const { out, s } = strat(code, ohlc(flat([100, 100, 101])), { "__s.capital": 5000, "__s.qty_type": "USDT", "__s.qty": 1000, "__s.comm": 0 });
    expect(s.props.initialCapital).toBe(5000);
    expect(s.props.commissionValue).toBe(0);
    expect(s.openTrades[0]!.qty).toBeCloseTo(10, 10);
    const keys = out.inputs.map((m) => m.key);
    expect(keys).toContain("__s.capital");
    expect(out.inputs.find((m) => m.key === "__s.capital")!.defval).toBe(1000);
  });
});

describe("strateji: uyumluluk ve sınırlar", () => {
  it("Pine v4: when=, strategy.long (bool) ve konumsal strategy.close(id, when)", () => {
    const code = `//@version=4
strategy("v4", overlay=true)
strategy.entry("L", true, when = bar_index == 1)
strategy.close("L", bar_index == 3)
plot(strategy.position_size)`;
    const { out, s } = strat(code, ohlc(flat([100, 101, 102, 103, 104, 105])));
    expect(plotVals(out)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(s.trades).toHaveLength(1);
  });

  it("oluşmakta olan son mumda yeni emir verilmez; bekleyen emir dolar", () => {
    const code = `strategy("t")
if bar_index >= 1
    strategy.entry("L", strategy.long)`;
    const rows = flat([100, 101, 102]);
    expect(strat(code, ohlc(rows, true)).s.openTrades[0]!.entryBar).toBe(2);
    const code2 = `strategy("t")
if barstate.islast
    strategy.entry("L", strategy.long)`;
    expect(strat(code2, ohlc(rows, true)).s.pendingOrders).toBe(0);
    expect(strat(code2, ohlc(rows, false)).s.pendingOrders).toBe(1);
  });

  it("strategy.risk.allow_entry_in: izin verilmeyen yön yalnız kapatır", () => {
    const code = `strategy("t")
strategy.risk.allow_entry_in(strategy.direction.long)
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 3
    strategy.entry("S", strategy.short)
plot(strategy.position_size)`;
    const { out, s } = strat(code, ohlc(flat([100, 101, 102, 103, 104, 105])));
    expect(plotVals(out)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(s.trades).toHaveLength(1);
  });

  it("indicator betiğinde strategy.* açık hata; seviyesiz exit uyarı verir", () => {
    const r = run(`indicator("x")\nstrategy.entry("L", strategy.long)`, barsFromCloses([1, 2]));
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) expect(r.error.message).toContain("strategy(");
    const out = ok(run(`strategy("s")\nstrategy.exit("x", "L")`, barsFromCloses([1, 2])));
    expect(out.warnings.join(" ")).toContain("strategy.exit");
    const r2 = run(`strategy("s")\nstrategy.foo()`, barsFromCloses([1, 2]));
    expect(r2.ok).toBe(false);
  });
});

describe("strateji: test aralığı", () => {
  const bars = ohlc(flat([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]));
  const T = (i: number) => bars.time[i]!;
  const code = `strategy("t", initial_capital = 1000)
if bar_index % 3 == 0
    strategy.entry("L", strategy.long)
if bar_index % 3 == 1
    strategy.close("L")`;

  it("aralıksız: tüm veride işlem", () => {
    const { s } = strat(code, bars);
    expect(s.trades.map((t) => [t.entryPrice, t.exitPrice])).toEqual([
      [101, 102],
      [104, 105],
      [107, 108],
    ]);
    expect([s.rangeBars, s.rangeStart, s.rangeEnd]).toEqual([10, T(0), T(9)]);
  });

  it("emirler yalnız aralıkta; aralık sonunda bekleyen emir iptal; sonuçlar ve al-ve-tut aralıktan", () => {
    const { out, s } = strat(code, bars, { "__s.from": T(3), "__s.to": T(6) });
    expect(s.trades.map((t) => [t.entryPrice, t.exitPrice])).toEqual([[104, 105]]);
    expect(s.openTrades).toHaveLength(0);
    expect(s.pendingOrders).toBe(0);
    expect([s.rangeBars, s.rangeStart, s.rangeEnd]).toEqual([4, T(3), T(6)]);
    expect(s.buyHoldPct).toBeCloseTo((106 / 103 - 1) * 100, 10);
    expect([...s.equity].map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, null, null, 1000, 1000, 1001, 1001, null, null, null]);
    expect(out.shapes.find((x) => x.id === "strategy_fills")!.events.every((e) => e.bar >= 3 && e.bar <= 6)).toBe(true);
    expect(s.props.fromTime).toBe(T(3));
  });

  it("aralık bittiğinde açık pozisyon son mumun kapanışında kapanır", () => {
    const { s } = strat(`strategy("t")\nif bar_index == 1\n    strategy.entry("L", strategy.long)`, bars, { "__s.to": T(4) });
    expect(s.trades.map((t) => [t.entryBar, t.entryPrice, t.exitBar, t.exitPrice, t.exitComment])).toEqual([[2, 102, 4, 104, "Dönem sonu"]]);
    expect(s.openTrades).toHaveLength(0);
  });

  it("ayar formunda başlangıç/bitiş tarihi alanları", () => {
    const { out } = strat(code, bars);
    const from = out.inputs.find((m) => m.key === "__s.from")!;
    const to = out.inputs.find((m) => m.key === "__s.to")!;
    expect([from.type, to.type, to.endOfDay]).toEqual(["date", "date", true]);
    expect(Number.isNaN(from.defval as number)).toBe(true);
  });
});
