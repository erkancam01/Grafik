/**
 * Ana uygulama: veri kaynağı (Binance vadeli → spot → demo), mumlar + canlı akış, indikatör hesapları (worker),
 * üst çubuk, grafik, çekmeceler.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChartView, type ChartIndicator } from "./chart/ChartView";
import { DemoSource } from "./data/demo";
import { GoldSource } from "./data/gold";
import { BAR_INTERVALS, intervalById } from "./data/intervals";
import { applyLiveBar, mergeBars, type DataSource, type SymbolInfo } from "./data/source";
import { ExtraData, MAX_HISTORY, computeIndicator, loadHistory, type IndicatorResult } from "./indicators/compute";
import { LIBRARY } from "./pine/library";
import type { BarsData, PineOutput, StrategyTradeOut } from "./pine/types";
import {
  DEFAULT_INDICATORS,
  DEFAULT_SETTINGS,
  NEW_SCRIPT,
  uid,
  usePersistent,
  type ActiveIndicator,
  type Settings,
  type UserScript,
} from "./store/state";
import { IconAlert, IconChevron, IconEye, IconEyeOff, IconFx, IconGear, IconMoon, IconPencil, IconSun, IconX } from "./ui/icons";
import { IndicatorSheet, type EditTarget, type SheetTab } from "./ui/IndicatorSheet";
import { InputsDialog } from "./ui/InputsDialog";
import { StrategySheet, StrategyStrip, type StrategyEntry } from "./ui/StrategyPanel";
import { SymbolPicker } from "./ui/SymbolPicker";
import { PineWorker } from "./worker/client";

interface ResultState {
  status: "loading" | "ok" | "error";
  output: PineOutput | null;
  error: string | null;
  firstTime: number | null;
  rev: number;
}

/** Kaydırarak yüklenen ve strateji varken varsayılan geçmiş. */
const MAX_BARS = 5000;
/** Test başlangıcından önce göstergelerin ısınması için ek mum. */
const WARMUP_BARS = 300;
const TICK_THROTTLE_MS = 2000;

function finite(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

function isDemo(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("demo");
  } catch {
    return false;
  }
}

