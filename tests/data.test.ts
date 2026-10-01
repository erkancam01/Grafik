import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceSource, FUTURES, SPOT, detectBinance } from "../src/data/binance";
import { DemoSource } from "../src/data/demo";
import { GOLD_IDS, GoldSource } from "../src/data/gold";
import { applyLiveBar, heikinAshi, mergeBars, resample } from "../src/data/source";
import { ExtraData, computeIndicator, loadHistory, type Runner } from "../src/indicators/compute";
import { run } from "../src/pine";
import { LIBRARY } from "../src/pine/library";
import { barsFromCloses } from "./helpers";

const direct: Runner = { run: async (code, bars, inputs, extra) => run(code, bars, { inputs, extra }) };

afterEach(() => vi.unstubAllGlobals());

function kline(t: number, c: number, closeTime: number): unknown[] {
  return [t, String(c - 1), String(c + 1), String(c - 2), String(c), "10", closeTime, "0", 0, "0", "0", "0"];
}

describe("mum yardımcıları", () => {
  it("birleştirme, canlı mum güncelleme/ekleme, Heikin Ashi", () => {
    const a = barsFromCloses([1, 2, 3]);
    const b = { ...barsFromCloses([3, 4]), time: Float64Array.from([a.time[2]!, a.time[2]! + 3_600_000]) };
    const m = mergeBars(a, b);
    expect([...m.close]).toEqual([1, 2, 3, 4]);
    const t = m.time[3]!;
    const u = applyLiveBar(m, { time: t, open: 4, high: 9, low: 3, close: 8, volume: 5, closed: false }, t + 1000);
    expect(u.close[3]).toBe(8);
    expect(u.lastRealtime).toBe(true);
    const v = applyLiveBar(u, { time: t + 3_600_000, open: 8, high: 8, low: 8, close: 8, volume: 1, closed: false }, t + 3_600_000 + 5);
    expect(v.time.length).toBe(5);
    const ha = heikinAshi(m);
    expect(ha.close[1]).toBeCloseTo((m.open[1]! + m.high[1]! + m.low[1]! + m.close[1]!) / 4);
  });
});

describe("Binance istemcisi", () => {
  it("mumları ayrıştırır, sembolleri hacme göre sıralar", async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("ticker/24hr")) {
        return new Response(
          JSON.stringify([
            { symbol: "ETHUSDT", lastPrice: "4000", priceChangePercent: "1.5", quoteVolume: "100" },
            { symbol: "BTCUSDT", lastPrice: "100000", priceChangePercent: "-2", quoteVolume: "900" },
            { symbol: "BTCUSDT_260327", lastPrice: "1", priceChangePercent: "0", quoteVolume: "5" },
          ]),
        );
      }
      return new Response(JSON.stringify([kline(now - 7_200_000, 10, now - 3_600_001), kline(now - 3_600_000, 11, now + 10_000)]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const src = new BinanceSource(FUTURES);
    const syms = await src.symbols();
    expect(syms.map((s) => s.symbol)).toEqual(["BTCUSDT", "ETHUSDT"]);
    const b = await src.klines("BTCUSDT", "1h", 2);
    expect([...b.close]).toEqual([10, 11]);
    expect(b.tfSec).toBe(3600);
    expect(b.lastRealtime).toBe(true);
    expect(String(fetchMock.mock.calls[1]![0])).toContain("fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=2");
  });

  it("vadeli uçlara ulaşılamazsa spota düşer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(FUTURES.rest)) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify([kline(0, 1, 1)]));
      }),
    );
    const src = await detectBinance();
    expect(src.name).toBe("spot");
    expect(SPOT.rest).toContain("binance.vision");
  });

  it("HTTP hatası anlaşılır mesajla", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ msg: "Invalid symbol." }), { status: 400 })));
    await expect(new BinanceSource(FUTURES).klines("XXX", "1h", 5)).rejects.toThrow("HTTP 400: Invalid symbol.");
  });
});

