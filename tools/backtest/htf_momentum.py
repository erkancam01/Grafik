"""4 saat: momentum sonrası devam — sağlamlık incelemesi (yalnız geliştirme dönemi dev2, 8 analiz coini).

htf_study.py --tf 4h: sert mum (gövde > 2×ATR) ve RSI14 aşırılığı (> 80 / < 20) sonrası aynı yönde gitmek, kâr al 1 /
zarar kes 2,5 × ATR14(4s) ile iki yarıda da ≥ %70 kazanma ve artı ortalama verdi; tersine gitmek açıkça eksi.
Burada: eşik, geometri, trend filtresi, iki sinyalin birleşimi; çeyrek ve coin dağılımı. Aynı anda tek pozisyon.
Kullanım: python tools/backtest/htf_momentum.py  →  .cache/results/htf_momentum_4h.md
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.argv = [sys.argv[0], "--tf", "4h"]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402
import candle_study as C  # noqa: E402
import htf_study as S  # noqa: E402

QUARTERS = ["2025Ç2", "2025Ç3", "2025Ç4", "2026Ç1", "2026Ç2"]


def run(data, sigfn, tpk, slk, label):
    nets, wins, qd, coin = [], [], {}, {}
    for s, d in data.items():
        m, dirn = sigfn(d)
        sig = np.flatnonzero(m & d["dev"] & ~np.isnan(d["atrC"]) & (dirn != 0))
        sig = sig[sig + 1 + S.H < len(d["c"])]
        if not len(sig):
            continue
        e = sig + 1
        a1 = d["atrC"][sig]
        ret, win, off = C.outcome(d, e, dirn[sig], tpk * a1, slk * a1, S.H)
        keep = C.flat_only(sig, e + off)
        net = ret[keep] - S.FEE
        nets.append(net)
        wins.append(win[keep])
        coin[s] = (len(net), net.mean() if len(net) else np.nan, win[keep].mean() * 100 if len(net) else np.nan)
        for q, r, w in zip(C.quarter(d["t"][sig[keep]]), net, win[keep]):
            qd.setdefault(q, []).append((r, w))
    net = np.concatenate(nets)
    win = np.concatenate(wins)
    qs = " ".join(
        f"{np.mean([w for _, w in qd[q]]) * 100:.0f}%/{np.mean([r for r, _ in qd[q]]):+.0f}" if q in qd else "-" for q in QUARTERS
    )
    pos = sum(1 for v in coin.values() if v[1] > 0)
    A.out(f"| {label} | {len(net)} | {win.mean() * 100:.1f} | {net.mean():+.1f} | {A.tstat(net):+.1f} | {pos}/8 | {qs} |")
    return coin


def main() -> None:
    data = {s: S.prep(s) for s in A.COINS}
    A.out("# 4 saat momentum sonrası devam — geliştirme (2025-04 → 2026-06), 8 analiz coini, tek pozisyon")
    A.out()
    hdr = "| durum | işlem | kazanma % | ort. bps | t | artı coin | çeyrekler (kazanma%/ort bps): " + " ".join(QUARTERS) + " |"

    def candle(k):
        return lambda d: (np.abs(d["c"] - d["o"]) > k * d["patr"], np.sign(d["c"] - d["o"]))

    def rsi(lo):
        return lambda d: ((d["rsi"] < lo) | (d["rsi"] > 100 - lo), np.where(d["rsi"] > 50, 1.0, -1.0))

    def both(k, lo):
        def f(d):
            m1, d1 = candle(k)(d)
            m2, d2 = rsi(lo)(d)
            return m1 | m2, np.where(m1, d1, d2)

        return f

    def trend(fn):
        def f(d):
            m, dr = fn(d)
            return m & (np.sign(d["c"] - d["ema50"]) == dr), dr

        return f

    for title, cases in [
        ("Sert mum eşiği (TP/SL 1/2.5)", [(f"gövde > {k}×ATR", candle(k), 1, 2.5) for k in (1.5, 2.0, 2.5)]),
        ("RSI eşiği (TP/SL 1/2.5)", [(f"RSI < {lo} / > {100 - lo}", rsi(lo), 1, 2.5) for lo in (15, 20, 25)]),
        (
            "Geometri (gövde > 2×ATR)",
            [(f"TP/SL {t}/{s_}", candle(2.0), t, s_) for t, s_ in ((0.75, 2), (1, 2), (1, 2.5), (1, 3), (1.25, 3))],
        ),
        (
            "Birleşim ve trend filtresi (TP/SL 1/2.5)",
            [
                ("sert mum 2×ATR VEYA RSI 20/80", both(2.0, 20), 1, 2.5),
                ("sert mum 2×ATR, EMA50 yönünde", trend(candle(2.0)), 1, 2.5),
                ("birleşim, EMA50 yönünde", trend(both(2.0, 20)), 1, 2.5),
            ],
        ),
    ]:
        A.out(f"## {title}")
        A.out()
        A.out(hdr)
        A.out("|---|---|---|---|---|---|---|")
        for label, fn, t, s_ in cases:
            run(data, fn, t, s_, label)
        A.out()
    A.out("## Coin dağılımı: sert mum 2×ATR VEYA RSI 20/80, TP/SL 1/2.5")
    A.out()
    A.out("| coin | işlem | ort. bps | kazanma % |")
    A.out("|---|---|---|---|")
    A.lines.append("")
    coin = run(data, both(2.0, 20), 1, 2.5, "(toplam)")
    for s, (n, avg, wr) in coin.items():
        A.out(f"| {s} | {n} | {avg:+.1f} | {wr:.1f} |")
    out = A.ROOT / ".cache" / "results" / "htf_momentum_4h.md"
    out.write_text("\n".join(A.lines) + "\n")
    print(f"rapor: {out}")


if __name__ == "__main__":
    main()
