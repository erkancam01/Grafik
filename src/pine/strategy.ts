/**
 * Strateji motoru — TradingView'ın "broker emülatörü" davranışı (geçmiş mumlar, varsayılan ayarlar).
 *
 * - Betik mum kapanışında çalışır; verilen emirler bir SONRAKİ mumda işlenir: piyasa emri açılışta, limit/stop
 *   emirleri mum içinde. `process_orders_on_close` ya da `strategy.close(immediately = true)` → aynı mumun
 *   kapanışında.
 * - Mum içi fiyat yolu varsayımı: yüksek açılışa düşükten yakınsa açılış → yüksek → düşük → kapanış, değilse
 *   açılış → düşük → yüksek → kapanış. Emirler bu yolda tetiklendikleri sırayla dolar; giriş dolunca ona bağlı
 *   çıkışlar (strategy.exit) aynı mumda da dolabilir.
 * - Boşluk (gap): stop/limit seviyesi açılışta zaten geçilmişse açılış fiyatından dolar.
 * - Ters yönde strategy.entry pozisyonu çevirir; aynı yönde girişler `pyramiding` ile sınırlıdır.
 * - Oluşmakta olan son mumda yeni emir verilmez (calc_on_every_tick = false gibi); bekleyen emirler dolabilir.
 * - Teminat/likidasyon (margin) hesaplanmaz.
 */
import type { Runtime } from "./engine";
import { runtimeError } from "./errors";
import type {
  CommissionType,
  InputMeta,
  QtyType,
  ShapeEvent,
  ShapeOut,
  StrategyOut,
  StrategyProps,
  StrategySide,
  StrategyTradeOut,
} from "./types";
import { truthy } from "./values";
import { def, n, type BuiltinDef } from "./builtins/registry";

const NaN_ = Number.NaN;
const TEPS = 1e-12;
const BUY_COLOR = "#2962FFFF";
const SELL_COLOR = "#F23645FF";

// ------------------------------------------------------------------ mum içi fiyat yolu

class BarPath {
  p: [number, number, number, number] = [0, 0, 0, 0];

  set(o: number, h: number, l: number, c: number): void {
    this.p = h - o <= o - l ? [o, h, l, c] : [o, l, h, c];
  }

  /** t ∈ [0, 3]: 0 açılış, 3 kapanış; aradaki noktalar yolun köşeleri. */
  at(t: number): number {
    if (t >= 3) return this.p[3];
    const k = Math.floor(t);
    const a = this.p[k]!;
    return a + (this.p[k + 1]! - a) * (t - k);
  }

  /** t0'dan itibaren `sgn·fiyat ≥ sgn·x` olduğu ilk an (sgn = 1: yukarı kesiş, -1: aşağı). */
  first(x: number, t0: number, sgn: number): number | null {
    if (sgn * this.at(t0) >= sgn * x) return t0;
    for (let k = Math.floor(t0); k < 3; k++) {
      const a = this.p[k]!;
      const b = this.p[k + 1]!;
      if (sgn * b >= sgn * x) return Math.max(t0, k + (x - a) / (b - a));
    }
    return null;
  }

  /** [ta, tb] aralığındaki en düşük ve en yüksek fiyat. */
  range(ta: number, tb: number): [number, number] {
    let lo = Math.min(this.at(ta), this.at(tb));
    let hi = Math.max(this.at(ta), this.at(tb));
    for (let k = Math.ceil(ta); k <= Math.floor(tb) && k <= 3; k++) {
      const v = this.p[k]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  }
}

// ------------------------------------------------------------------ emirler ve işlemler

type OrderType = "entry" | "order" | "close" | "close_all" | "exit";

interface Order {
  seq: number;
  type: OrderType;
  id: string;
  /** entry/order yönü (close/exit için kullanılmaz). */
  dir: number;
  /** NaN = varsayılan miktar (entry/order) ya da tamamı (close/exit). */
  qty: number;
  qtyPct: number;
  limit: number;
  stop: number;
  stopHit: boolean;
  comment: string;
  oca: string;
  ocaType: string;
  bar: number;
  onClose: boolean;
  /** Varsayılan miktar hesabı için emrin verildiği mumun kapanışı ve özsermayesi. */
  refPrice: number;
  refEquity: number;
  // strategy.exit
  from: string;
  profit: number;
  loss: number;
  trailPrice: number;
  trailPoints: number;
  trailOffset: number;
  cProfit: string;
  cLoss: string;
  cTrail: string;
  trailOn: boolean;
  trailBest: number;
  armed: boolean;
}

interface Trade {
  entryId: string;
  entryComment: string;
  dir: number;
  qty: number;
  origQty: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  /** Kalan kısmın giriş komisyonu. */
  comm: number;
  hi: number;
  lo: number;
  lastT: number;
  exitedBy: Set<string>;
}

interface Closed {
  dir: number;
  qty: number;
  entryId: string;
  entryComment: string;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  exitId: string;
  exitComment: string;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  profit: number;
  commission: number;
  runup: number;
  drawdown: number;
}

interface Trigger {
  t: number;
  price: number;
  leg: "limit" | "stop" | "stophit" | "profit" | "loss" | "trail";
}

const HIST_KEYS = [
  "strategy.position_size",
  "strategy.position_avg_price",
  "strategy.equity",
  "strategy.netprofit",
  "strategy.openprofit",
  "strategy.closedtrades",
  "strategy.opentrades",
  "strategy.wintrades",
  "strategy.losstrades",
] as const;

/** `x[k]` ile geçmişi okunabilen strateji değişkenleri (her mumun betiğe görünen değeri saklanır). */
export const STRATEGY_HIST = new Set<string>(HIST_KEYS);

export const DEFAULT_PROPS: StrategyProps = {
  initialCapital: 1_000_000,
  qtyType: "fixed",
  qtyValue: 1,
  pyramiding: 0,
  commissionType: "percent",
  commissionValue: 0,
  slippage: 0,
  processOrdersOnClose: false,
  calcOnEveryTick: false,
  fillLimitsTicks: 0,
};

export class StrategyEngine {
  readonly props: StrategyProps;
  /** Betikte yazılı ayarlar (ayar formundaki varsayılanlar). */
  readonly declared: StrategyProps;
  private readonly rt: Runtime;
  private readonly tick: number;
  private orders: Order[] = [];
  private trades: Trade[] = [];
  readonly closed: Closed[] = [];
  private seq = 0;
  private cur = -1;
  private readonly path = new BarPath();
  private evT = 0;
  readonly fills: ShapeEvent[] = [];

  netProfit = 0;
  grossProfit = 0;
  grossLoss = 0;
  wins = 0;
  losses = 0;
  evens = 0;
  commission = 0;
  allowDir = 0;

  readonly equity: Float64Array;
  private readonly hist: Record<string, Float64Array> = {};
  private peak: number;
  private trough: number;
  maxDD = 0;
  maxDDPct = 0;
  maxRunup = 0;
  maxRunupPct = 0;
  maxLong = 0;
  maxShort = 0;

