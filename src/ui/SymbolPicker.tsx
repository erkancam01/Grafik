/** Sembol seçici: arama, favoriler, hacme göre tüm USDT çiftleri. */
import { useMemo, useState } from "react";
import type { SymbolInfo } from "../data/source";
import { fmtNum, priceDigits } from "../chart/render";
import { IconSearch, IconStar } from "./icons";
import { Sheet } from "./Sheet";

export function SymbolPicker({
  open,
  onClose,
  symbols,
  favorites,
  onToggleFav,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  symbols: SymbolInfo[] | null;
  favorites: string[];
  onToggleFav: (s: string) => void;
  onPick: (s: string) => void;
}) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"fav" | "all">("fav");
  const byName = useMemo(() => new Map((symbols ?? []).map((s) => [s.symbol, s])), [symbols]);
  const list = useMemo(() => {
    const term = q.trim().toUpperCase();
    if (term) return (symbols ?? []).filter((s) => s.symbol.includes(term)).slice(0, 200);
    if (tab === "fav") return favorites.map((f) => byName.get(f) ?? { symbol: f, price: Number.NaN, changePct: Number.NaN, quoteVolume: 0 });
    return (symbols ?? []).slice(0, 300);
  }, [q, tab, symbols, favorites, byName]);

  return (
    <Sheet open={open} title="Sembol" onClose={onClose} testId="symbol-picker">
      <div className="space-y-2 p-3">
        <div className="relative">
          <IconSearch className="absolute left-2.5 top-2.5 text-subtle" size={16} />
          <input
            className="input pl-8"
            placeholder="Ara: BTC, ETH, SOL…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            data-testid="symbol-search"
          />
        </div>
        {!q && (
          <div className="flex gap-1">
            <button type="button" className="pill" aria-pressed={tab === "fav"} onClick={() => setTab("fav")}>
              Favoriler
            </button>
            <button type="button" className="pill" aria-pressed={tab === "all"} onClick={() => setTab("all")}>
              Tümü (hacme göre)
            </button>
          </div>
        )}
      </div>
      <ul className="divide-y divide-line" data-testid="symbol-list">
        {list.map((s) => {
          const fav = favorites.includes(s.symbol);
          return (
            <li key={s.symbol} className="flex items-center">
              <button
                type="button"
                className="btn btn-icon ml-1 text-warn"
                aria-label={fav ? `${s.symbol} favorilerden çıkar` : `${s.symbol} favorilere ekle`}
                onClick={() => onToggleFav(s.symbol)}
              >
                <IconStar filled={fav} />
              </button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2.5 text-left hover:bg-panel-2"
                onClick={() => {
                  onPick(s.symbol);
                  onClose();
                  setQ("");
                }}
              >
                <span className="flex-1 truncate text-[14px] font-medium">{s.symbol.replace(/USDT$/, "")}<span className="text-subtle">/USDT</span></span>
                <span className="tabular-nums text-[13px]">{fmtNum(s.price, priceDigits(s.price))}</span>
                <span className={`w-16 text-right tabular-nums text-[13px] ${s.changePct >= 0 ? "text-up" : "text-down"}`}>
                  {Number.isNaN(s.changePct) ? "" : `${s.changePct >= 0 ? "+" : ""}${fmtNum(s.changePct, 2)}%`}
                </span>
              </button>
            </li>
          );
        })}
        {symbols === null && <li className="px-3 py-3 text-[13px] text-muted">Semboller yükleniyor…</li>}
      </ul>
    </Sheet>
  );
}