export default function App() {
  const [settings, setSettings] = usePersistent<Settings>("grafik.settings", DEFAULT_SETTINGS);
  const [active, setActive] = usePersistent<ActiveIndicator[]>("grafik.indicators", DEFAULT_INDICATORS);
  const [scripts, setScripts] = usePersistent<UserScript[]>("grafik.scripts", []);
  const { symbol: savedSymbol, interval, theme } = settings;
  const iv = intervalById(interval) ?? intervalById("4h")!;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#131722" : "#ffffff");
  }, [theme]);

  // ------------------------------------------------------------ veri kaynağı
  const [src, setSrc] = useState<DataSource | null>(null);
  const [srcError, setSrcError] = useState<string | null>(null);
  const connect = useCallback(() => {
    setSrcError(null);
    (isDemo() ? Promise.resolve(new DemoSource()) : GoldSource.detect())
      .then(setSrc)
      .catch((e: unknown) => setSrcError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(connect, [connect]);

  // Uygulama yalnız altın gösterir: kayıtlı sembol (ör. eski bir coin) kaynakta yoksa ilk altın sembolüne geçilir
  const allowed = src?.available;
  const symbol = allowed?.length && !allowed.includes(savedSymbol) ? allowed[0]! : savedSymbol;
  useEffect(() => {
    if (symbol !== savedSymbol) setSettings((s) => ({ ...s, symbol }));
  }, [symbol, savedSymbol, setSettings]);
  useEffect(() => {
    if (!allowed?.length) return;
    const fav = settings.favorites.filter((f) => allowed.includes(f));
    const next = fav.length ? fav : [...allowed];
    if (next.length !== settings.favorites.length || next.some((f, i) => f !== settings.favorites[i])) {
      setSettings((s) => ({ ...s, favorites: next }));
    }
  }, [allowed, settings.favorites, setSettings]);

  const [symbols, setSymbols] = useState<SymbolInfo[] | null>(null);
  useEffect(() => {
    if (!src) return;
    src.symbols().then(setSymbols).catch(() => setSymbols([]));
  }, [src]);

  // ------------------------------------------------------------ mumlar
  const [bars, setBars] = useState<BarsData | null>(null);
  const [dataErr, setDataErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const more = useRef({ loading: false, exhausted: false });
  const [histExhausted, setHistExhausted] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const histTargetRef = useRef(MAX_BARS);

  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    setBars(null);
    setDataErr(null);
    more.current = { loading: false, exhausted: false };
    setHistExhausted(false);
    loadHistory(src, symbol, iv.id, 1500)
      .then((b) => {
        if (!cancelled) setBars(b);
      })
      .catch((e: unknown) => {
        if (!cancelled) setDataErr(e instanceof Error ? e.message : String(e));
      });
    const unsub = src.subscribe(
      symbol,
      iv.id,
      (lb) => setBars((prev) => (prev && prev.symbol === symbol && prev.tfSec === iv.sec ? applyLiveBar(prev, lb) : prev)),
      setLive,
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [src, symbol, iv.id, iv.sec, reloadKey]);

  const loadMore = useCallback(async () => {
    const b = bars;
    const cap = Math.max(MAX_BARS, histTargetRef.current);
    if (!src || !b || b.time.length === 0 || more.current.loading || more.current.exhausted || b.time.length >= cap) return;
    more.current.loading = true;
    try {
      const older = await loadHistory(src, symbol, iv.id, Math.min(1000, cap - b.time.length), b.time[0]! - 1);
      if (older.time.length === 0) {
        more.current.exhausted = true;
        setHistExhausted(true);
      } else setBars((prev) => (prev && prev.symbol === symbol && prev.tfSec === iv.sec ? mergeBars(older, prev) : prev));
    } catch {
      more.current.exhausted = true;
      setHistExhausted(true);
    } finally {
      more.current.loading = false;
    }
  }, [src, bars, symbol, iv.id, iv.sec]);

  /** Strateji testi için geçmişi `target` muma tamamlar. */
  const loadAll = useCallback(async (target: number) => {
    const b = bars;
    if (!src || !b || b.time.length === 0 || b.symbol !== symbol || b.tfSec !== iv.sec) return;
    if (more.current.loading || more.current.exhausted || b.time.length >= target) return;
    more.current.loading = true;
    setLoadingAll(true);
    try {
      const want = target - b.time.length;
      const older = await loadHistory(src, symbol, iv.id, want, b.time[0]! - 1);
      if (older.time.length < want) {
        more.current.exhausted = true;
        setHistExhausted(true);
      }
      if (older.time.length) setBars((prev) => (prev && prev.symbol === symbol && prev.tfSec === iv.sec ? mergeBars(older, prev) : prev));
    } catch {
      more.current.exhausted = true;
      setHistExhausted(true);
    } finally {
      more.current.loading = false;
      setLoadingAll(false);
    }
  }, [src, bars, symbol, iv.id, iv.sec]);

  // ------------------------------------------------------------ indikatörler
  const runner = useMemo(() => new PineWorker(), []);
  const extraData = useMemo(() => (src ? new ExtraData(src) : null), [src]);
  const [results, setResults] = useState<Record<string, ResultState>>({});

  const codeOf = useCallback(
    (a: ActiveIndicator): string | null =>
      a.source.kind === "library"
        ? (LIBRARY.find((x) => x.id === a.source.id)?.code ?? null)
        : (scripts.find((s) => s.id === a.source.id)?.code ?? null),
    [scripts],
  );
  const nameOf = useCallback(
    (a: ActiveIndicator): string =>
      a.source.kind === "library"
        ? (LIBRARY.find((x) => x.id === a.source.id)?.name ?? a.source.id)
        : (scripts.find((s) => s.id === a.source.id)?.name ?? "Silinmiş kod"),
    [scripts],
  );

  const latest = useRef({ bars, active, codeOf });
  latest.current = { bars, active, codeOf };
  const sched = useRef<{ timer: ReturnType<typeof setTimeout> | null; running: boolean; pending: boolean }>({
    timer: null,
    running: false,
    pending: false,
  });

  const runAll = useCallback(async () => {
    const s = sched.current;
    if (s.running) {
      s.pending = true;
      return;
    }
    const { bars: b, active: act, codeOf: code } = latest.current;
    if (!b || b.time.length === 0 || !extraData) return;
    s.running = true;
    try {
      for (const a of act) {
        if (!a.visible) continue;
        const c = code(a);
        if (!c) {
          setResults((r) => ({ ...r, [a.uid]: { status: "error", output: null, error: "Kod bulunamadı", firstTime: null, rev: (r[a.uid]?.rev ?? 0) + 1 } }));
          continue;
        }
        setResults((r) => (r[a.uid]?.output ? r : { ...r, [a.uid]: { status: "loading", output: null, error: null, firstTime: null, rev: r[a.uid]?.rev ?? 0 } }));
        const res: IndicatorResult = await computeIndicator(runner, extraData, c, b, a.inputs);
        setResults((r) => {
          const rev = (r[a.uid]?.rev ?? 0) + 1;
          if (res.ok) return { ...r, [a.uid]: { status: "ok", output: res.output, error: null, firstTime: b.time[0]!, rev } };
          const e = res.error;
          return { ...r, [a.uid]: { status: "error", output: null, error: `${e.line > 0 ? `Satır ${e.line}: ` : ""}${e.message}`, firstTime: null, rev } };
        });
      }
    } finally {
      s.running = false;
      if (s.pending) {
        s.pending = false;
        void runAll();
      }
    }
  }, [extraData, runner]);

  const schedule = useCallback(
    (delay: number) => {
      const s = sched.current;
      if (delay === 0) {
        if (s.timer) clearTimeout(s.timer);
        s.timer = null;
        void runAll();
        return;
      }
      if (s.timer) return; // kısıtlama: bekleyen hesap varken yeniden kurma
      s.timer = setTimeout(() => {
        s.timer = null;
        void runAll();
      }, delay);
    },
    [runAll],
  );

  const prevBars = useRef<{ key: string; first: number; n: number } | null>(null);
  useEffect(() => {
    if (!bars || bars.time.length === 0) return;
    const key = `${bars.symbol}|${bars.tfSec}`;
    const first = bars.time[0]!;
    const n = bars.time.length;
    const p = prevBars.current;
    prevBars.current = { key, first, n };
    const structural = !p || p.key !== key || p.first !== first || n !== p.n;
    // uzun geçmişte canlı tik hesabı seyrek (ör. 50.000 mumda 20 sn)
    schedule(structural ? 0 : TICK_THROTTLE_MS * Math.max(1, n / MAX_BARS));
  }, [bars, schedule]);

  const activeKey = JSON.stringify(active.map((a) => [a.uid, a.visible, a.inputs, codeOf(a)]));
  useEffect(() => {
    schedule(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, extraData]);

  const chartInds: ChartIndicator[] = active.map((a) => {
    const r = results[a.uid];
    return {
      uid: a.uid,
      rev: r?.rev ?? 0,
      title: r?.output?.meta.shorttitle || nameOf(a),
      output: r?.output ?? null,
      firstTime: r?.firstTime ?? null,
      visible: a.visible,
      status: a.visible ? (r?.status ?? "loading") : "ok",
      error: r?.error ?? null,
      warnings: r?.output?.warnings ?? [],
    };
  });

  // ------------------------------------------------------------ strateji testi
  const strategies: StrategyEntry[] = chartInds.flatMap((ind) =>
    ind.visible && ind.output?.strategy ? [{ uid: ind.uid, title: ind.title, out: ind.output.strategy, warnings: ind.warnings }] : [],
  );
  const [stratSel, setStratSel] = useState<string | null>(null);
  const [stratOpen, setStratOpen] = useState(false);
  const [focus, setFocus] = useState<{ from: number; to: number; seq: number } | null>(null);
  const selectedStrategy = strategies.find((x) => x.uid === stratSel) ?? strategies[strategies.length - 1] ?? null;
  const hasStrategy = strategies.length > 0;
  const selectedActive = selectedStrategy ? (active.find((a) => a.uid === selectedStrategy.uid) ?? null) : null;
  const range = { from: finite(selectedActive?.inputs["__s.from"]), to: finite(selectedActive?.inputs["__s.to"]) };
  const setRange = (from: number, to: number) => {
    if (!selectedActive) return;
    setActive((xs) =>
      xs.map((x) => {
        if (x.uid !== selectedActive.uid) return x;
        const inputs = { ...x.inputs };
        if (Number.isFinite(from)) inputs["__s.from"] = from;
        else delete inputs["__s.from"];
        if (Number.isFinite(to)) inputs["__s.to"] = to;
        else delete inputs["__s.to"];
        return { ...x, inputs };
      }),
    );
  };
  // strateji varken geçmiş en az 5000 muma, test başlangıcı daha eskiyse oraya kadar (+ısınma) tamamlanır
  const earliestFrom = Math.min(
    ...active.filter((a) => a.visible).map((a) => finite(a.inputs["__s.from"])).filter((x) => Number.isFinite(x)),
  );
  const histTarget = !hasStrategy
    ? MAX_BARS
    : Math.min(
        MAX_HISTORY,
        Math.max(MAX_BARS, Number.isFinite(earliestFrom) ? Math.ceil((Date.now() - earliestFrom) / (iv.sec * 1000)) + WARMUP_BARS : 0),
      );
  histTargetRef.current = histTarget;
  useEffect(() => {
    // yalnız seçili sembol/zaman diliminin mumlarıyla; yükleme sürerken ya da veri bittiyse bekle (mumlar değişince yeniden bakılır)
    if (!hasStrategy || !bars || bars.time.length === 0 || bars.symbol !== symbol || bars.tfSec !== iv.sec) return;
    if (bars.time.length >= histTarget || more.current.loading || more.current.exhausted) return;
    void loadAll(histTarget);
  }, [hasStrategy, bars, loadAll, histTarget, symbol, iv.sec]);
  const focusTrade = (t: StrategyTradeOut) => {
    setFocus((f) => ({ from: t.entryTime, to: t.exitTime, seq: (f?.seq ?? 0) + 1 }));
    setStratOpen(false);
  };

  // ------------------------------------------------------------ çekmeceler
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState<SheetTab>("library");
  const [edit, setEdit] = useState<EditTarget>({ id: null, name: "", code: NEW_SCRIPT });
  const [inputsFor, setInputsFor] = useState<string | null>(null);

  const addIndicator = (source: ActiveIndicator["source"]) => {
    const id = uid();
    setActive((xs) => [...xs, { uid: id, source, inputs: {}, visible: true }]);
    setSheetOpen(false);
    setStratSel(id);
  };
  const setSetting = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => ({ ...s, [k]: v }));

  const inputsInd = active.find((a) => a.uid === inputsFor) ?? null;
  const inputsOut = inputsInd ? results[inputsInd.uid]?.output : null;

  const controls = (ind: ChartIndicator) => {
    const a = active.find((x) => x.uid === ind.uid)!;
    return (
      <>
        <button
          type="button"
          className="btn btn-icon h-7 w-7 text-muted"
          aria-label={ind.visible ? `${ind.title} gizle` : `${ind.title} göster`}
          onClick={() => setActive((xs) => xs.map((x) => (x.uid === ind.uid ? { ...x, visible: !x.visible } : x)))}
        >
          {ind.visible ? <IconEye size={15} /> : <IconEyeOff size={15} />}
        </button>
        <button type="button" className="btn btn-icon h-7 w-7 text-muted" aria-label={`${ind.title} ayarları`} onClick={() => setInputsFor(ind.uid)} data-testid="legend-settings">
          <IconGear size={15} />
        </button>
        <button
          type="button"
          className="btn btn-icon h-7 w-7 text-muted"
          aria-label={`${ind.title} kodunu düzenle`}
          onClick={() => {
            const code = codeOf(a) ?? NEW_SCRIPT;
            if (a.source.kind === "user") setEdit({ id: a.source.id, name: nameOf(a), code });
            else setEdit({ id: null, name: `${nameOf(a)} (kopya)`, code });
            setTab("editor");
            setSheetOpen(true);
          }}
        >
          <IconPencil size={15} />
        </button>
        <button
          type="button"
          className="btn btn-icon h-7 w-7 text-muted"
          aria-label={`${ind.title} kaldır`}
          onClick={() => setActive((xs) => xs.filter((x) => x.uid !== ind.uid))}
        >
          <IconX size={15} />
        </button>
        {ind.warnings.length > 0 && (
          <span className="text-warn" title={ind.warnings.join("\n")} aria-label="Uyarılar">
            <IconAlert size={14} />
          </span>
        )}
      </>
    );
  };

  const header = (
    <span className="flex items-center gap-1.5" data-testid="chart-header">
      <b className="text-fg">{symbol}</b>
      <span className="text-muted">· {iv.label} ·</span>
      <span className="text-subtle">{src?.labelFor?.(symbol) ?? src?.label ?? "…"}</span>
      <span className={`inline-block h-2 w-2 rounded-full ${live ? "bg-up" : "bg-subtle"}`} title={live ? "Canlı" : "Canlı bağlantı yok (yoklama)"} />
    </span>
  );

  if (srcError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <h1 className="text-lg font-semibold">Binance'e bağlanılamadı</h1>
          <p className="text-sm text-muted">{srcError}</p>
          <p className="text-sm text-muted">Ağın Binance'i engelliyor olabilir (VPN gerekebilir).</p>
          <div className="flex justify-center gap-2">
            <button type="button" className="btn btn-primary" onClick={connect}>
              Tekrar dene
            </button>
            <a className="btn btn-outline" href="?demo">
              Demo verisiyle aç
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="app">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-bg px-1.5">
        <button type="button" className="btn px-2 text-[14px] font-semibold" onClick={() => setPickerOpen(true)} data-testid="symbol-button">
          <span>
            {symbol.replace(/USDT$/, "")}
            <span className="font-normal text-subtle">/USDT</span>
          </span>
          <IconChevron size={14} />
        </button>
        <div className="scroll-x flex min-w-0 flex-1 items-center gap-0.5" role="toolbar" aria-label="Zaman dilimi">
          {BAR_INTERVALS.map((id) => {
            const d = intervalById(id)!;
            return (
              <button key={id} type="button" className="pill shrink-0" aria-pressed={id === interval} onClick={() => setSetting("interval", id)} data-testid={`tf-${id}`}>
                {d.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="btn shrink-0 px-2"
          onClick={() => {
            setTab("library");
            setSheetOpen(true);
          }}
          data-testid="indicators-button"
          aria-label="İndikatörler"
        >
          <IconFx size={18} />
          <span className="hidden sm:inline">İndikatörler</span>
        </button>
        <button
          type="button"
          className="btn btn-icon shrink-0"
          onClick={() => setSetting("theme", theme === "dark" ? "light" : "dark")}
          aria-label={theme === "dark" ? "Açık tema" : "Koyu tema"}
        >
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
      </header>

      <main className="relative min-h-0 flex-1">
        <ChartView
          bars={bars}
          viewKey={`${symbol}|${iv.id}`}
          theme={theme}
          indicators={chartInds}
          header={header}
          renderControls={controls}
          onNeedMore={loadMore}
          focus={focus}
        />
        {!bars && !dataErr && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">Mumlar yükleniyor…</div>
        )}
        {dataErr && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="space-y-2 rounded-lg border border-line bg-panel p-4 text-center text-sm">
              <p className="text-down">Veri alınamadı: {dataErr}</p>
              <button type="button" className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
                Tekrar dene
              </button>
            </div>
          </div>
        )}
      </main>

      {selectedStrategy && <StrategyStrip entry={selectedStrategy} onOpen={() => setStratOpen(true)} busy={loadingAll} />}
      {selectedStrategy && (
        <StrategySheet
          open={stratOpen}
          onClose={() => setStratOpen(false)}
          entries={strategies}
          selected={selectedStrategy}
          onSelect={setStratSel}
          bars={bars}
          onSettings={() => {
            setStratOpen(false);
            setInputsFor(selectedStrategy.uid);
          }}
          onFocus={focusTrade}
          canLoadMore={!!bars && bars.time.length < histTarget && !histExhausted}
          loadingMore={loadingAll}
          onLoadMore={() => void loadAll(histTarget)}
          range={range}
          onRange={setRange}
        />
      )}

      <SymbolPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        symbols={symbols}
        favorites={settings.favorites}
        onToggleFav={(s) =>
          setSetting("favorites", settings.favorites.includes(s) ? settings.favorites.filter((x) => x !== s) : [...settings.favorites, s])
        }
        onPick={(s) => setSetting("symbol", s)}
      />
      <IndicatorSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        tab={tab}
        setTab={setTab}
        scripts={scripts}
        edit={edit}
        setEdit={setEdit}
        onAddLibrary={(id) => addIndicator({ kind: "library", id })}
        onAddUser={(id) => addIndicator({ kind: "user", id })}
        onSave={(s, add) => {
          setScripts((xs) => (xs.some((x) => x.id === s.id) ? xs.map((x) => (x.id === s.id ? s : x)) : [...xs, s]));
          if (add && !active.some((a) => a.source.kind === "user" && a.source.id === s.id)) {
            setActive((xs) => [...xs, { uid: uid(), source: { kind: "user", id: s.id }, inputs: {}, visible: true }]);
          }
          if (add) setSheetOpen(false);
        }}
        onDelete={(id) => {
          setScripts((xs) => xs.filter((x) => x.id !== id));
          setActive((xs) => xs.filter((a) => !(a.source.kind === "user" && a.source.id === id)));
        }}
      />
      <InputsDialog
        open={!!inputsInd}
        title={inputsInd ? (inputsOut?.meta.shorttitle ?? nameOf(inputsInd)) : ""}
        inputs={inputsOut?.inputs ?? []}
        values={inputsInd?.inputs ?? {}}
        onApply={(v) => setActive((xs) => xs.map((x) => (x.uid === inputsFor ? { ...x, inputs: v } : x)))}
        onClose={() => setInputsFor(null)}
      />
    </div>
  );
}