describe("altın kaynağı", () => {
  const ticker = (symbol: string, price: string) => ({ symbol, lastPrice: price, priceChangePercent: "0.5", quoteVolume: "1000" });

  it("XAUUSDT vadeli uçtan, PAXGUSDT spot uçtan; semboller tek tek özetten", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("ticker/24hr")) return new Response(JSON.stringify(ticker(url.includes("XAUUSDT") ? "XAUUSDT" : "PAXGUSDT", "4200")));
      return new Response(JSON.stringify([kline(0, 4200, 3_599_999)]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const src = await GoldSource.detect();
    expect(src.available).toEqual(["XAUUSDT", "PAXGUSDT"]);
    expect(GOLD_IDS).toEqual(["XAUUSDT", "PAXGUSDT"]);
    expect((await src.symbols()).map((x) => x.symbol)).toEqual(["XAUUSDT", "PAXGUSDT"]);
    fetchMock.mockClear();
    await src.klines("XAUUSDT", "1w", 3);
    await src.klines("PAXGUSDT", "1w", 3);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`${FUTURES.rest}/fapi/v1/klines?symbol=XAUUSDT&interval=1w`);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(`${SPOT.rest}/api/v3/klines?symbol=PAXGUSDT&interval=1w`);
    expect(src.labelFor("XAUUSDT")).toBe(FUTURES.label);
    expect(src.labelFor("PAXGUSDT")).toBe(SPOT.label);
    await expect(src.klines("BTCUSDT", "1h", 1)).rejects.toThrow("yalnız altın");
  });

  it("vadeli uca ulaşılamazsa yalnız PAXGUSDT; hiçbirine ulaşılamazsa hata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(FUTURES.rest)) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify([kline(0, 4200, 1)]));
      }),
    );
    expect((await GoldSource.detect()).available).toEqual(["PAXGUSDT"]);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(GoldSource.detect()).rejects.toThrow("altın verisine ulaşılamadı");
  });

  it("demo kaynağı da yalnız altın", async () => {
    const d = new DemoSource();
    expect(d.available).toEqual(["XAUUSDT", "PAXGUSDT"]);
    expect((await d.symbols()).map((x) => x.symbol)).toEqual(["XAUUSDT", "PAXGUSDT"]);
  });
});

describe("haftalık birleştirme", () => {
  it("haftalar pazartesi 00:00 UTC'de başlar (Binance / TradingView gibi)", () => {
    const day = 86_400_000;
    const mon = Date.UTC(2026, 8, 7); // 2026-09-07 pazartesi
    const closes = Array.from({ length: 14 }, (_, i) => 100 + i);
    const d = barsFromCloses(closes, 86_400);
    for (let i = 0; i < 14; i++) d.time[i] = mon - 3 * day + i * day; // cuma 2026-09-04'ten başlayan 14 gün
    const w = resample(d, 604_800);
    expect(Array.from(w.time)).toEqual([mon - 7 * day, mon, mon + 7 * day]);
    expect(new Date(w.time[1]!).getUTCDay()).toBe(1);
    expect([w.open[1], w.close[1]]).toEqual([d.open[3], d.close[9]]);
  });
});

describe("demo kaynağı ve indikatör akışı", () => {
  it("geçmiş sayfalanır, zaman dilimleri tutarlı", async () => {
    const src = new DemoSource();
    const b = await loadHistory(src, "BTCUSDT", "1h", 2500);
    expect(b.time.length).toBe(2500);
    for (let i = 1; i < b.time.length; i++) expect(b.time[i]! - b.time[i - 1]!).toBe(3_600_000);
  });

  it("EMA Trend 4s: 4s verisi otomatik getirilir", async () => {
    const src = new DemoSource();
    const main = await loadHistory(src, "ETHUSDT", "1h", 1200);
    const code = LIBRARY.find((x) => x.id === "ema_trend_4h")!.code;
    const r = await computeIndicator(direct, new ExtraData(src), code, main, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      const fast = r.output.plots.find((p) => p.title === "EMA hızlı (4s)")!.values;
      expect(fast.filter((x) => !Number.isNaN(x)).length).toBeGreaterThan(1000);
    }
  });

  it("desteklenmeyen zaman dilimi anlaşılır hata", async () => {
    const src = new DemoSource();
    const main = await loadHistory(src, "BTCUSDT", "1h", 100);
    const code = `indicator("x")\nplot(request.security(syminfo.tickerid, "45", close))`;
    const r = await computeIndicator(direct, new ExtraData(src), code, main, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("desteklenmiyor");
  });
});