  constructor(rt: Runtime, declared: StrategyProps, props: StrategyProps) {
    this.rt = rt;
    this.declared = declared;
    this.props = props;
    this.tick = rt.main.mintick > 0 ? rt.main.mintick : 0.01;
    const n = rt.main.n;
    this.equity = new Float64Array(n).fill(NaN_);
    for (const k of HIST_KEYS) this.hist[k] = new Float64Array(n).fill(NaN_);
    this.peak = props.initialCapital;
    this.trough = props.initialCapital;
    this.beginBar(rt.bar);
  }

  // ---------------------------------------------------------------- durum
  get positionSize(): number {
    let s = 0;
    for (const t of this.trades) s += t.dir * t.qty;
    return s;
  }

  get posDir(): number {
    return this.trades.length ? this.trades[0]!.dir : 0;
  }

  get avgPrice(): number {
    let q = 0;
    let v = 0;
    for (const t of this.trades) {
      q += t.qty;
      v += t.qty * t.entryPrice;
    }
    return q > 0 ? v / q : NaN_;
  }

  get openTradeList(): readonly Trade[] {
    return this.trades;
  }

  get entryName(): string {
    return this.trades[0]?.entryId ?? "";
  }

  openProfit(price: number): number {
    let s = 0;
    for (const t of this.trades) s += t.dir * (price - t.entryPrice) * t.qty - t.comm;
    return s;
  }

  equityAt(price: number): number {
    return this.props.initialCapital + this.netProfit + this.openProfit(price);
  }

  private get close(): number {
    return this.rt.main.close[this.rt.bar]!;
  }

  histAt(name: string, idx: number): number {
    const a = this.hist[name];
    return a && idx >= 0 && idx < a.length ? a[idx]! : NaN_;
  }

  private commOf(qty: number, price: number): number {
    const v = this.props.commissionValue;
    if (!(v > 0)) return 0;
    switch (this.props.commissionType) {
      case "cash_per_contract":
        return qty * v;
      case "cash_per_order":
        return v;
      default:
        return (qty * price * v) / 100;
    }
  }

  private qtyFor(o: Order): number {
    if (o.qty > 0) return o.qty;
    const p = this.props;
    switch (p.qtyType) {
      case "percent_of_equity":
        return o.refPrice > 0 ? (o.refEquity * p.qtyValue) / 100 / o.refPrice : NaN_;
      case "cash":
        return o.refPrice > 0 ? p.qtyValue / o.refPrice : NaN_;
      default:
        return p.qtyValue;
    }
  }

  // ---------------------------------------------------------------- emir verme (betikten)
  /** Oluşmakta olan son mumda (calc_on_every_tick kapalıyken) yeni emir verilmez. */
  canPlace(): boolean {
    const S = this.rt.main;
    if (!this.rt.isMain) return false;
    return !(this.rt.bar === S.n - 1 && S.lastRealtime && !this.props.calcOnEveryTick);
  }

  private newOrder(type: OrderType, id: string): Order {
    const close = this.close;
    return {
      seq: ++this.seq,
      type,
      id,
      dir: 0,
      qty: NaN_,
      qtyPct: NaN_,
      limit: NaN_,
      stop: NaN_,
      stopHit: false,
      comment: "",
      oca: "",
      ocaType: "none",
      bar: this.rt.bar,
      onClose: false,
      refPrice: close,
      refEquity: this.equityAt(close),
      from: "",
      profit: NaN_,
      loss: NaN_,
      trailPrice: NaN_,
      trailPoints: NaN_,
      trailOffset: NaN_,
      cProfit: "",
      cLoss: "",
      cTrail: "",
      trailOn: false,
      trailBest: NaN_,
      armed: false,
    };
  }

  private put(o: Order): void {
    const same = (x: Order) =>
      x.id === o.id &&
      (o.type === "exit"
        ? x.type === "exit" && x.from === o.from
        : o.type === "entry" || o.type === "order"
          ? x.type === "entry" || x.type === "order"
          : x.type === o.type);
    const old = this.orders.find(same);
    if (old && o.type === "exit") {
      // aynı çıkış emri her mumda yeniden verilir: iz süren stop durumu korunur
      o.trailOn = old.trailOn;
      o.trailBest = old.trailBest;
      o.armed = old.armed;
    }
    this.orders = this.orders.filter((x) => !same(x));
    this.orders.push(o);
  }

  entry(type: "entry" | "order", id: string, dir: number, qty: number, limit: number, stop: number, oca: string, ocaType: string, comment: string): void {
    if (!this.canPlace()) return;
    const o = this.newOrder(type, id);
    o.dir = dir;
    o.qty = qty > 0 ? qty : NaN_;
    o.limit = limit;
    o.stop = stop;
    o.oca = oca;
    o.ocaType = ocaType;
    o.comment = comment;
    o.onClose = this.props.processOrdersOnClose && Number.isNaN(limit) && Number.isNaN(stop);
    this.put(o);
  }

  closeOrder(id: string | null, qty: number, qtyPct: number, comment: string, immediately: boolean): void {
    if (!this.canPlace()) return;
    if (id !== null && !this.trades.some((t) => t.entryId === id)) return;
    if (id === null && !this.trades.length) return;
    const o = this.newOrder(id === null ? "close_all" : "close", id ?? "");
    o.qty = qty > 0 ? qty : NaN_;
    o.qtyPct = qtyPct > 0 ? qtyPct : NaN_;
    o.comment = comment;
    o.onClose = immediately || this.props.processOrdersOnClose;
    this.put(o);
  }

  exit(
    id: string,
    from: string,
    qty: number,
    qtyPct: number,
    profit: number,
    limit: number,
    loss: number,
    stop: number,
    trailPrice: number,
    trailPoints: number,
    trailOffset: number,
    comment: string,
    cProfit: string,
    cLoss: string,
    cTrail: string,
  ): void {
    if (!this.canPlace()) return;
    const hasTrail = !Number.isNaN(trailOffset) && (!Number.isNaN(trailPrice) || !Number.isNaN(trailPoints));
    if ([profit, limit, loss, stop].every((x) => Number.isNaN(x)) && !hasTrail) {
      this.rt.warn("strategy.exit: en az bir çıkış seviyesi gerekli (profit, limit, loss, stop ya da trail_*); emir yok sayıldı");
      return;
    }
    const o = this.newOrder("exit", id);
    o.from = from;
    o.qty = qty > 0 ? qty : NaN_;
    o.qtyPct = qtyPct > 0 ? qtyPct : NaN_;
    o.profit = profit;
    o.limit = limit;
    o.loss = loss;
    o.stop = stop;
    if (hasTrail) {
      o.trailPrice = trailPrice;
      o.trailPoints = trailPoints;
      o.trailOffset = Math.max(0, trailOffset);
    }
    o.comment = comment;
    o.cProfit = cProfit;
    o.cLoss = cLoss;
    o.cTrail = cTrail;
    this.put(o);
  }

  cancel(id: string | null): void {
    if (!this.rt.isMain) return;
    this.orders = id === null ? [] : this.orders.filter((o) => o.id !== id);
  }

