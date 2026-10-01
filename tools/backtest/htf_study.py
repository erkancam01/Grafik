"""1 saat / 4 saat: yüksek kazanma oranlı ve kârlı yapı arayışı — H_STUDY geliştirme dönemi (dev2: 2025-04 → 2026-06),
analiz coinleri (BTC, ETH, SOL, BCH, DOT, ETC, TRX, XLM). Sınav verilerine (yedek coinler, 2024-11 → 2025-03,
son sınav dönemi, XRP/BNB/DOGE) dokunulmaz.

  A) Geçmiş getiri → gelecek getiri (devam mı geri dönüş mü), grafik ve üstü ufuklarda.
  B) Olaylar (UT Al/Sat, sert mum, RSI aşırılığı, 1 ve 3 günlük getiri aşırılığı, EMA50'den uzaklaşma, 1 haftalık
     kanal kırılımı) sonrası "önce hangisi": kâr al / zarar kes grafiğin ATR14 katı, en çok 3 gün (1s) / 7 gün (4s);
     devam ve ters yön; komisyon %0,05 × 2. Aynı anda tek pozisyon (stratejideki gibi). Aynı mumda iki seviye → zarar.
     ★ = geliştirme döneminin iki yarısında da kazanma ≥ %70 ve ortalama > 0, coinlerin ≥ 6/8'inde artı.
Kullanım: python tools/backtest/htf_study.py --tf 1h|4h  →  .cache/results/htf_<tf>.md
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

TF = sys.argv[sys.argv.index("--tf") + 1] if "--tf" in sys.argv else "1h"
assert TF in ("1h", "4h"), "yalnız 1h ya da 4h"
sys.argv = [sys.argv[0], "--tf", TF]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402
import candle_study as C  # noqa: E402

TF_SEC = A.TF_SEC
BPD = 86400 // TF_SEC  # gün başına mum
H = 3 * BPD if TF == "1h" else 7 * BPD
FROM = A.FROM
TO = np.datetime64("2026-07-01T00:00:00").astype("datetime64[ms]").astype(np.int64) - A.IST - 1
MID = FROM + (TO - FROM) // 2
FEE = A.FEE_BPS
GEOM = [(1, 1), (0.5, 1.5), (1, 2), (1, 2.5), (1.5, 3), (2, 4)]


def prep(sym: str) -> dict:
    d = A.load(sym)
    c, h, l = d["c"], d["h"], d["l"]
    d["atrC"] = A.atr(h, l, c, 14)
    d["patr"] = np.concatenate([[np.nan], d["atrC"][:-1]])
    d["atr10"] = A.atr(h, l, c, 10)
    d["rsi"] = A.rsi(c)
    d["ema50"] = A.ema(c, 50)
    lp = np.log(c)
    for name, days in (("r1", 1), ("r3", 3)):
        n = days * BPD
        r = np.full_like(c, np.nan)
        r[n:] = lp[n:] - lp[:-n]
        sd = pd.Series(r).shift(1).rolling(30 * BPD, min_periods=10 * BPD).std().to_numpy()
        d[name] = r
        d[name + "z"] = r / sd
    wk = 7 * BPD
    d["hhw"] = pd.Series(h).shift(1).rolling(wk).max().to_numpy()
    d["llw"] = pd.Series(l).shift(1).rolling(wk).min().to_numpy()
    d["dev"] = (d["t"] >= FROM) & (d["t"] <= TO)
    return d


def events(d: dict):
    c, o = d["c"], d["o"]
    body = c - o
    out = {}
    for a in (1, 2, 3):
        b, s = A.ut_bot(c, d["atr10"], a)
        out[f"UT Al/Sat a={a}"] = (b | s, np.where(b, 1.0, -1.0))
    for k in (2, 3):
        out[f"sert mum > {k}×ATR"] = (np.abs(body) > k * d["patr"], np.sign(body))
    out["RSI14 < 30 / > 70"] = ((d["rsi"] < 30) | (d["rsi"] > 70), np.where(d["rsi"] > 50, 1.0, -1.0))
    out["RSI14 < 20 / > 80"] = ((d["rsi"] < 20) | (d["rsi"] > 80), np.where(d["rsi"] > 50, 1.0, -1.0))
    for nm, lab in (("r1", "1 günlük"), ("r3", "3 günlük")):
        z = d[nm + "z"]
        out[f"{lab} getiri > 2σ"] = (np.abs(z) > 2, np.sign(z))
    zz = (c - d["ema50"]) / d["atrC"]
    out["EMA50'den > 3 ATR uzak"] = (np.abs(zz) > 3, np.sign(zz))
    out["1 haftalık kanal kırılımı"] = ((c > d["hhw"]) | (c < d["llw"]), np.where(c > d["hhw"], 1.0, -1.0))
    rng = np.random.default_rng(11)
    n = len(c)
    out["rastgele (taban)"] = (rng.random(n) < 0.05, np.where(rng.random(n) < 0.5, 1.0, -1.0))
    return out


def main() -> None:
    data = {s: prep(s) for s in A.COINS}
    ev = {s: events(d) for s, d in data.items()}
    A.out(f"# 1 saat / 4 saat çalışması — {TF} grafik, geliştirme (2025-04 → 2026-06), 8 analiz coini")
    A.out()
    # ---------------------------------------------------------------- A
    hz = {k: v // TF_SEC for k, v in {"1s": 3600, "4s": 14400, "1g": 86400, "3g": 259200, "1hf": 604800}.items() if v >= TF_SEC}
    A.out("## A) Geçmiş getiri → gelecek getiri (korelasyon ×100, 8 coin ortalaması; parantez: kaç coinde pozitif)")
    A.out()
    A.out("| geçmiş \\ gelecek | " + " | ".join(hz) + " |")
    A.out("|---|" + "---|" * len(hz))
    for ln, L in hz.items():
        cells = []
        for hn, Hh in hz.items():
            cs = []
            for d in data.values():
                lp = np.log(d["c"])
                idx = np.flatnonzero(d["dev"])
                idx = idx[(idx >= L) & (idx + Hh < len(lp))][::Hh]
                cs.append(np.corrcoef(lp[idx] - lp[idx - L], lp[idx + Hh] - lp[idx])[0, 1] * 100)
            cells.append(f"{np.mean(cs):+.1f} ({sum(x > 0 for x in cs)}/8)")
        A.out(f"| {ln} | " + " | ".join(cells) + " |")
    A.out()
    # ---------------------------------------------------------------- B
    A.out(f"## B) Olay sonrası önce hangisi — kâr al/zarar kes grafiğin ATR14 katı, en çok {H} mum, tek pozisyon")
    A.out()
    A.out("Hücre: kazanma % / ort. bps (komisyon sonrası) — 1. yarı | 2. yarı; artı coin (tüm dönem). ★ = aday.")
    A.out()
    A.out("| olay | yön | TP/SL | işlem | 1. yarı | 2. yarı | artı coin |")
    A.out("|---|---|---|---|---|---|---|")
    cands = []
    names = list(next(iter(ev.values())).keys())
    for name in names:
        for side, sd in (("devam", 1.0), ("ters", -1.0)):
            for tpk, slk in GEOM:
                halves = {0: [[], []], 1: [[], []]}
                pos = 0
                ntot = 0
                for s, d in data.items():
                    m, dirn = ev[s][name]
                    sig = np.flatnonzero(m & d["dev"] & ~np.isnan(d["atrC"]) & ~np.isnan(dirn) & (dirn != 0))
                    sig = sig[sig + 1 + H < len(d["c"])]
                    if not len(sig):
                        continue
                    e = sig + 1
                    a1 = d["atrC"][sig]
                    ret, win, off = C.outcome(d, e, sd * dirn[sig], tpk * a1, slk * a1, H)
                    keep = C.flat_only(sig, e + off)
                    net = ret[keep] - FEE
                    wk = win[keep]
                    hf = (d["t"][sig[keep]] >= MID).astype(int)
                    for hh in (0, 1):
                        halves[hh][0].append(wk[hf == hh])
                        halves[hh][1].append(net[hf == hh])
                    pos += net.mean() > 0 if len(net) else 0
                    ntot += len(net)
                cells = []
                ok = ntot >= 150
                for hh in (0, 1):
                    w = np.concatenate(halves[hh][0]) if halves[hh][0] else np.array([])
                    nn = np.concatenate(halves[hh][1]) if halves[hh][1] else np.array([])
                    wr = w.mean() * 100 if len(w) else np.nan
                    av = nn.mean() if len(nn) else np.nan
                    ok &= bool(len(w) >= 50 and wr >= 70 and av > 0)
                    cells.append(f"%{wr:.1f} / {av:+.1f} (n {len(w)})")
                ok &= pos >= 6
                mark = " ★" if ok else ""
                if ok:
                    cands.append((name, side, tpk, slk))
                A.out(f"| {name} | {side} | {tpk}/{slk} | {ntot} | {cells[0]} | {cells[1]} | {pos}/8{mark} |")
    A.out()
    A.out("## Adaylar (★)")
    A.out()
    for c_ in cands:
        A.out(f"- {c_[0]} · {c_[1]} · TP/SL {c_[2]}/{c_[3]}")
    if not cands:
        A.out("- yok")
    out = A.ROOT / ".cache" / "results" / f"htf_{TF}.md"
    out.write_text("\n".join(A.lines) + "\n")
    print(f"rapor: {out}")


if __name__ == "__main__":
    main()
