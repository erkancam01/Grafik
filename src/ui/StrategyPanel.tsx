/**
 * Strateji Test Aracı: grafiğin altında özet şeridi; dokununca çekmece (Özet · İşlemler).
 * Özet: ana göstergeler, özsermaye eğrisi (al-ve-tut ile), Tümü/Long/Short tablosu, test ayarları ve dönemi.
 */
import { useMemo, useState, type ReactNode } from "react";
import { fmtNum, priceDigits } from "../chart/render";
import type { BarsData, StrategyOut, StrategyProps, StrategySide, StrategyTradeOut } from "../pine/types";
import { daysAgo, fromDateInput, startOfYear, toDateInput } from "./dates";
import { IconChart, IconChevron, IconGear } from "./icons";
import { Sheet } from "./Sheet";

export interface StrategyEntry {
  uid: string;
  title: string;
  out: StrategyOut;
  warnings: string[];
}

const sgn = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "");

export function money(v: number, digits = 2): string {
  return Number.isFinite(v) ? `${sgn(v)}${fmtNum(Math.abs(v), digits)}` : "—";
}

export function pct(v: number): string {
  return Number.isFinite(v) ? `${sgn(v)}${fmtNum(Math.abs(v), 2)}%` : "—";
}

function plain(v: number, max = 4): string {
  return Number.isFinite(v) ? v.toLocaleString("tr-TR", { maximumFractionDigits: max }) : "—";
}

function ratio(v: number): string {
  if (v === Number.POSITIVE_INFINITY) return "∞";
  return Number.isFinite(v) ? fmtNum(v, 2) : "—";
}

function when(ms: number): string {
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "—";
}

function propsText(p: StrategyProps): string {
  const size =
    p.qtyType === "percent_of_equity"
      ? `özsermayenin %${plain(p.qtyValue)}'ü`
      : p.qtyType === "cash"
        ? `${plain(p.qtyValue)} USDT`
        : `${plain(p.qtyValue, 8)} adet`;
  const comm =
    p.commissionValue > 0
      ? p.commissionType === "percent"
        ? `%${plain(p.commissionValue)}`
        : `${plain(p.commissionValue)} USDT/${p.commissionType === "cash_per_contract" ? "kontrat" : "emir"}`
      : "yok";
  const parts = [
    `Sermaye ${plain(p.initialCapital, 2)} USDT`,
    `Boyut ${size}`,
    `Komisyon ${comm}`,
    `Aynı yönde en çok ${Math.max(1, p.pyramiding)} giriş`,
  ];
  if (p.slippage) parts.push(`Kayma ${p.slippage} tik`);
  if (p.processOrdersOnClose) parts.push("Emirler kapanışta dolar");
  return parts.join(" · ");
}

// ------------------------------------------------------------------ alt şerit

export function StrategyStrip({ entry, onOpen, busy = false }: { entry: StrategyEntry; onOpen: () => void; busy?: boolean }) {
  const s = entry.out;
  return (
    <button
      type="button"
      className="flex h-10 w-full shrink-0 items-center gap-2 border-t border-line bg-panel px-2.5 text-left text-[12px]"
      onClick={onOpen}
      data-testid="strategy-strip"
      aria-label="Strateji Test Aracı'nı aç"
    >
      <IconChart size={15} className="shrink-0 text-accent" />
      <span className="min-w-0 max-w-[32%] truncate font-medium">{entry.title}</span>
      <span className={`shrink-0 font-semibold tabular-nums ${tone(s.all.netProfit)}`} data-testid="strategy-net">
        {pct(s.all.netProfitPct)}
      </span>
      <span className="flex min-w-0 flex-1 gap-2.5 overflow-hidden whitespace-nowrap tabular-nums text-muted">
        <span>{s.all.trades} işlem</span>
        <span>Kârlı {Number.isFinite(s.all.winRate) ? `%${fmtNum(s.all.winRate, 1)}` : "—"}</span>
        <span>Düşüş %{fmtNum(s.maxDrawdownPct, 1)}</span>
        <span>KF {ratio(s.all.profitFactor)}</span>
        {busy && <span className="text-subtle">geçmiş yükleniyor…</span>}
      </span>
      <IconChevron size={14} className="shrink-0 rotate-180 text-muted" />
    </button>
  );
}