  // ---------------------------------------------------------------- mum işleme
  /** Mum başı: açılışta piyasa emirleri, sonra mum içi limit/stop olayları. Betik bundan sonra çalışır. */
  beginBar(i: number): void {
    if (this.cur === i) return;
    this.cur = i;
    const S = this.rt.main;
    this.path.set(S.open[i]!, S.high[i]!, S.low[i]!, S.close[i]!);
    for (const t of this.trades) t.lastT = 0;
    this.evT = 0;
    const mkts = this.orders.filter((o) => o.bar < i && this.isMarket(o)).sort((a, b) => a.seq - b.seq);
    for (const o of mkts) {
      if (!this.orders.includes(o)) continue; // OCA ile iptal edilmiş olabilir
      this.remove(o);
      this.execMarket(o, 0);
    }
    this.intrabar(i);
    const c = S.close[i]!;
    const h = this.hist;
    h["strategy.position_size"]![i] = this.positionSize;
    h["strategy.position_avg_price"]![i] = this.avgPrice;
    h["strategy.equity"]![i] = this.equityAt(c);
    h["strategy.netprofit"]![i] = this.netProfit;
    h["strategy.openprofit"]![i] = this.openProfit(c);
    h["strategy.closedtrades"]![i] = this.closed.length;
    h["strategy.opentrades"]![i] = this.trades.length;
    h["strategy.wintrades"]![i] = this.wins;
    h["strategy.losstrades"]![i] = this.losses;
  }

  /** Mum sonu (betikten sonra): kapanışta dolan emirler, özsermaye ve düşüş takibi. */
  endBar(i: number): void {
    this.beginBar(i);
    const onClose = this.orders.filter((o) => o.bar === i && o.onClose).sort((a, b) => a.seq - b.seq);
    for (const o of onClose) {
      if (!this.orders.includes(o)) continue;
      this.remove(o);
      this.execMarket(o, 3);
    }
    for (const t of this.trades) {
      this.touch(t, 3);
      t.lastT = 0;
    }
    const S = this.rt.main;
    this.equity[i] = this.equityAt(S.close[i]!);
    const pts = this.trades.length ? [this.path.p[1], this.path.p[2], this.path.p[3]] : [this.path.p[3]];
    for (const p of pts) {
      const e = this.equityAt(p);
      if (e > this.peak) this.peak = e;
      const dd = this.peak - e;
      if (dd > this.maxDD) this.maxDD = dd;
      if (this.peak > 0 && dd / this.peak > this.maxDDPct) this.maxDDPct = dd / this.peak;
      if (e < this.trough) this.trough = e;
      const ru = e - this.trough;
      if (ru > this.maxRunup) this.maxRunup = ru;
      if (this.trough > 0 && ru / this.trough > this.maxRunupPct) this.maxRunupPct = ru / this.trough;
    }
    const ps = this.positionSize;
    if (ps > this.maxLong) this.maxLong = ps;
    if (-ps > this.maxShort) this.maxShort = -ps;
  }

  private isMarket(o: Order): boolean {
    if (o.type === "close" || o.type === "close_all") return true;
    if (o.type === "exit") return false;
    return Number.isNaN(o.limit) && Number.isNaN(o.stop);
  }

  private remove(o: Order): void {
    const i = this.orders.indexOf(o);
    if (i >= 0) this.orders.splice(i, 1);
  }

  private intrabar(i: number): void {
    for (let guard = 0; guard < 10_000; guard++) {
      let best: { o: Order; ev: Trigger } | null = null;
      for (const o of this.orders) {
        if (o.bar >= i || this.isMarket(o)) continue;
        const ev = this.trigger(o, this.evT);
        if (!ev) continue;
        if (!best || ev.t < best.ev.t - TEPS || (Math.abs(ev.t - best.ev.t) <= TEPS && o.seq < best.o.seq)) best = { o, ev };
      }
      if (!best) break;
      this.advanceTrails(best.ev.t);
      this.evT = best.ev.t;
      if (best.ev.leg === "stophit") {
        best.o.stopHit = true;
        continue;
      }
      this.remove(best.o);
      if (best.o.type === "exit") this.execExit(best.o, best.ev);
      else this.execEntry(best.o, this.evT, best.ev.price);
    }
    this.advanceTrails(3);
  }

  private trigger(o: Order, t: number): Trigger | null {
    const P = this.path;
    const tick = this.tick;
    const slip = this.props.slippage * tick;
    const fillAdj = this.props.fillLimitsTicks * tick;
    if (o.type === "entry" || o.type === "order") {
      const d = o.dir;
      if (!Number.isNaN(o.stop) && !o.stopHit) {
        const tt = P.first(o.stop, t, d);
        if (tt === null) return null;
        if (!Number.isNaN(o.limit)) return { t: tt, price: NaN_, leg: "stophit" };
        const px = tt === t ? P.at(t) : o.stop;
        return { t: tt, price: px + d * slip, leg: "stop" };
      }
      const tt = P.first(o.limit - d * fillAdj, t, -d);
      if (tt === null) return null;
      return { t: tt, price: tt === t ? P.at(t) : o.limit, leg: "limit" };
    }
    if (o.type !== "exit") return null;
    const m = this.matching(o);
    if (!(m.qty > 0)) return null;
    o.armed = true;
    const d = m.dir;
    const lim = !Number.isNaN(o.limit) ? o.limit : !Number.isNaN(o.profit) ? m.avg + d * o.profit * tick : NaN_;
    const stp = !Number.isNaN(o.stop) ? o.stop : !Number.isNaN(o.loss) ? m.avg - d * o.loss * tick : NaN_;
    let best: Trigger | null = null;
    if (!Number.isNaN(lim)) {
      const tt = P.first(lim + d * fillAdj, t, d);
      if (tt !== null) best = { t: tt, price: tt === t ? P.at(t) : lim, leg: "profit" };
    }
    if (!Number.isNaN(stp)) {
      const tt = P.first(stp, t, -d);
      if (tt !== null && (!best || tt < best.t - TEPS)) best = { t: tt, price: (tt === t ? P.at(t) : stp) - d * slip, leg: "loss" };
    }
    if (!Number.isNaN(o.trailOffset)) {
      const ev = this.trailWalk(o, m, t, 3, false);
      if (ev && (!best || ev.t < best.t - TEPS)) best = { t: ev.t, price: ev.price - d * slip, leg: "trail" };
    }
    return best;
  }

