/**
 * Kütüphane stratejileri bağımsız bir simülasyonla karşılaştırılır: sinyaller referansla doğrulanmış indikatör
 * çıktılarından (UT Bot Al/Sat, EMA/ATR) ya da ham mumlardan alınır, emir/işlem hesabı testte ayrıca yazılmıştır.
 */
import { describe, expect, it } from "vitest";
import { run } from "../src/pine";
import { LIBRARY } from "../src/pine/library";
import type { BarsData, PineOutput, RunResult, StrategyOut } from "../src/pine/types";
import { randomBars, resample, runWithData } from "./helpers";

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

describe("Trend Avcısı Strateji (15 dk)", () => {
  const B = randomBars(6000, 21, 900, Date.UTC(2025, 0, 1));
  // kısa kanal ve kısa günlük EMA: test verisinde (≈ 62 gün) yeterince işlem olsun
  const small = { "Trend EMA": 5, "Kanal uzunluğu (mum)": 48 };
  const tight = { ...small, "Zarar kes (ATR katı)": 1.5, "İz süren stop (ATR katı)": 2, "En uzun süre (mum, 0 = sınırsız)": 30 };

  /** Bağımsız hesap: kanal ham mumlardan, günlük EMA ve 1s ATR yardımcı göstergeden; tek pozisyon, sonraki açılışta
   * giriş, zarar kes giriş ∓ slK×ATR, mum kapanışında en iyi fiyattan trK×ATR geride iz süren stop (sonraki mumdan),
   * stop açılışta aşılmışsa açılıştan, süre sınırında sonraki açılışta kapanış. */
  function simulate(p: { trendLen: number; ch: number; slK: number; trK: number; maxBars: number }): Sim {
    const aux = ok(
      runWithData(
        `//@version=5\nindicator("y")\nplot(request.security(syminfo.tickerid, "D", ta.ema(close, ${p.trendLen}), lookahead = barmerge.lookahead_off))\nplot(request.security(syminfo.tickerid, "60", ta.atr(14), lookahead = barmerge.lookahead_off))`,
        B,
      ),
    );
    const [ema, atr] = aux.plots.map((x) => x.values);
    const sim = new Sim(B);
    let pending: { dir: number; qty: number } | null = null;
    let closeNext = false;
    let atrE = Number.NaN;
    let stp = Number.NaN;
    let best = Number.NaN;
    let eb = -1;
    for (let i = 0; i < B.time.length; i++) {
      const [o, h, l, c] = [B.open[i]!, B.high[i]!, B.low[i]!, B.close[i]!];
      if (closeNext && sim.trade) sim.close(i, o);
      closeNext = false;
      if (pending) {
        sim.open(i, pending.dir, pending.qty, o);
        stp = o - pending.dir * p.slK * atrE;
        best = Number.NaN;
        eb = i;
        pending = null;
      }
      const t = sim.trade;
      if (t && (t.dir > 0 ? l <= stp : h >= stp)) sim.close(i, (t.dir > 0 ? o <= stp : o >= stp) ? o : stp);
      if (sim.trade) {
        const d = sim.trade.dir;
        best = Number.isNaN(best) ? (d > 0 ? h : l) : d > 0 ? Math.max(best, h) : Math.min(best, l);
        stp = d > 0 ? Math.max(stp, best - p.trK * atrE) : Math.min(stp, best + p.trK * atrE);
        if (p.maxBars > 0 && i - eb + 1 >= p.maxBars) closeNext = true;
      } else if (i >= p.ch && !Number.isNaN(ema![i]!) && !Number.isNaN(atr![i]!)) {
        let hh = -Infinity;
        let ll = Infinity;
        for (let k = i - p.ch; k < i; k++) {
          hh = Math.max(hh, B.high[k]!);
          ll = Math.min(ll, B.low[k]!);
        }
        const dir = c > hh && c > ema![i]! ? 1 : c < ll && c < ema![i]! ? -1 : 0;
        if (dir) {
          pending = { dir, qty: sim.qtyAt(i) };
          atrE = atr![i]!;
        }
      }
    }
    return sim;
  }

  it("işlemler bağımsız hesapla birebir (varsayılan çıkışlar)", () => {
    const s = ok(runWithData(code("trend_avcisi_strategy"), B, { inputs: small })).strategy!;
    const sim = simulate({ trendLen: 5, ch: 48, slK: 3, trK: 5, maxBars: 960 });
    expect(sim.closed.length).toBeGreaterThan(10);
    expectSame(s, sim);
    expect(s.openTrades).toHaveLength(sim.trade ? 1 : 0);
    expect(s.props).toMatchObject({ initialCapital: 1000, qtyType: "percent_of_equity", qtyValue: 100, commissionValue: 0.05 });
  });

  it("dar stop, sıkı iz, süre sınırı: stop, iz ve süre çıkışları birebir", () => {
    const s = ok(runWithData(code("trend_avcisi_strategy"), B, { inputs: tight })).strategy!;
    const sim = simulate({ trendLen: 5, ch: 48, slK: 1.5, trK: 2, maxBars: 30 });
    expectSame(s, sim);
    expect(new Set(s.trades.map((t) => t.exitComment))).toEqual(new Set(["Stop", "Süre"]));
    expect(s.trades.some((t) => t.exitComment === "Stop" && t.profit > 0)).toBe(true); // iz süren stop kârda kapattı
    expect(s.long.trades).toBeGreaterThan(0);
    expect(s.short.trades).toBeGreaterThan(0);
  });

  it("gösterge stratejinin işlemlerini birebir izler (Al/Sat girişte, Çık çıkışta)", () => {
    for (const inputs of [small, tight]) {
      const s = ok(runWithData(code("trend_avcisi_strategy"), B, { inputs })).strategy!;
      const ind = ok(runWithData(code("trend_avcisi"), B, { inputs }));
      const bars = (title: string) => ind.shapes.find((x) => x.title === title)!.events.map((e) => e.bar);
      const all = [...s.trades, ...s.openTrades];
      expect(bars("Al")).toEqual(all.filter((t) => t.dir > 0).map((t) => t.entryBar));
      expect(bars("Sat")).toEqual(all.filter((t) => t.dir < 0).map((t) => t.entryBar));
      expect(bars("Çık")).toEqual(s.trades.map((t) => t.exitBar));
    }
  });

  it("50.000 mumda (15 dk'da uygulamanın üst sınırı) işlem bütçesi küçük", () => {
    const big = randomBars(50000, 3, 900);
    const out = ok(runWithData(code("trend_avcisi_strategy"), big));
    expect(out.strategy!.trades.length).toBeGreaterThan(20);
    expect(out.stats.ops).toBeLessThan(10_000_000);
  });
});