// ------------------------------------------------------------------ özsermaye eğrisi

function EquityChart({ out, bars }: { out: StrategyOut; bars: BarsData | null }) {
  const W = 600;
  const H = 150;
  const cap = out.props.initialCapital;
  const d = useMemo(() => {
    const eq = out.equity;
    const len = bars ? Math.min(eq.length, bars.time.length) : eq.length;
    // yalnız test aralığı (aralık dışında özsermaye NaN)
    let a = 0;
    while (a < len && !Number.isFinite(eq[a]!)) a++;
    let b = len - 1;
    while (b > a && !Number.isFinite(eq[b]!)) b--;
    const n = b - a + 1;
    if (n < 2) return null;
    const step = Math.max(1, Math.floor(n / W));
    const idx: number[] = [];
    for (let i = a; i <= b; i += step) idx.push(i);
    if (idx[idx.length - 1] !== b) idx.push(b);
    const open0 = bars?.open[a] ?? Number.NaN;
    const bh = (i: number) => (bars && open0 > 0 ? (cap * bars.close[i]!) / open0 : Number.NaN);
    let lo = cap;
    let hi = cap;
    for (const i of idx) {
      for (const v of [eq[i]!, bh(i)]) {
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const pad = (hi - lo) * 0.06 || cap * 0.01;
    lo -= pad;
    hi += pad;
    const x = (i: number) => (((i - a) / (n - 1)) * W).toFixed(1);
    const y = (v: number) => (H - ((v - lo) / (hi - lo)) * H).toFixed(1);
    const line = (f: (i: number) => number) =>
      idx
        .filter((i) => Number.isFinite(f(i)))
        .map((i) => `${x(i)},${y(f(i))}`)
        .join(" ");
    return { eq: line((i) => eq[i]!), bh: line(bh), base: y(cap) };
  }, [out, bars, cap]);
  if (!d) return null;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[150px] w-full" data-testid="equity-chart" aria-label="Özsermaye eğrisi">
        <line x1="0" x2={W} y1={d.base} y2={d.base} stroke="var(--line)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <polyline points={d.bh} fill="none" stroke="var(--subtle)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <polyline points={d.eq} fill="none" stroke="var(--accent)" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex gap-3 text-[11px] text-subtle">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-accent" /> Özsermaye
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0 w-4 border-t border-dashed border-subtle" /> Al ve tut
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ test dönemi

const PRESETS: [string, () => [number, number]][] = [
  ["Tümü", () => [Number.NaN, Number.NaN]],
  ["30 gün", () => [daysAgo(30), Number.NaN]],
  ["90 gün", () => [daysAgo(90), Number.NaN]],
  ["6 ay", () => [daysAgo(182), Number.NaN]],
  ["1 yıl", () => [daysAgo(365), Number.NaN]],
  ["2 yıl", () => [daysAgo(730), Number.NaN]],
  ["3 yıl", () => [daysAgo(1095), Number.NaN]],
  ["Bu yıl", () => [startOfYear(), Number.NaN]],
];

const sameTime = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

function RangeBar({ from, to, onRange }: { from: number; to: number; onRange: (from: number, to: number) => void }) {
  return (
    <div className="space-y-1.5" data-testid="range-bar">
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-muted">
          Test başlangıcı
          <input
            type="date"
            className="input mt-0.5 h-8 px-2 text-[13px]"
            title="Boş: yüklü verinin başından"
            data-testid="range-from"
            value={toDateInput(from)}
            onChange={(e) => !e.target.validity.badInput && onRange(e.target.value ? fromDateInput(e.target.value) : Number.NaN, to)}
          />
        </label>
        <label className="block text-[11px] text-muted">
          Test bitişi
          <input
            type="date"
            className="input mt-0.5 h-8 px-2 text-[13px]"
            title="Boş: bugüne kadar"
            data-testid="range-to"
            value={toDateInput(to)}
            onChange={(e) => !e.target.validity.badInput && onRange(from, e.target.value ? fromDateInput(e.target.value, true) : Number.NaN)}
          />
        </label>
      </div>
      <div className="scroll-x flex gap-1">
        {PRESETS.map(([label, f]) => {
          const [a, b] = f();
          return (
            <button
              key={label}
              type="button"
              className="pill shrink-0"
              aria-pressed={sameTime(a, from) && sameTime(b, to)}
              onClick={() => onRange(a, b)}
              data-testid={`range-${label}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ çekmece

const ROWS: [string, (s: StrategySide) => ReactNode][] = [
  ["Net kâr", (s) => <Val v={s.netProfit} sub={pct(s.netProfitPct)} />],
  ["Brüt kâr", (s) => money(s.grossProfit)],
  ["Brüt zarar", (s) => money(s.grossLoss)],
  ["Kâr faktörü", (s) => ratio(s.profitFactor)],
  ["Ödenen komisyon", (s) => fmtNum(s.commission, 2)],
  ["Kapanan işlem", (s) => s.trades],
  ["Kazanan / kaybeden", (s) => `${s.wins} / ${s.losses}`],
  ["Kârlı işlem oranı", (s) => (Number.isFinite(s.winRate) ? `%${fmtNum(s.winRate, 2)}` : "—")],
  ["Ortalama işlem", (s) => <Val v={s.avgTrade} sub={pct(s.avgTradePct)} />],
  ["Ortalama kazanç", (s) => <Val v={s.avgWin} sub={pct(s.avgWinPct)} />],
  ["Ortalama kayıp", (s) => <Val v={s.avgLoss} sub={pct(s.avgLossPct)} />],
  ["Kazanç / kayıp oranı", (s) => ratio(s.ratioWinLoss)],
  ["En büyük kazanç", (s) => <Val v={s.largestWin} sub={pct(s.largestWinPct)} />],
  ["En büyük kayıp", (s) => <Val v={s.largestLoss} sub={pct(s.largestLossPct)} />],
  ["Ardışık en çok kayıp", (s) => s.maxConsecLosses],
  ["İşlemde ort. mum", (s) => (Number.isFinite(s.avgBars) ? fmtNum(s.avgBars, 1) : "—")],
];

function Val({ v, sub }: { v: number; sub?: string }) {
  return (
    <span className={tone(v)}>
      {money(v)}
      {sub && Number.isFinite(v) ? <span className="block text-[11px] opacity-80">{sub}</span> : null}
    </span>
  );
}

function Kpi({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="rounded-md bg-panel-2/60 px-2.5 py-2" data-testid={testId}>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums">{children}</div>
    </div>
  );
}

function TradeRow({ t, digits, onPick }: { t: StrategyTradeOut; digits: number; onPick: () => void }) {
  return (
    <li>
      <button type="button" className="w-full px-3 py-2 text-left hover:bg-panel-2" onClick={onPick} data-testid="trade-row">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="w-9 shrink-0 tabular-nums text-subtle">#{t.n}</span>
          <span className={`rounded px-1.5 text-[11px] font-semibold ${t.dir > 0 ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>
            {t.dir > 0 ? "Long" : "Short"}
          </span>
          {t.open && <span className="rounded bg-warn/15 px-1.5 text-[11px] font-semibold text-warn">Açık</span>}
          <span className="flex-1" />
          <span className={`font-semibold tabular-nums ${tone(t.profit)}`}>{money(t.profit)}</span>
          <span className={`w-16 text-right tabular-nums text-[12px] ${tone(t.profit)}`}>{pct(t.profitPct)}</span>
        </div>
        <div className="mt-0.5 grid grid-cols-[3.2rem_1fr] gap-x-1 pl-11 text-[12px] text-muted tabular-nums">
          <span>Giriş</span>
          <span className="truncate">
            {when(t.entryTime)} · {fmtNum(t.entryPrice, digits)} · {t.entryComment || t.entryId} · {plain(t.qty, 6)} adet
          </span>
          <span>{t.open ? "Şimdi" : "Çıkış"}</span>
          <span className="truncate">
            {when(t.exitTime)} · {fmtNum(t.exitPrice, digits)}
            {t.open ? "" : ` · ${t.exitComment || t.exitId}`}
          </span>
        </div>
      </button>
    </li>
  );
}

export function StrategySheet({
  open,
  onClose,
  entries,
  selected,
  onSelect,
  bars,
  onSettings,
  onFocus,
  canLoadMore,
  loadingMore,
  onLoadMore,
  range,
  onRange,
}: {
  open: boolean;
  onClose: () => void;
  entries: StrategyEntry[];
  selected: StrategyEntry;
  onSelect: (uid: string) => void;
  bars: BarsData | null;
  onSettings: () => void;
  onFocus: (t: StrategyTradeOut) => void;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  range: { from: number; to: number };
  onRange: (from: number, to: number) => void;
}) {
  const [tab, setTab] = useState<"summary" | "trades">("summary");
  const [limit, setLimit] = useState(200);
  const s = selected.out;
  const digits = bars && bars.time.length ? priceDigits(bars.close[bars.time.length - 1]!) : 2;
  const list = useMemo(() => [...s.openTrades, ...s.trades.slice().reverse()], [s]);
  const n = bars?.time.length ?? 0;

  return (
    <Sheet open={open} title="Strateji Test Aracı" onClose={onClose} wide testId="strategy-sheet">
      <div className="space-y-1.5 border-b border-line px-3 py-2">
        {entries.length > 1 && (
          <div className="scroll-x flex gap-1">
            {entries.map((e) => (
              <button key={e.uid} type="button" className="pill shrink-0" aria-pressed={e.uid === selected.uid} onClick={() => onSelect(e.uid)}>
                {e.title}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1">
          <div role="tablist" className="flex gap-1">
            <button type="button" role="tab" className="pill" aria-pressed={tab === "summary"} aria-selected={tab === "summary"} onClick={() => setTab("summary")} data-testid="st-tab-summary">
              Özet
            </button>
            <button type="button" role="tab" className="pill" aria-pressed={tab === "trades"} aria-selected={tab === "trades"} onClick={() => setTab("trades")} data-testid="st-tab-trades">
              İşlemler ({s.trades.length + s.openTrades.length})
            </button>
          </div>
          <span className="flex-1" />
          <button type="button" className="btn btn-outline h-8" onClick={onSettings} data-testid="st-settings">
            <IconGear size={14} /> Ayarlar
          </button>
        </div>
        <RangeBar from={range.from} to={range.to} onRange={onRange} />
      </div>

      {tab === "summary" && (
        <div className="space-y-3 p-3" data-testid="strategy-summary">
          <div className="text-[13px] font-medium">{selected.title}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="Net kâr (USDT)" testId="kpi-net">
              <Val v={s.all.netProfit} sub={pct(s.all.netProfitPct)} />
            </Kpi>
            <Kpi label="Kapanan işlem">
              {s.all.trades}
              {s.openTrades.length ? <span className="ml-1 text-[11px] font-normal text-muted">+{s.openTrades.length} açık</span> : null}
            </Kpi>
            <Kpi label="Kârlı işlem">
              {Number.isFinite(s.all.winRate) ? `%${fmtNum(s.all.winRate, 1)}` : "—"}
              <span className="ml-1 text-[11px] font-normal text-muted">
                {s.all.wins}/{s.all.trades}
              </span>
            </Kpi>
            <Kpi label="Kâr faktörü">{ratio(s.all.profitFactor)}</Kpi>
            <Kpi label="Maks. düşüş">
              <span className="text-down">{fmtNum(s.maxDrawdown, 2)}</span>
              <span className="block text-[11px] font-normal text-muted">%{fmtNum(s.maxDrawdownPct, 2)}</span>
            </Kpi>
            <Kpi label="Al ve tut">
              <span className={tone(s.buyHoldPct)}>{pct(s.buyHoldPct)}</span>
            </Kpi>
            <Kpi label="Açık K/Z">
              <Val v={s.openProfit} />
            </Kpi>
            <Kpi label="Son özsermaye">{fmtNum(s.finalEquity, 2)}</Kpi>
          </div>

          <EquityChart out={s} bars={bars} />

          <div className="overflow-x-auto">
            <table className="w-full text-[12px] tabular-nums" data-testid="strategy-table">
              <thead>
                <tr className="text-muted">
                  <th className="py-1 text-left font-normal" />
                  <th className="py-1 pl-3 text-right font-normal">Tümü</th>
                  <th className="py-1 pl-3 text-right font-normal">Long</th>
                  <th className="py-1 pl-3 text-right font-normal">Short</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {ROWS.map(([label, f]) => (
                  <tr key={label}>
                    <td className="py-1 pr-2 text-muted">{label}</td>
                    <td className="whitespace-nowrap py-1 pl-3 text-right">{f(s.all)}</td>
                    <td className="whitespace-nowrap py-1 pl-3 text-right">{f(s.long)}</td>
                    <td className="whitespace-nowrap py-1 pl-3 text-right">{f(s.short)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1.5 rounded-md border border-line p-2.5 text-[12px] text-muted">
            <div>{propsText(s.props)}</div>
            <div data-testid="strategy-period">
              Test dönemi:{" "}
              {Number.isFinite(s.rangeStart) ? `${when(s.rangeStart)} → ${when(s.rangeEnd)} · ${s.rangeBars} mum` : "seçilen aralıkta mum yok"}
              {s.pendingOrders ? ` · ${s.pendingOrders} bekleyen emir` : ""}
            </div>
            {n > 0 && Number.isFinite(range.from) && range.from < bars!.time[0]! && (
              <div className="text-warn" data-testid="range-note">
                {loadingMore
                  ? "Seçilen başlangıç için geçmiş yükleniyor…"
                  : `Veri ${when(bars!.time[0]!)} tarihinden başlıyor (Binance'te daha eski veri yok ya da en çok 50.000 mum yüklenebilir); test bu tarihten başladı.`}
              </div>
            )}
            {canLoadMore && !loadingMore && (
              <button type="button" className="btn btn-outline h-8" onClick={onLoadMore} data-testid="strategy-load-more">
                Eksik geçmişi yükle
              </button>
            )}
            {selected.warnings.length > 0 && (
              <ul className="list-disc pl-4 text-warn">
                {selected.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div className="text-subtle">
              Emirler sinyal mumu kapandıktan sonraki mumun açılışında dolar; stop/limit emirleri mum içinde
              (TradingView'ın mum içi hareket varsayımıyla). Teminat, likidasyon ve fonlama ücreti hesaba katılmaz.
              Geçmiş sonuçlar geleceği garanti etmez.
            </div>
          </div>
        </div>
      )}

      {tab === "trades" && (
        <div data-testid="strategy-trades">
          {list.length === 0 && <p className="p-4 text-[13px] text-muted">Bu dönemde işlem yok.</p>}
          <ul className="divide-y divide-line">
            {list.slice(0, limit).map((t) => (
              <TradeRow key={`${t.open ? "o" : "c"}${t.n}`} t={t} digits={digits} onPick={() => onFocus(t)} />
            ))}
          </ul>
          {list.length > limit && (
            <div className="p-3">
              <button type="button" className="btn btn-outline w-full" onClick={() => setLimit((x) => x + 300)}>
                Daha fazla göster ({list.length - limit})
              </button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