  /** İz süren stop: etkinleşme seviyesine ulaşınca en iyi fiyattan `offset` geride izler. */
  private trailWalk(o: Order, m: Match, t0: number, until: number, commit: boolean): { t: number; price: number } | null {
    const P = this.path;
    const d = m.dir;
    const act = !Number.isNaN(o.trailPrice) ? o.trailPrice : m.avg + d * o.trailPoints * this.tick;
    const off = o.trailOffset * this.tick;
    const q = (v: number) => d * v;
    let on = o.trailOn;
    let best = o.trailBest;
    let cur = P.at(t0);
    const done = (): null => {
      if (commit) {
        o.trailOn = on;
        o.trailBest = best;
      }
      return null;
    };
    if (!on && q(cur) >= q(act)) {
      on = true;
      best = cur;
    }
    if (on) {
      if (q(cur) > q(best)) best = cur;
      if (q(cur) <= q(best) - off) return { t: t0, price: cur };
    }
    for (let k = Math.floor(t0); k < 3; k++) {
      const endT = Math.min(k + 1, until);
      if (endT <= t0) continue;
      const a = P.p[k]!;
      const b = P.p[k + 1]!;
      const end = P.at(endT);
      if (!on) {
        if (q(end) < q(act)) {
          cur = end;
          if (endT >= until) break;
          continue;
        }
        on = true;
        best = act;
        cur = act;
      }
      if (q(end) > q(cur)) {
        if (q(end) > q(best)) best = end;
      } else {
        const stop = best - d * off;
        if (q(end) <= q(stop)) {
          const ts = Math.max(t0, k + (stop - a) / (b - a));
          if (!commit) return { t: ts, price: stop };
        }
      }
      cur = end;
      if (endT >= until) break;
    }
    return done();
  }

  private advanceTrails(T: number): void {
    if (T <= this.evT) return;
    for (const o of this.orders) {
      if (o.type !== "exit" || Number.isNaN(o.trailOffset)) continue;
      const m = this.matching(o);
      if (m.qty > 0) this.trailWalk(o, m, this.evT, T, true);
    }
  }

  // ---------------------------------------------------------------- dolumlar
  private execMarket(o: Order, t: number): void {
    const S = this.rt.main;
    const i = this.cur;
    const base = t === 0 ? S.open[i]! : S.close[i]!;
    const slip = this.props.slippage * this.tick;
    if (o.type === "entry" || o.type === "order") {
      this.execEntry(o, t, base + o.dir * slip);
      return;
    }
    const list = o.type === "close_all" ? this.trades.slice() : this.trades.filter((x) => x.entryId === o.id);
    if (!list.length) return;
    const total = list.reduce((s, x) => s + x.qty, 0);
    const want = o.qty > 0 ? Math.min(o.qty, total) : o.qtyPct > 0 ? (total * Math.min(100, o.qtyPct)) / 100 : total;
    const d = list[0]!.dir;
    const px = base - d * slip;
    const label = o.comment || (o.type === "close_all" ? "Tümünü kapat" : "Kapat");
    const q = this.closeTrades(list, want, px, t, o.id, label, false, "");
    if (q > 0) this.marker(-d, label);
  }

  private execEntry(o: Order, t: number, px: number): void {
    const d = o.dir;
    if (o.type === "entry") {
      if (this.allowDir !== 0 && d !== this.allowDir) {
        // strategy.risk.allow_entry_in: izin verilmeyen yönde giriş yalnız karşı pozisyonu kapatır
        if (this.posDir === -d) {
          this.closeTrades(this.trades.slice(), Infinity, px, t, o.id, o.comment, false, "");
          this.marker(d, o.id);
        }
        return;
      }
      if (this.posDir === d && this.trades.length >= Math.max(1, this.props.pyramiding)) return;
      const q = this.qtyFor(o);
      if (!(q > 0)) return;
      if (this.posDir === -d) this.closeTrades(this.trades.slice(), Infinity, px, t, o.id, o.comment, false, "");
      this.open(o, d, q, px, t);
      this.marker(d, o.id);
      this.oca(o, q);
      return;
    }
    const q = this.qtyFor(o);
    if (!(q > 0)) return;
    let rem = q;
    if (this.posDir === -d) rem -= this.closeTrades(this.trades.slice(), q, px, t, o.id, o.comment, false, "");
    if (rem > q * 1e-9) this.open(o, d, rem, px, t);
    this.marker(d, o.id);
    this.oca(o, q);
  }

  private oca(o: Order, filled: number): void {
    if (!o.oca || o.ocaType === "none") return;
    for (const x of this.orders.slice()) {
      if (x.oca !== o.oca || x === o) continue;
      if (o.ocaType === "reduce" && x.qty > 0) {
        x.qty -= filled;
        if (x.qty <= 0) this.remove(x);
      } else this.remove(x);
    }
  }

  private execExit(o: Order, ev: Trigger): void {
    const m = this.matching(o);
    if (!(m.qty > 0)) return;
    const want = o.qty > 0 ? o.qty : ((o.qtyPct > 0 ? Math.min(100, o.qtyPct) : 100) / 100) * m.orig;
    const comment = (ev.leg === "profit" ? o.cProfit : ev.leg === "loss" ? o.cLoss : o.cTrail) || o.comment;
    const q = this.closeTrades(m.list, Math.min(want, m.qty), ev.price, this.evT, o.id, comment, true, o.id);
    if (q > 0) this.marker(-m.dir, comment || o.id);
  }

  private open(o: Order, d: number, q: number, px: number, t: number): void {
    const c = this.commOf(q, px);
    this.commission += c;
    this.trades.push({
      entryId: o.id,
      entryComment: o.comment,
      dir: d,
      qty: q,
      origQty: q,
      entryBar: this.cur,
      entryTime: this.rt.main.time[this.cur]!,
      entryPrice: px,
      comm: c,
      hi: px,
      lo: px,
      lastT: t,
      exitedBy: new Set(),
    });
  }

  /** İşlemleri (FIFO) en çok `maxQty` kadar kapatır; kapanan miktarı döndürür. */
  private closeTrades(list: Trade[], maxQty: number, px: number, t: number, exitId: string, comment: string, mark: boolean, markId: string): number {
    let left = maxQty;
    let done = 0;
    let first = true;
    for (const tr of list) {
      if (!(left > 0)) break;
      const q = Math.min(tr.qty, left);
      if (!(q > 0)) continue;
      this.touch(tr, t);
      const frac = q / tr.qty;
      const entryComm = tr.comm * frac;
      const exitComm = this.props.commissionType === "cash_per_order" && !first ? 0 : this.commOf(q, px);
      first = false;
      const pnl = tr.dir * (px - tr.entryPrice) * q - entryComm - exitComm;
      this.closed.push({
        dir: tr.dir,
        qty: q,
        entryId: tr.entryId,
        entryComment: tr.entryComment,
        entryBar: tr.entryBar,
        entryTime: tr.entryTime,
        entryPrice: tr.entryPrice,
        exitId,
        exitComment: comment,
        exitBar: this.cur,
        exitTime: this.rt.main.time[this.cur]!,
        exitPrice: px,
        profit: pnl,
        commission: entryComm + exitComm,
        runup: Math.max(0, (tr.dir > 0 ? tr.hi - tr.entryPrice : tr.entryPrice - tr.lo) * q),
        drawdown: Math.max(0, (tr.dir > 0 ? tr.entryPrice - tr.lo : tr.hi - tr.entryPrice) * q),
      });
      this.netProfit += pnl;
      this.commission += exitComm;
      if (pnl > 0) {
        this.grossProfit += pnl;
        this.wins++;
      } else if (pnl < 0) {
        this.grossLoss += pnl;
        this.losses++;
      } else this.evens++;
      tr.qty -= q;
      tr.comm -= entryComm;
      if (mark) tr.exitedBy.add(markId);
      if (tr.qty <= tr.origQty * 1e-9) this.trades.splice(this.trades.indexOf(tr), 1);
      left -= q;
      done += q;
    }
    // kapanan pozisyona bağlı çıkış emirleri iptal
    this.orders = this.orders.filter((o) => !(o.type === "exit" && o.armed && !(this.matching(o).qty > 0)));
    return done;
  }