describe("Rejim Strateji (günlük)", () => {
  const B = randomBars(3000, 31, 86400, Date.UTC(2015, 0, 1));
  /** Açılış boşluklu kopya: açılış önceki kapanıştan ±%1,5'e kadar sapar (boşlukta açılıştan dolum denetlenir). */
  const G: BarsData = (() => {
    const g = { ...B, open: B.open.slice(), high: B.high.slice(), low: B.low.slice() };
    for (let i = 1; i < g.open.length; i++) {
      const o = B.close[i - 1]! * (1 + Math.sin(i * 12.9898) * 0.015);
      g.open[i] = o;
      g.high[i] = Math.max(g.high[i]!, o);
      g.low[i] = Math.min(g.low[i]!, o);
    }
    return g;
  })();
  const tight = {
    "Yükseliş: kâr al (ATR katı)": 1,
    "Yükseliş: zarar kes (ATR katı)": 1,
    "Düşüş: RSI üstü → sat": 50,
    "Düşüş: kâr al (ATR katı)": 1,
    "Düşüş: zarar kes (ATR katı)": 1,
    "Yatay: kâr al (ATR katı)": 1,
    "Yatay: zarar kes (ATR katı)": 1,
    "En uzun süre (mum, 0 = sınırsız)": 5,
  };
  const DEF = { upTp: 0.5, upSl: 2, dnHi: 70, dnTp: 1, dnSl: 2.5, sdTp: 1.5, sdSl: 3, maxBars: 20 };
  const TIGHT = { upTp: 1, upSl: 1, dnHi: 50, dnTp: 1, dnSl: 1, sdTp: 1, sdSl: 1, maxBars: 5 };

  /** Bağımsız hesap: ATR/RSI/EMA/DMI yardımcı göstergeden, UT Bot Al/Sat kütüphanedeki UT Bot göstergesinden; rejim ve
   * kural seçimi, tek pozisyon, sonraki açılışta giriş, kâr al / zarar kes girişten ± ATR katı (açılışta aşılmışsa
   * açılıştan; ikisi aynı mumdaysa açılışa yakın uç önce), süre sınırında sonraki açılışta kapanış. */
  function simulate(bars: BarsData, p: typeof DEF): Sim {
    const aux = ok(
      runWithData(
        `//@version=5\nindicator("y")\n[p, m, a] = ta.dmi(14, 14)\nplot(ta.atr(14))\nplot(ta.rsi(close, 14))\nplot(ta.ema(close, 50))\nplot(p)\nplot(m)\nplot(a)`,
        bars,
      ),
    );
    const [atr, rsi, ema, dp, dm, adx] = aux.plots.map((x) => x.values);
    const ut = (a: number, title: string) =>
      new Set(ok(runWithData(code("ut_bot"), bars, { inputs: { "Hassasiyet (anahtar değer)": a } })).shapes.find((x) => x.title === title)!.events.map((e) => e.bar));
    const sell2 = ut(2, "Sat");
    const buy3 = ut(3, "Al");
    const sim = new Sim(bars);
    let pending: { dir: number; qty: number; tpD: number; slD: number } | null = null;
    let closeNext = false;
    let tpL = Number.NaN;
    let slL = Number.NaN;
    let eb = -1;
    for (let i = 0; i < bars.time.length; i++) {
      const [o, h, l, c] = [bars.open[i]!, bars.high[i]!, bars.low[i]!, bars.close[i]!];
      if (closeNext && sim.trade) sim.close(i, o);
      closeNext = false;
      if (pending) {
        sim.open(i, pending.dir, pending.qty, o);
        tpL = o + pending.dir * pending.tpD;
        slL = o - pending.dir * pending.slD;
        eb = i;
        pending = null;
      }
      const t = sim.trade;
      if (t) {
        const d = t.dir;
        let px = Number.NaN;
        if (i > eb && (d > 0 ? o <= slL : o >= slL)) px = o;
        else if (i > eb && (d > 0 ? o >= tpL : o <= tpL)) px = o;
        else {
          const hitTp = d > 0 ? h >= tpL : l <= tpL;
          const hitSl = d > 0 ? l <= slL : h >= slL;
          if (hitTp && hitSl) px = (d > 0) === h - o <= o - l ? tpL : slL;
          else if (hitTp) px = tpL;
          else if (hitSl) px = slL;
        }
        if (!Number.isNaN(px)) sim.close(i, px);
      }
      if (sim.trade) {
        if (p.maxBars > 0 && i - eb + 1 >= p.maxBars) closeNext = true;
        continue;
      }
      const v = [atr![i]!, rsi![i]!, ema![i]!, dp![i]!, dm![i]!, adx![i]!];
      if (v.some(Number.isNaN)) continue;
      const rej = c > ema![i]! && dp![i]! > dm![i]! && adx![i]! > 20 ? 1 : c < ema![i]! && dm![i]! > dp![i]! && adx![i]! > 20 ? -1 : 2;
      const L = rej === 1 ? sell2.has(i) : rej === -1 ? rsi![i]! < 30 : buy3.has(i);
      const S = rej === -1 && rsi![i]! > p.dnHi;
      if (!L && !S) continue;
      const [tk, sk] = rej === 1 ? [p.upTp, p.upSl] : rej === -1 ? [p.dnTp, p.dnSl] : [p.sdTp, p.sdSl];
      pending = { dir: L ? 1 : -1, qty: sim.qtyAt(i), tpD: tk * atr![i]!, slD: sk * atr![i]! };
    }
    return sim;
  }

  it("işlemler bağımsız hesapla birebir (varsayılan ayarlar)", () => {
    const s = ok(runWithData(code("rejim_strategy"), B)).strategy!;
    const sim = simulate(B, DEF);
    expect(sim.closed.length).toBeGreaterThan(30);
    expectSame(s, sim);
    expect(s.openTrades).toHaveLength(sim.trade ? 1 : 0);
    expect(s.props).toMatchObject({ initialCapital: 1000, qtyType: "percent_of_equity", qtyValue: 100, commissionValue: 0.05 });
  });

  it("dar seviyeler, kısa süre, short açık; açılış boşluklu mumlarda da: kâr al, zarar kes, süre çıkışları birebir", () => {
    for (const bars of [B, G]) {
      const s = ok(runWithData(code("rejim_strategy"), bars, { inputs: tight })).strategy!;
      const sim = simulate(bars, TIGHT);
      expectSame(s, sim);
      expect(new Set(s.trades.map((t) => t.exitComment))).toEqual(new Set(["TP", "SL", "Süre"]));
      expect(s.long.trades).toBeGreaterThan(0);
      expect(s.short.trades).toBeGreaterThan(0);
    }
  });

  it("gösterge stratejinin işlemlerini birebir izler (Al/Sat girişte, Çık çıkışta)", () => {
    for (const [bars, inputs] of [[B, {}], [B, tight], [G, tight]] as const) {
      const s = ok(runWithData(code("rejim_strategy"), bars, { inputs })).strategy!;
      const ind = ok(runWithData(code("rejim"), bars, { inputs }));
      const at = (title: string) => ind.shapes.find((x) => x.title === title)!.events.map((e) => e.bar);
      const all = [...s.trades, ...s.openTrades];
      expect(at("Al")).toEqual(all.filter((t) => t.dir > 0).map((t) => t.entryBar));
      expect(at("Sat")).toEqual(all.filter((t) => t.dir < 0).map((t) => t.entryBar));
      expect(at("Çık")).toEqual(s.trades.map((t) => t.exitBar));
    }
  });

  it("rejim anahtarları: kapalı rejimde işlem açılmaz", () => {
    const all = ok(runWithData(code("rejim_strategy"), B)).strategy!.trades.length;
    const off = { "Yükselişte işlem aç": false, "Düşüşte işlem aç": false, "Yatayda işlem aç": false };
    expect(ok(runWithData(code("rejim_strategy"), B, { inputs: off })).strategy!.trades).toHaveLength(0);
    const one = ok(runWithData(code("rejim_strategy"), B, { inputs: { ...off, "Yükselişte işlem aç": true } })).strategy!.trades.length;
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(all);
  });

  it("5000 günlük mumda işlem bütçesi küçük", () => {
    const out = ok(runWithData(code("rejim_strategy"), randomBars(5000, 4, 86400, Date.UTC(2010, 0, 1))));
    expect(out.strategy!.trades.length).toBeGreaterThan(50);
    expect(out.stats.ops).toBeLessThan(5_000_000);
  });
});
