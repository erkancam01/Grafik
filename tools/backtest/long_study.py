"""Uzun geçmiş çalışması — geliştirme taraması (protocol.ts L_STUDY).

Veri: research-data (15 dk, import_research_data.py → .cache/bars/<SYM>_15m.f64), 15 coin. Yalnız geliştirme dönemi
(2020-01-01 → 2022-12-31, İstanbul saati) yüklenir: veri geliştirme sonunda kesilir, işlem o ana kadar kapanmış
olmalı; sınav dönemlerine dokunulmaz.

Grafikler: 15 dk, 1 s, 4 s, 1 g (15 dk mumlardan, Binance gibi UTC'ye hizalı).
Olaylar (mum kapanışında): UT Bot Al/Sat (a = 1, 2, 3; ATR10), sert mum (gövde > 1,5 / 2 / 3 × önceki ATR14),
RSI14 < 30 / > 70 ve < 20 / > 80, RSI2 < 10 / > 90 ve < 5 / > 95, 1 ve 3 günlük getiri > 2σ (σ: önceki 30 gün),
EMA50'den > 3 ATR uzak, kanal kırılımı (20 mum; 1 hafta), Bollinger (20, 2σ) dışında kapanış, EMA20/EMA50 kesişimi,
rastgele (taban, mumların %5'i).
Yön: devam / ters. Filtre: yok / günlük EMA50 yönünde (son kapanmış günlük mumun EMA50'si; kapanış üstündeyse yalnız
long, altındaysa yalnız short).
Kâr al / zarar kes, sinyal mumundaki ATR14'ün katı (15 dk'da 1 saatlik ATR14, diğerlerinde grafiğin ATR14'ü):
1/1, 0,5/1,5, 0,5/2, 1/2, 1/2,5, 1/3, 1,5/3. En uzun tutma: 15 dk 1 gün, 1 s 3 gün, 4 s 7 gün, 1 g 20 gün (sonra son
kapanıştan çıkılır). Giriş sonraki mumun açılışında; aynı anda tek pozisyon; aynı mumda iki seviye → zarar;
komisyon %0,05 × 2. Kazanma = kâr al'a ulaşan işlem (süre çıkışı artıda olsa da kazanma sayılmaz; temkinli).
★ ve seçim: protocol.ts L_STUDY.candidate (aşağıda CAND, aynı değerler).
Kullanım: python tools/backtest/long_study.py  →  .cache/results/long_study.md (+ long_study.json)
"""

from __future__ import annotations

import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.argv = [sys.argv[0], "--tf", "15m"]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402

ROOT = A.ROOT
BARS = ROOT / ".cache" / "bars"
IST = A.IST
COINS = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "ADAUSDT", "DOGEUSDT", "LINKUSDT",
    "LTCUSDT", "DOTUSDT", "AVAXUSDT", "TRXUSDT", "BCHUSDT", "ETCUSDT", "XLMUSDT",
]


def day_start(s: str) -> int:
    return int(np.datetime64(f"{s}T00:00:00").astype("datetime64[ms]").astype(np.int64)) - IST


FROM = day_start("2020-01-01")
TO = day_start("2023-01-01") - 1
YEARS = (2020, 2021, 2022)
CAND = {"yearMinTrades": 50, "yearWinRate": 72.0, "posCoins": 10, "minTrades": 300}
FEE = 10.0  # bps, %0,05 × 2
GEOM = [(1, 1), (0.5, 1.5), (0.5, 2), (1, 2), (1, 2.5), (1, 3), (1.5, 3)]
TFS = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
HOLD_DAYS = {"15m": 1, "1h": 3, "4h": 7, "1d": 20}
OUT = ROOT / ".cache" / "results"


# ---------------------------------------------------------------- veri
def load15(sym: str) -> dict:
    a = np.fromfile(BARS / f"{sym}_15m.f64", dtype="<f8").reshape(6, -1)
    d = {k: a[i] for i, k in enumerate(["t", "o", "h", "l", "c", "v"])}
    keep = d["t"] + 900_000 - 1 <= TO  # yalnız geliştirme sonuna kadar kapanmış mumlar
    return {k: v[keep] for k, v in d.items()}