  private touch(tr: Trade, t: number): void {
    if (t <= tr.lastT) return;
    const [lo, hi] = this.path.range(tr.lastT, t);
    if (hi > tr.hi) tr.hi = hi;
    if (lo < tr.lo) tr.lo = lo;
    tr.lastT = t;
  }

  private matching(o: Order): Match {
    const list = this.trades.filter((t) => (o.from === "" || t.entryId === o.from) && !t.exitedBy.has(o.id));
    let qty = 0;
    let orig = 0;
    let v = 0;
    for (const t of list) {
      qty += t.qty;
      orig += t.origQty;
      v += t.qty * t.entryPrice;
    }
    return { list, qty, orig, avg: qty > 0 ? v / qty : NaN_, dir: list[0]?.dir ?? 0 };
  }

  private marker(side: number, text: string): void {
    const buy = side > 0;
    this.fills.push({
      bar: this.cur,
      price: null,
      location: buy ? "belowbar" : "abovebar",
      shape: buy ? "arrowup" : "arrowdown",
      color: buy ? BUY_COLOR : SELL_COLOR,
      text,
      textcolor: null,
      size: "small",
    });
  }

  // ---------------------------------------------------------------- rapor
  report(): StrategyOut {
    const S = this.rt.main;
    const last = S.n - 1;
    const lastClose = S.close[last] ?? NaN_;
    let cum = 0;
    const trades: StrategyTradeOut[] = this.closed.map((c, i) => {
      cum += c.profit;
      return {
        n: i + 1,
        dir: c.dir > 0 ? 1 : -1,
        qty: c.qty,
        entryId: c.entryId,
        entryComment: c.entryComment,
        entryBar: c.entryBar,
        entryTime: c.entryTime,
        entryPrice: c.entryPrice,
        exitId: c.exitId,
        exitComment: c.exitComment,
        exitBar: c.exitBar,
        exitTime: c.exitTime,
        exitPrice: c.exitPrice,
        profit: c.profit,
        profitPct: (c.profit / (c.entryPrice * c.qty)) * 100,
        commission: c.commission,
        runup: c.runup,
        drawdown: c.drawdown,
        cumProfit: cum,
        open: false,
      };
    });
    const openTrades: StrategyTradeOut[] = this.trades.map((t, i) => {
      const profit = t.dir * (lastClose - t.entryPrice) * t.qty - t.comm;
      return {
        n: trades.length + i + 1,
        dir: t.dir > 0 ? 1 : -1,
        qty: t.qty,
        entryId: t.entryId,
        entryComment: t.entryComment,
        entryBar: t.entryBar,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        exitId: "",
        exitComment: "",
        exitBar: last,
        exitTime: S.time[last] ?? NaN_,
        exitPrice: lastClose,
        profit,
        profitPct: (profit / (t.entryPrice * t.qty)) * 100,
        commission: t.comm,
        runup: Math.max(0, (t.dir > 0 ? t.hi - t.entryPrice : t.entryPrice - t.lo) * t.qty),
        drawdown: Math.max(0, (t.dir > 0 ? t.entryPrice - t.lo : t.hi - t.entryPrice) * t.qty),
        cumProfit: cum + profit,
        open: true,
      };
    });
    const cap = this.props.initialCapital;
    const firstOpen = S.open[0] ?? NaN_;
    return {
      props: this.props,
      trades,
      openTrades,
      equity: this.equity,
      all: sideStats(trades, cap),
      long: sideStats(trades.filter((t) => t.dir > 0), cap),
      short: sideStats(trades.filter((t) => t.dir < 0), cap),
      openProfit: Number.isNaN(lastClose) ? 0 : this.openProfit(lastClose),
      finalEquity: Number.isNaN(lastClose) ? cap + this.netProfit : this.equityAt(lastClose),
      maxDrawdown: this.maxDD,
      maxDrawdownPct: this.maxDDPct * 100,
      maxRunup: this.maxRunup,
      maxRunupPct: this.maxRunupPct * 100,
      buyHoldPct: firstOpen > 0 ? (lastClose / firstOpen - 1) * 100 : NaN_,
      maxContracts: Math.max(this.maxLong, this.maxShort),
      pendingOrders: this.orders.length,
    };
  }

  fillShapes(): ShapeOut {
    return { id: "strategy_fills", title: "Emirler", kind: "shape", offset: 0, events: this.fills, overlay: true };
  }
}

interface Match {
  list: Trade[];
  qty: number;
  orig: number;
  avg: number;
  dir: number;
}

export function sideStats(ts: StrategyTradeOut[], capital: number): StrategySide {
  const wins = ts.filter((t) => t.profit > 0);
  const losses = ts.filter((t) => t.profit < 0);
  const sum = (xs: StrategyTradeOut[], f: (t: StrategyTradeOut) => number) => xs.reduce((s, t) => s + f(t), 0);
  const avg = (xs: StrategyTradeOut[], f: (t: StrategyTradeOut) => number) => (xs.length ? sum(xs, f) / xs.length : NaN_);
  const grossProfit = sum(wins, (t) => t.profit);
  const grossLoss = sum(losses, (t) => t.profit);
  const net = sum(ts, (t) => t.profit);
  let cw = 0;
  let cl = 0;
  let mw = 0;
  let ml = 0;
  for (const t of ts) {
    if (t.profit > 0) {
      cw++;
      cl = 0;
    } else if (t.profit < 0) {
      cl++;
      cw = 0;
    } else {
      cw = 0;
      cl = 0;
    }
    mw = Math.max(mw, cw);
    ml = Math.max(ml, cl);
  }
  const avgWin = avg(wins, (t) => t.profit);
  const avgLoss = avg(losses, (t) => t.profit);
  const bars = (t: StrategyTradeOut) => t.exitBar - t.entryBar;
  return {
    netProfit: net,
    netProfitPct: capital > 0 ? (net / capital) * 100 : NaN_,
    grossProfit,
    grossLoss,
    commission: sum(ts, (t) => t.commission),
    trades: ts.length,
    wins: wins.length,
    losses: losses.length,
    evens: ts.length - wins.length - losses.length,
    winRate: ts.length ? (wins.length / ts.length) * 100 : NaN_,
    avgTrade: avg(ts, (t) => t.profit),
    avgTradePct: avg(ts, (t) => t.profitPct),
    avgWin,
    avgWinPct: avg(wins, (t) => t.profitPct),
    avgLoss,
    avgLossPct: avg(losses, (t) => t.profitPct),
    ratioWinLoss: avgLoss < 0 && avgWin > 0 ? avgWin / -avgLoss : NaN_,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.profit)) : NaN_,
    largestWinPct: wins.length ? Math.max(...wins.map((t) => t.profitPct)) : NaN_,
    largestLoss: losses.length ? Math.min(...losses.map((t) => t.profit)) : NaN_,
    largestLossPct: losses.length ? Math.min(...losses.map((t) => t.profitPct)) : NaN_,
    avgBars: avg(ts, bars),
    avgBarsWin: avg(wins, bars),
    avgBarsLoss: avg(losses, bars),
    profitFactor: grossLoss < 0 ? grossProfit / -grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : NaN_,
    maxConsecWins: mw,
    maxConsecLosses: ml,
  };
}

