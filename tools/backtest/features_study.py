"""15 dk: ek verilerle koşullu analiz — geliştirme dönemi, analiz evreni 8 coin (sınav coinleri hariç).

Her 15 dk mum kapanışında long ve short için "önce hangisi" sonucu hesaplanır (sonraki açılışta giriş, kâr al 1 /
zarar kes 2 × 1 saatlik ATR, en çok 1 gün, komisyon %0,05/taraf). Özellikler dilimlere bölünür (sınırlar yalnız
geliştirme döneminin İLK yarısından), her dilimde kazanma % ve komisyon sonrası ortalama iki yarıda ayrı ayrı ve
coin coin raporlanır. Aday: iki yarıda da kazanma ≥ %70 ve ortalama > 0, coinlerin çoğunda artı.

Özellikler: mum gücü (gövde/ATR), göreli hacim, alıcı baskısı (taker alış / hacim; 15 dk ve 1 saat), fonlama oranı,
UTC saat dilimi, haftanın günü, oynaklık (1s ATR / fiyat), geçmiş getiri (1 saat, 4 saat, 1 gün), UT durumu.
Kaynak: .cache/market-data (Parquet, taker_buy_volume dahil). Kullanım: python tools/backtest/features_study.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.argv = [sys.argv[0], "--tf", "15m"]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402
import candle_study as C  # noqa: E402

SRC = A.ROOT / ".cache" / "market-data" / "binanceusdm"
MID = A.FROM + (A.TO - A.FROM) // 2  # geliştirme döneminin ortası (≈ 2025-10-01)
H = A.H_MAX
FEE = A.FEE_BPS


def load15(sym: str) -> dict:
    df = pd.read_parquet(SRC / "ohlcv" / f"{sym}_1m.parquet", columns=["open", "high", "low", "close", "volume", "taker_buy_volume"])
    lo = pd.Timestamp(A.FROM - 60 * 86_400_000, unit="ms", tz="UTC")
    hi = pd.Timestamp(A.TO + 3 * 86_400_000, unit="ms", tz="UTC")
    df = df[(df.index >= lo) & (df.index <= hi)]
    r = df.resample("15min", label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum", "taker_buy_volume": "sum"}
    ).dropna(subset=["open"])
    d = {"t": (r.index.asi8 // 1_000_000).astype(np.int64)}
    for k, col in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close"), ("v", "volume"), ("tb", "taker_buy_volume")):
        d[k] = r[col].to_numpy(dtype="float64")
    fr = pd.read_parquet(SRC / "funding" / f"{sym}.parquet", columns=["funding_rate"]).sort_index()
    ft = (fr.index.asi8 // 1_000_000).astype(np.int64)
    j = np.searchsorted(ft, d["t"] + 900_000, side="right") - 1  # mum kapanışında bilinen son fonlama
    d["fund"] = np.where(j >= 0, fr["funding_rate"].to_numpy()[np.clip(j, 0, None)], np.nan) * 1e4  # bps / 8 saat
    return d


def features(d: dict) -> dict[str, np.ndarray]:
    c, o, v, tb = d["c"], d["o"], d["v"], d["tb"]
    atr15 = A.atr(d["h"], d["l"], c, 14)
    prev_atr = np.concatenate([[np.nan], atr15[:-1]])
    H1, i1 = A.htf(d, 3600)
    d["atr1h"] = A.atr(H1["h"], H1["l"], H1["c"], 14)[i1]
    vmean = pd.Series(v).shift(1).rolling(96, min_periods=48).mean().to_numpy()
    tb4 = pd.Series(tb).rolling(4).sum().to_numpy() / pd.Series(v).rolling(4).sum().to_numpy()
    lp = np.log(c)

    def back(n):
        out = np.full_like(c, np.nan)
        out[n:] = lp[n:] - lp[:-n]
        return out * 1e4

    x10 = A.atr(d["h"], d["l"], c, 10)
    _, _, trail = A.ut_bot(c, x10, 1, with_trail=True)
    hours = ((d["t"] // 3_600_000) % 24).astype(int)
    dow = ((d["t"] // 86_400_000 + 3) % 7).astype(int)  # 0 = Pazartesi
    return {
        "mum gücü (gövde/ATR, işaretli)": (c - o) / prev_atr,
        "göreli hacim (son 1 güne göre)": v / vmean,
        "alıcı baskısı 15dk (taker alış/hacim)": tb / v,
        "alıcı baskısı 1s": tb4,
        "fonlama (bps/8s)": d["fund"],
        "UTC saat dilimi (4 saatlik)": (hours // 4).astype(float),
        "haftanın günü (0=Pzt)": dow.astype(float),
        "oynaklık (1s ATR / fiyat, %)": d["atr1h"] / c * 100,
        "getiri son 1s (bps)": back(4),
        "getiri son 4s (bps)": back(16),
        "getiri son 1g (bps)": back(96),
        "UT durumu (+1 üstte / -1 altta)": np.sign(c - trail),
    }


CATEGORICAL = {"UTC saat dilimi (4 saatlik)", "haftanın günü (0=Pzt)", "UT durumu (+1 üstte / -1 altta)"}


def main() -> None:
    rows = []  # (özellik, değer, coin, yarı, yön, kazandı, net)
    per_coin = {}
    for s in A.COINS:
        d = load15(s)
        F = features(d)
        dev = (d["t"] >= A.FROM) & (d["t"] <= A.TO) & ~np.isnan(d["atr1h"])
        sig = np.flatnonzero(dev)
        sig = sig[sig + 1 + H < len(d["c"])]
        e = sig + 1
        a1 = d["atr1h"][sig]
        half = np.where(d["t"][sig] < MID, 0, 1)
        res = {}
        for side in (1, -1):
            ret, win, _ = C.outcome(d, e, np.full(len(sig), float(side)), a1, 2 * a1, H)
            res[side] = (win, ret - FEE)
        per_coin[s] = (sig, half, F, res)
        print(f"{s}: {len(sig)} mum")

    A.out("# 15 dk ek veri analizi — koşullu kazanma (kâr al 1 / zarar kes 2 × 1s ATR, 1 gün), geliştirme dönemi, 8 coin")
    A.out()
    A.out("Taban (tüm mumlar): " + ", ".join(
        f"{'long' if side > 0 else 'short'} kazanma %{np.concatenate([per_coin[s][3][side][0] for s in A.COINS]).mean() * 100:.1f} / ort "
        f"{np.concatenate([per_coin[s][3][side][1] for s in A.COINS]).mean():+.1f} bps"
        for side in (1, -1)
    ))
    A.out()
    A.out("Hücre: kazanma % / ort. bps (komisyon sonrası) — 1. yarı | 2. yarı; artı coin (tüm dönem). ★ = iki yarıda da kazanma ≥ %70 ve ort > 0, ≥ 6/8 coin artı.")
    A.out()
    cands = []
    for fname in per_coin[A.COINS[0]][2]:
        # dilim sınırları: yalnız 1. yarı, tüm coinler
        if fname in CATEGORICAL:
            edges = None
        else:
            first = np.concatenate([per_coin[s][2][fname][per_coin[s][0]][per_coin[s][1] == 0] for s in A.COINS])
            first = first[np.isfinite(first)]
            edges = np.quantile(first, [0.1, 0.3, 0.5, 0.7, 0.9])
        A.out(f"## {fname}")
        A.out()
        A.out("| dilim | long: 1. yarı | long: 2. yarı | long artı coin | short: 1. yarı | short: 2. yarı | short artı coin |")
        A.out("|---|---|---|---|---|---|---|")
        buckets = {}
        for s in A.COINS:
            sig, half, F, res = per_coin[s]
            x = F[fname][sig]
            b = x if edges is None else np.digitize(x, edges).astype(float)
            b[~np.isfinite(x)] = np.nan
            for side in (1, -1):
                win, net = res[side]
                for key in np.unique(b[np.isfinite(b)]):
                    m = b == key
                    for hh in (0, 1):
                        mm = m & (half == hh)
                        g = buckets.setdefault((key, side, hh), [[], []])
                        g[0].append(win[mm])
                        g[1].append(net[mm])
                    cb = buckets.setdefault((key, side, "coin"), {})
                    cb[s] = net[m].mean() if m.any() else np.nan
        keys = sorted({k[0] for k in buckets})
        for key in keys:
            if edges is None:
                label = f"{key:+.0f}" if "UT" in fname else f"{key:.0f}"
            else:
                lo = "−∞" if key == 0 else f"{edges[int(key) - 1]:.3g}"
                hi = "+∞" if key == len(edges) else f"{edges[int(key)]:.3g}"
                label = f"{lo} … {hi}"
            cells = []
            for side in (1, -1):
                ok = True
                for hh in (0, 1):
                    w = np.concatenate(buckets[(key, side, hh)][0])
                    n = np.concatenate(buckets[(key, side, hh)][1])
                    wr = w.mean() * 100 if len(w) else np.nan
                    av = n.mean() if len(n) else np.nan
                    ok &= bool(len(w) > 200 and wr >= 70 and av > 0)
                    cells.append(f"%{wr:.1f} / {av:+.1f} (n {len(w)})")
                pos = sum(1 for v in buckets[(key, side, "coin")].values() if v > 0)
                ok &= pos >= 6
                cells.append(f"{pos}/8" + (" ★" if ok else ""))
                if ok:
                    cands.append((fname, label, "long" if side > 0 else "short"))
            A.out(f"| {label} | " + " | ".join(cells) + " |")
        A.out()
    A.out("## Adaylar (★)")
    A.out()
    for c_ in cands:
        A.out(f"- {c_[0]} · {c_[1]} · {c_[2]}")
    if not cands:
        A.out("- yok")
    out = A.ROOT / ".cache" / "results" / "features_15m.md"
    out.write_text("\n".join(A.lines) + "\n")
    print(f"rapor: {out}")


if __name__ == "__main__":
    main()