def mapped(vals: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Üst zaman dilimi değeri; henüz kapanmış üst mum yoksa NaN (ileriye bakma yok)."""
    return np.where(idx >= 0, vals[np.maximum(idx, 0)], np.nan)


def prep(base: dict, tf: str) -> dict:
    sec = TFS[tf]
    d = dict(base) if sec == 900 else A.htf(base, sec, 900)[0]
    full = d["t"] + sec * 1000 - 1 <= TO  # geliştirme sonunda yarım kalan son mum atılır
    d = {k: v[full] for k, v in d.items()}
    c, h, l = d["c"], d["h"], d["l"]
    bpd = 86400 // sec
    d["atr14"] = A.atr(h, l, c, 14)
    d["patr"] = np.concatenate([[np.nan], d["atr14"][:-1]])
    if tf == "15m":
        H1, i1 = A.htf(d, 3600, sec)
        d["atrG"] = mapped(A.atr(H1["h"], H1["l"], H1["c"], 14), i1)
    else:
        d["atrG"] = d["atr14"]
    D1, id1 = A.htf(d, 86400, sec)
    d["d50"] = mapped(A.ema(D1["c"], 50), id1)
    d["atr10"] = A.atr(h, l, c, 10)
    d["rsi14"] = A.rsi(c, 14)
    d["rsi2"] = A.rsi(c, 2)
    d["ema20"] = A.ema(c, 20)
    d["ema50"] = A.ema(c, 50)
    s20 = pd.Series(c).rolling(20)
    mu, sd = s20.mean().to_numpy(), s20.std(ddof=0).to_numpy()
    d["bbu"], d["bbl"] = mu + 2 * sd, mu - 2 * sd
    for n, nm in ((20, "20"), (7 * bpd, "w")):
        d["hh" + nm] = pd.Series(h).shift(1).rolling(n).max().to_numpy()
        d["ll" + nm] = pd.Series(l).shift(1).rolling(n).min().to_numpy()
    lp = np.log(c)
    for nm, days in (("r1", 1), ("r3", 3)):
        n = days * bpd
        r = np.full_like(c, np.nan)
        r[n:] = lp[n:] - lp[:-n]
        sdv = pd.Series(r).shift(1).rolling(30 * bpd, min_periods=10 * bpd).std().to_numpy()
        d[nm + "z"] = r / sdv
    tt = (d["t"] + IST).astype("datetime64[ms]")
    d["year"] = tt.astype("datetime64[Y]").astype(int) + 1970
    d["dev"] = d["t"] >= FROM
    return d


def events(d: dict) -> dict:
    c, o = d["c"], d["o"]
    body = c - o
    ev = {}
    for a in (1, 2, 3):
        b, s = A.ut_bot(c, d["atr10"], a)
        ev[f"UT Al/Sat a={a}"] = (b | s, np.where(b, 1.0, -1.0))
    for k in (1.5, 2, 3):
        ev[f"sert mum > {k}×ATR"] = (np.abs(body) > k * d["patr"], np.sign(body))
    for lo in (30, 20):
        r = d["rsi14"]
        ev[f"RSI14 < {lo} / > {100 - lo}"] = ((r < lo) | (r > 100 - lo), np.where(r > 50, 1.0, -1.0))
    for lo in (10, 5):
        r = d["rsi2"]
        ev[f"RSI2 < {lo} / > {100 - lo}"] = ((r < lo) | (r > 100 - lo), np.where(r > 50, 1.0, -1.0))
    for nm, lab in (("r1", "1 günlük"), ("r3", "3 günlük")):
        z = d[nm + "z"]
        ev[f"{lab} getiri > 2σ"] = (np.abs(z) > 2, np.sign(z))
    zz = (c - d["ema50"]) / d["atr14"]
    ev["EMA50'den > 3 ATR uzak"] = (np.abs(zz) > 3, np.sign(zz))
    for nm, lab in (("20", "20 mum"), ("w", "1 hafta")):
        up, dn = c > d["hh" + nm], c < d["ll" + nm]
        ev[f"kanal kırılımı ({lab})"] = (up | dn, np.where(up, 1.0, -1.0))
    up, dn = c > d["bbu"], c < d["bbl"]
    ev["Bollinger (20, 2σ) dışında"] = (up | dn, np.where(up, 1.0, -1.0))
    x = np.sign(d["ema20"] - d["ema50"])
    xp = np.concatenate([[np.nan], x[:-1]])
    ev["EMA20/EMA50 kesişimi"] = ((x != xp) & ~np.isnan(xp) & ~np.isnan(x) & (x != 0), x)
    rng = np.random.default_rng(11)
    n = len(c)
    ev["rastgele (taban)"] = (rng.random(n) < 0.05, np.where(rng.random(n) < 0.5, 1.0, -1.0))
    return ev


# ---------------------------------------------------------------- benzetim
def outcome(d, e, dirn, tp, sl, H):
    """Önce hangisi: getiri (bps, komisyonsuz), kâr al'a ulaştı mı, çıkış mumu (girişe göre)."""
    wh = np.lib.stride_tricks.sliding_window_view(d["h"], H)[e]
    wl = np.lib.stride_tricks.sliding_window_view(d["l"], H)[e]
    px = d["o"][e]
    up = np.where(dirn > 0, px + tp, px + sl)
    dn = np.where(dirn > 0, px - sl, px - tp)
    hu = wh >= up[:, None]
    hd = wl <= dn[:, None]
    iu = np.where(hu.any(1), hu.argmax(1), H)
    idn = np.where(hd.any(1), hd.argmax(1), H)
    win = np.where(dirn > 0, iu < idn, idn < iu)
    lose = ~win & (np.minimum(iu, idn) < H)
    last = d["c"][e + H - 1]
    ret = np.where(win, tp / px, np.where(lose, -sl / px, dirn * (last - px) / px)) * 1e4
    return ret, win, np.minimum(np.minimum(iu, idn), H - 1)


def flat_only(sig: np.ndarray, exit_bar: np.ndarray) -> np.ndarray:
    """Aynı anda tek pozisyon: açık işlem varken gelen sinyaller atlanır (çıkış mumundan sonraki mumdan itibaren yeni sinyal)."""
    keep = np.zeros(len(sig), bool)
    k = 0
    while k < len(sig):
        keep[k] = True
        k = int(np.searchsorted(sig, exit_bar[k] + 1, side="left"))
    return keep


def pf(x: np.ndarray) -> float:
    g, b = x[x > 0].sum(), -x[x < 0].sum()
    return g / b if b > 0 else math.inf


def scan_tf(tf: str) -> list[dict]:
    sec = TFS[tf]
    H = HOLD_DAYS[tf] * (86400 // sec)
    data = {}
    for s in COINS:
        d = prep(load15(s), tf)
        data[s] = (d, events(d))
    names = list(next(iter(data.values()))[1].keys())
    rows = []
    for name in names:
        for side, sgn in (("devam", 1.0), ("ters", -1.0)):
            per: dict = {}
            for s, (d, ev) in data.items():
                m, dirn = ev[name]
                dirn = sgn * dirn
                ok = m & d["dev"] & ~np.isnan(d["atrG"]) & ~np.isnan(dirn) & (dirn != 0)
                sig = np.flatnonzero(ok)
                sig = sig[sig + 1 + H <= len(d["c"])]
                if not len(sig):
                    continue
                e = sig + 1
                a = d["atrG"][sig]
                dr = dirn[sig]
                ref = d["d50"][sig]
                trend_ok = ~np.isnan(ref) & (np.sign(d["c"][sig] - ref) == dr)
                for g in GEOM:
                    ret, win, off = outcome(d, e, dr, g[0] * a, g[1] * a, H)
                    for flt, fm in (("yok", np.ones(len(sig), bool)), ("günlük EMA50", trend_ok)):
                        idx = np.flatnonzero(fm)
                        if not len(idx):
                            continue
                        ii = idx[flat_only(sig[idx], (e + off)[idx])]
                        rec = per.setdefault((g, flt), {"net": [], "win": [], "year": [], "coin": {}})
                        net = ret[ii] - FEE
                        rec["net"].append(net)
                        rec["win"].append(win[ii])
                        rec["year"].append(d["year"][sig[ii]])
                        rec["coin"][s] = float(net.mean())
            for (g, flt), rec in per.items():
                net = np.concatenate(rec["net"])
                win = np.concatenate(rec["win"])
                yr = np.concatenate(rec["year"])
                years = {}
                for y in YEARS:
                    k = yr == y
                    years[y] = (int(k.sum()), float(win[k].mean() * 100) if k.any() else math.nan,
                                float(net[k].mean()) if k.any() else math.nan)
                pos = sum(1 for v in rec["coin"].values() if v > 0)
                star = (
                    len(net) >= CAND["minTrades"]
                    and pos >= CAND["posCoins"]
                    and all(n_ >= CAND["yearMinTrades"] and w_ >= CAND["yearWinRate"] and a_ > 0 for n_, w_, a_ in years.values())
                )
                rows.append({
                    "tf": tf, "event": name, "side": side, "filter": flt, "tp": g[0], "sl": g[1], "n": len(net),
                    "win": float(win.mean() * 100), "avg": float(net.mean()), "t": float(A.tstat(net)), "pf": float(pf(net)),
                    "posCoins": pos, "years": years, "minYearAvg": min(v[2] for v in years.values()),
                    "coins": rec["coin"], "star": bool(star),
                })
    return rows


def fmt(r: dict) -> str:
    ys = " | ".join(f"{r['years'][y][1]:.0f}% / {r['years'][y][2]:+.0f} ({r['years'][y][0]})" for y in YEARS)
    mark = " ★" if r["star"] else ""
    return (f"| {r['tf']} | {r['event']} | {r['side']} | {r['filter']} | {r['tp']}/{r['sl']} | {r['n']} | {r['win']:.1f} | "
            f"{r['avg']:+.1f} | {r['t']:+.1f} | {r['pf']:.2f} | {r['posCoins']}/15 | {ys} |{mark}")


def main() -> None:
    with ProcessPoolExecutor(max_workers=4) as ex:
        rows = [r for part in ex.map(scan_tf, list(TFS)) for r in part]
    A.out("# Uzun geçmiş çalışması — geliştirme taraması (2020-01 → 2022-12, 15 coin)")
    A.out()
    A.out(f"{len(rows)} kural. Hücre (yıllar): kazanma % / ort. bps (işlem). Ort. bps komisyon sonrası. ★ = aday "
          f"(her yıl ≥ {CAND['yearMinTrades']} işlem, kazanma ≥ %{CAND['yearWinRate']:.0f}, ort. > 0; ≥ {CAND['posCoins']}/15 "
          f"coin artı; ≥ {CAND['minTrades']} işlem).")
    A.out()
    hdr = ("| grafik | olay | yön | filtre | TP/SL | işlem | kazanma % | ort. bps | t | PF | artı coin | "
           + " | ".join(str(y) for y in YEARS) + " |")
    sep = "|---" * 11 + "|---" * len(YEARS) + "|"
    stars = sorted([r for r in rows if r["star"]], key=lambda r: (-r["minYearAvg"], -r["t"]))
    A.out("## Adaylar (★), en kötü yılın ortalamasına göre")
    A.out()
    if stars:
        A.out(hdr)
        A.out(sep)
        for r in stars:
            A.out(fmt(r))
    else:
        A.out("- yok")
    A.out()
    A.out("## Her grafikte kazanma ≥ %70 olan en iyi 12 kural (en kötü yıla göre; aday olsun olmasın)")
    for tf in TFS:
        A.out()
        A.out(f"### {tf}")
        A.out()
        A.out(hdr)
        A.out(sep)
        best = sorted([r for r in rows if r["tf"] == tf and r["win"] >= 70 and r["n"] >= 100],
                      key=lambda r: -r["minYearAvg"])[:12]
        for r in best:
            A.out(fmt(r))
    A.out()
    A.out("## Rastgele giriş (taban)")
    A.out()
    A.out(hdr)
    A.out(sep)
    for r in rows:
        if r["event"] == "rastgele (taban)" and r["side"] == "devam" and r["filter"] == "yok":
            A.out(fmt(r))
    if stars:
        top = stars[0]
        A.out()
        A.out(f"## Seçilen: {top['tf']} · {top['event']} · {top['side']} · filtre {top['filter']} · TP/SL {top['tp']}/{top['sl']}")
        A.out()
        A.out("Komşu geometriler (aynı olay/yön/filtre):")
        A.out()
        A.out(hdr)
        A.out(sep)
        for r in rows:
            if (r["tf"], r["event"], r["side"], r["filter"]) == (top["tf"], top["event"], top["side"], top["filter"]):
                A.out(fmt(r))
        A.out()
        A.out("Coinler (ort. bps): " + ", ".join(f"{k} {v:+.0f}" for k, v in top["coins"].items()))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "long_study.md").write_text("\n".join(A.lines) + "\n")
    (OUT / "long_study.json").write_text(json.dumps(rows, ensure_ascii=False, default=float))
    print(f"rapor: {OUT / 'long_study.md'}")


if __name__ == "__main__":
    main()