// ------------------------------------------------------------------ strategy() ve ayar formu

const QTY_LABELS: [QtyType, string][] = [
  ["percent_of_equity", "Özsermaye %"],
  ["fixed", "Adet (kontrat)"],
  ["cash", "USDT"],
];
const COMM_LABELS: [CommissionType, string][] = [
  ["percent", "%"],
  ["cash_per_contract", "Kontrat başına (USDT)"],
  ["cash_per_order", "Emir başına (USDT)"],
];
const PROP_GROUP = "Strateji özellikleri";

function labelOf<T extends string>(pairs: [T, string][], v: T): string {
  return pairs.find((p) => p[0] === v)?.[1] ?? pairs[0]![1];
}

function valueOf<T extends string>(pairs: [T, string][], label: unknown, fallback: T): T {
  if (typeof label !== "string") return fallback;
  return pairs.find((p) => p[1] === label || p[0] === label)?.[0] ?? fallback;
}

/** Ayar formunda gösterilen strateji özellikleri (anahtarlar `__s.` önekli; girdi değerleriyle saklanır). */
export function propInputs(d: StrategyProps): InputMeta[] {
  const g = PROP_GROUP;
  return [
    { key: "__s.capital", title: "Başlangıç sermayesi (USDT)", type: "float", defval: d.initialCapital, minval: 1, group: g },
    { key: "__s.qty_type", title: "Emir büyüklüğü birimi", type: "string", defval: labelOf(QTY_LABELS, d.qtyType), options: QTY_LABELS.map((x) => x[1]), group: g },
    { key: "__s.qty", title: "Emir büyüklüğü", type: "float", defval: d.qtyValue, minval: 0, group: g },
    { key: "__s.pyramiding", title: "Aynı yönde en çok giriş (piramit)", type: "int", defval: Math.max(1, d.pyramiding), minval: 1, maxval: 100, group: g },
    { key: "__s.comm_type", title: "Komisyon birimi", type: "string", defval: labelOf(COMM_LABELS, d.commissionType), options: COMM_LABELS.map((x) => x[1]), group: g },
    { key: "__s.comm", title: "Komisyon", type: "float", defval: d.commissionValue, minval: 0, step: 0.01, group: g, tooltip: "Binance vadeli piyasa emri (taker) ≈ %0,05" },
    { key: "__s.slippage", title: "Kayma (tik)", type: "int", defval: d.slippage, minval: 0, group: g },
    { key: "__s.on_close", title: "Emirleri mum kapanışında doldur", type: "bool", defval: d.processOrdersOnClose, group: g },
  ];
}

function applyOverrides(d: StrategyProps, v: Record<string, unknown>): StrategyProps {
  const numOr = (x: unknown, f: number) => (typeof x === "number" && Number.isFinite(x) ? x : f);
  return {
    ...d,
    initialCapital: Math.max(1, numOr(v["__s.capital"], d.initialCapital)),
    qtyType: valueOf(QTY_LABELS, v["__s.qty_type"], d.qtyType),
    qtyValue: Math.max(0, numOr(v["__s.qty"], d.qtyValue)),
    pyramiding: Math.max(0, Math.floor(numOr(v["__s.pyramiding"], d.pyramiding))),
    commissionType: valueOf(COMM_LABELS, v["__s.comm_type"], d.commissionType),
    commissionValue: Math.max(0, numOr(v["__s.comm"], d.commissionValue)),
    slippage: Math.max(0, Math.floor(numOr(v["__s.slippage"], d.slippage))),
    processOrdersOnClose: typeof v["__s.on_close"] === "boolean" ? (v["__s.on_close"] as boolean) : d.processOrdersOnClose,
  };
}

const STRATEGY_PARAMS = [
  "title", "shorttitle", "overlay", "format", "precision", "scale", "pyramiding", "calc_on_order_fills",
  "calc_on_every_tick", "max_bars_back", "backtest_fill_limits_assumption", "default_qty_type", "default_qty_value",
  "initial_capital", "currency", "slippage", "commission_type", "commission_value", "process_orders_on_close",
  "close_entries_rule", "margin_long", "margin_short", "explicit_plot_zorder", "max_lines_count", "max_labels_count",
  "max_boxes_count", "calc_bars_count", "risk_free_rate", "use_bar_magnifier", "fill_orders_on_standard_ohlc",
  "max_polylines_count", "dynamic_requests", "behind_chart",
];

function str(v: unknown, f = ""): string {
  return typeof v === "string" ? v : f;
}

function numv(v: unknown, f: number): number {
  const x = n(v);
  return Number.isNaN(x) ? f : x;
}

function eng(rt: Runtime, fn: string): StrategyEngine {
  if (!rt.strategy) throw runtimeError(`${fn} yalnız strategy(…) betiklerinde kullanılabilir`);
  return rt.strategy;
}

function dirOf(v: unknown, fn: string): number {
  if (v === "long" || v === true) return 1;
  if (v === "short" || v === false) return -1;
  throw runtimeError(`${fn}: yön strategy.long ya da strategy.short olmalı`);
}

function whenOff(w: unknown): boolean {
  return w !== undefined && !truthy(w);
}

function priceArg(v: unknown): number {
  const x = n(v);
  return Number.isFinite(x) ? x : NaN_;
}

// v5/v6 parametre sırası (+ v4 adları "when", "long" sonda); v4 sırası ayrıca (konumsal argümanlar için)
const ENTRY_P = ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert", "when", "long"];
const ENTRY_V4 = ["id", "long", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "when", "alert_message"];
const CLOSE_P = ["id", "comment", "qty", "qty_percent", "alert_message", "immediately", "disable_alert", "when"];
const CLOSE_V4 = ["id", "when", "comment", "qty", "qty_percent", "alert_message"];
const CLOSE_ALL_P = ["comment", "alert_message", "immediately", "disable_alert", "when"];
const CLOSE_ALL_V4 = ["when", "comment", "alert_message"];
const EXIT_P = [
  "id", "from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points",
  "trail_offset", "oca_name", "comment", "comment_profit", "comment_loss", "comment_trailing", "alert_message",
  "alert_profit", "alert_loss", "alert_trailing", "disable_alert", "when",
];
const EXIT_V4 = [
  "id", "from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points",
  "trail_offset", "oca_name", "comment", "when", "alert_message",
];

function entryFn(type: "entry" | "order"): BuiltinDef {
  const fn = `strategy.${type}`;
  return {
    params: ENTRY_P,
    v4params: ENTRY_V4,
    fn: (rt, _f, _s, a) => {
      if (!rt.isMain) return NaN_;
      const e = eng(rt, fn);
      if (whenOff(a[10])) return NaN_;
      const id = str(a[0]);
      if (!id) throw runtimeError(`${fn}: kimlik (id) gerekli`);
      const d = dirOf(a[1] ?? a[11], fn);
      e.entry(type, id, d, n(a[2]), priceArg(a[3]), priceArg(a[4]), str(a[5]), str(a[6], "none"), str(a[7]));
      return NaN_;
    },
  };
}

type Getter = (rt: Runtime, e: StrategyEngine) => unknown;

function need(rt: Runtime): StrategyEngine {
  return eng(rt, "strategy.* değişkenleri");
}

function wrapVars(o: Record<string, Getter>): Record<string, (rt: Runtime) => unknown> {
  const out: Record<string, (rt: Runtime) => unknown> = {};
  for (const [k, g] of Object.entries(o)) out[k] = (rt) => g(rt, need(rt));
  return out;
}

const pctOfCap = (e: StrategyEngine, v: number) => (v / e.props.initialCapital) * 100;

export const STRATEGY_VARS: Record<string, (rt: Runtime) => unknown> = wrapVars({
  "strategy.position_size": (_rt, e) => e.positionSize,
  "strategy.position_avg_price": (_rt, e) => e.avgPrice,
  "strategy.position_entry_name": (_rt, e) => e.entryName,
  "strategy.equity": (rt, e) => e.equityAt(rt.main.close[rt.bar]!),
  "strategy.netprofit": (_rt, e) => e.netProfit,
  "strategy.netprofit_percent": (_rt, e) => pctOfCap(e, e.netProfit),
  "strategy.openprofit": (rt, e) => e.openProfit(rt.main.close[rt.bar]!),
  "strategy.openprofit_percent": (rt, e) => pctOfCap(e, e.openProfit(rt.main.close[rt.bar]!)),
  "strategy.grossprofit": (_rt, e) => e.grossProfit,
  "strategy.grossprofit_percent": (_rt, e) => pctOfCap(e, e.grossProfit),
  "strategy.grossloss": (_rt, e) => -e.grossLoss,
  "strategy.grossloss_percent": (_rt, e) => pctOfCap(e, -e.grossLoss),
  "strategy.closedtrades": (_rt, e) => e.closed.length,
  "strategy.opentrades": (_rt, e) => e.openTradeList.length,
  "strategy.wintrades": (_rt, e) => e.wins,
  "strategy.losstrades": (_rt, e) => e.losses,
  "strategy.eventrades": (_rt, e) => e.evens,
  "strategy.initial_capital": (_rt, e) => e.props.initialCapital,
  "strategy.max_drawdown": (_rt, e) => e.maxDD,
  "strategy.max_drawdown_percent": (_rt, e) => e.maxDDPct * 100,
  "strategy.max_runup": (_rt, e) => e.maxRunup,
  "strategy.max_runup_percent": (_rt, e) => e.maxRunupPct * 100,
  "strategy.max_contracts_held_all": (_rt, e) => Math.max(e.maxLong, e.maxShort),
  "strategy.max_contracts_held_long": (_rt, e) => e.maxLong,
  "strategy.max_contracts_held_short": (_rt, e) => e.maxShort,
  "strategy.avg_trade": (_rt, e) => (e.closed.length ? e.netProfit / e.closed.length : NaN_),
  "strategy.avg_winning_trade": (_rt, e) => (e.wins ? e.grossProfit / e.wins : NaN_),
  "strategy.avg_losing_trade": (_rt, e) => (e.losses ? -e.grossLoss / e.losses : NaN_),
  "strategy.account_currency": () => "USDT",
  "strategy.margin_liquidation_price": () => NaN_,
  "strategy.closedtrades.first_index": () => 0,
});

export const STRATEGY_CONSTS: Record<string, unknown> = {
  "strategy.long": "long",
  "strategy.short": "short",
  "strategy.fixed": "fixed",
  "strategy.cash": "cash",
  "strategy.percent_of_equity": "percent_of_equity",
  "strategy.commission.percent": "percent",
  "strategy.commission.cash_per_contract": "cash_per_contract",
  "strategy.commission.cash_per_order": "cash_per_order",
  "strategy.oca.none": "none",
  "strategy.oca.cancel": "cancel",
  "strategy.oca.reduce": "reduce",
  "strategy.direction.all": "all",
  "strategy.direction.long": "long",
  "strategy.direction.short": "short",
};

type TradeField = (t: StrategyTradeOut | Closed | Trade, e: StrategyEngine, rt: Runtime) => unknown;

function tradeFns(prefix: "closedtrades" | "opentrades", fields: Record<string, TradeField>): Record<string, BuiltinDef> {
  const out: Record<string, BuiltinDef> = {};
  for (const [name, get] of Object.entries(fields)) {
    const fn = `strategy.${prefix}.${name}`;
    out[fn] = def(["trade_num"], (rt, _f, _s, a) => {
      const e = eng(rt, fn);
      const list: readonly (Closed | Trade)[] = prefix === "closedtrades" ? e.closed : e.openTradeList;
      const i = Math.floor(n(a[0]));
      const t = i >= 0 && i < list.length ? list[i] : undefined;
      return t ? get(t, e, rt) : NaN_;
    });
  }
  return out;
}

const tf = <K extends keyof Closed>(k: K): TradeField => (t) => (t as unknown as Closed)[k];
const openProfitOf = (t: Trade, rt: Runtime) => t.dir * (rt.main.close[rt.bar]! - t.entryPrice) * t.qty - t.comm;

export const STRATEGY_FUNCS: Record<string, BuiltinDef> = {
  strategy: def(STRATEGY_PARAMS, (rt, _f, _s, a) => {
    if (rt.metaSet || !rt.isMain) return NaN_;
    rt.metaSet = true;
    const title = str(a[0]) || "Strateji";
    rt.meta = {
      title,
      shorttitle: str(a[1]) || title,
      overlay: a[2] === true,
      format: typeof a[3] === "string" ? a[3] : null,
      precision: a[4] === undefined ? null : Math.floor(n(a[4])),
    };
    const d: StrategyProps = {
      initialCapital: Math.max(1, numv(a[13], DEFAULT_PROPS.initialCapital)),
      qtyType: (["fixed", "cash", "percent_of_equity"].includes(str(a[11])) ? a[11] : "fixed") as QtyType,
      qtyValue: Math.max(0, numv(a[12], 1)),
      pyramiding: Math.max(0, Math.floor(numv(a[6], 0))),
      commissionType: (["percent", "cash_per_contract", "cash_per_order"].includes(str(a[16])) ? a[16] : "percent") as CommissionType,
      commissionValue: Math.max(0, numv(a[17], 0)),
      slippage: Math.max(0, Math.floor(numv(a[15], 0))),
      processOrdersOnClose: a[18] === true,
      calcOnEveryTick: a[8] === true,
      fillLimitsTicks: Math.max(0, Math.floor(numv(a[10], 0))),
    };
    if (a[7] === true) rt.warn("calc_on_order_fills desteklenmiyor; betik yalnız mum kapanışında çalışır");
    if ((a[20] !== undefined && numv(a[20], 100) < 100) || (a[21] !== undefined && numv(a[21], 100) < 100)) {
      rt.warn("Kaldıraç/teminat (margin) ve likidasyon hesaplanmıyor");
    }
    if (a[19] === "ANY") rt.warn("close_entries_rule=\"ANY\": kapatma emirleri kimliğe göre uygulanır (FIFO ile aynı sonuç verebilir)");
    rt.strategy = new StrategyEngine(rt, d, applyOverrides(d, rt.inputValues));
    return NaN_;
  }),
  "strategy.entry": entryFn("entry"),
  "strategy.order": entryFn("order"),
  "strategy.close": {
    params: CLOSE_P,
    v4params: CLOSE_V4,
    fn: (rt, _f, _s, a) => {
      if (!rt.isMain) return NaN_;
      const e = eng(rt, "strategy.close");
      if (whenOff(a[7])) return NaN_;
      e.closeOrder(str(a[0]), n(a[2]), n(a[3]), str(a[1]), a[5] === true);
      return NaN_;
    },
  },
  "strategy.close_all": {
    params: CLOSE_ALL_P,
    v4params: CLOSE_ALL_V4,
    fn: (rt, _f, _s, a) => {
      if (!rt.isMain) return NaN_;
      const e = eng(rt, "strategy.close_all");
      if (whenOff(a[4])) return NaN_;
      e.closeOrder(null, NaN_, NaN_, str(a[0]), a[2] === true);
      return NaN_;
    },
  },
  "strategy.exit": {
    params: EXIT_P,
    v4params: EXIT_V4,
    fn: (rt, _f, _s, a) => {
      if (!rt.isMain) return NaN_;
      const e = eng(rt, "strategy.exit");
      if (whenOff(a[21])) return NaN_;
      const id = str(a[0]);
      if (!id) throw runtimeError("strategy.exit: kimlik (id) gerekli");
      e.exit(
        id,
        str(a[1]),
        n(a[2]),
        n(a[3]),
        priceArg(a[4]),
        priceArg(a[5]),
        priceArg(a[6]),
        priceArg(a[7]),
        priceArg(a[8]),
        priceArg(a[9]),
        priceArg(a[10]),
        str(a[12]),
        str(a[13]),
        str(a[14]),
        str(a[15]),
      );
      return NaN_;
    },
  },
  "strategy.cancel": {
    params: ["id", "when"],
    v4params: ["id", "when"],
    fn: (rt, _f, _s, a) => {
      if (whenOff(a[1])) return NaN_;
      eng(rt, "strategy.cancel").cancel(str(a[0]));
      return NaN_;
    },
  },
  "strategy.cancel_all": {
    params: ["when"],
    v4params: ["when"],
    fn: (rt, _f, _s, a) => {
      if (whenOff(a[0])) return NaN_;
      eng(rt, "strategy.cancel_all").cancel(null);
      return NaN_;
    },
  },
  "strategy.risk.allow_entry_in": def(["value"], (rt, _f, _s, a) => {
    const e = eng(rt, "strategy.risk.allow_entry_in");
    e.allowDir = a[0] === "long" ? 1 : a[0] === "short" ? -1 : 0;
    return NaN_;
  }),
  ...Object.fromEntries(
    ["max_drawdown", "max_intraday_loss", "max_cons_loss_days", "max_intraday_filled_orders", "max_position_size"].map((k) => [
      `strategy.risk.${k}`,
      def([], (rt) => {
        eng(rt, `strategy.risk.${k}`);
        rt.warn(`strategy.risk.${k} uygulanmıyor (yok sayıldı)`);
        return NaN_;
      }),
    ]),
  ),
  "strategy.convert_to_account": def(["value"], (_rt, _f, _s, a) => n(a[0])),
  "strategy.convert_to_symbol": def(["value"], (_rt, _f, _s, a) => n(a[0])),
  "strategy.default_entry_qty": def(["fill_price"], (rt, _f, _s, a) => {
    const e = eng(rt, "strategy.default_entry_qty");
    const p = n(a[0]);
    const pr = e.props;
    if (pr.qtyType === "fixed") return pr.qtyValue;
    if (!(p > 0)) return NaN_;
    return pr.qtyType === "cash" ? pr.qtyValue / p : (e.equityAt(rt.main.close[rt.bar]!) * pr.qtyValue) / 100 / p;
  }),
  ...tradeFns("closedtrades", {
    entry_price: tf("entryPrice"),
    exit_price: tf("exitPrice"),
    entry_bar_index: tf("entryBar"),
    exit_bar_index: tf("exitBar"),
    entry_time: tf("entryTime"),
    exit_time: tf("exitTime"),
    entry_id: tf("entryId"),
    exit_id: tf("exitId"),
    entry_comment: tf("entryComment"),
    exit_comment: tf("exitComment"),
    profit: tf("profit"),
    profit_percent: (t) => {
      const c = t as Closed;
      return (c.profit / (c.entryPrice * c.qty)) * 100;
    },
    size: (t) => (t as Closed).dir * (t as Closed).qty,
    commission: tf("commission"),
    max_runup: tf("runup"),
    max_drawdown: tf("drawdown"),
    max_runup_percent: (t) => ((t as Closed).runup / ((t as Closed).entryPrice * (t as Closed).qty)) * 100,
    max_drawdown_percent: (t) => ((t as Closed).drawdown / ((t as Closed).entryPrice * (t as Closed).qty)) * 100,
  }),
  ...tradeFns("opentrades", {
    entry_price: (t) => (t as Trade).entryPrice,
    entry_bar_index: (t) => (t as Trade).entryBar,
    entry_time: (t) => (t as Trade).entryTime,
    entry_id: (t) => (t as Trade).entryId,
    entry_comment: (t) => (t as Trade).entryComment,
    size: (t) => (t as Trade).dir * (t as Trade).qty,
    commission: (t) => (t as Trade).comm,
    profit: (t, _e, rt) => openProfitOf(t as Trade, rt),
    profit_percent: (t, _e, rt) => (openProfitOf(t as Trade, rt) / ((t as Trade).entryPrice * (t as Trade).qty)) * 100,
    max_runup: (t) => {
      const x = t as Trade;
      return Math.max(0, (x.dir > 0 ? x.hi - x.entryPrice : x.entryPrice - x.lo) * x.qty);
    },
    max_drawdown: (t) => {
      const x = t as Trade;
      return Math.max(0, (x.dir > 0 ? x.entryPrice - x.lo : x.hi - x.entryPrice) * x.qty);
    },
  }),
};
