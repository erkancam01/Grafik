"""Strateji laboratuvarı — 15 dk grafik, 2. aşama geliştirme dönemi (dev2: 2025-04 → 2026-06), analiz evreni 8 coin.

Sınav coinleri (XRP/BNB/DOGE), yedek coinler ve son sınav dönemi (2026-07 → 09) kullanılmaz.
Dolum (temkinli; Strateji Test Aracı'ndan kötü olabilir, iyi değil):
  • Sinyal mum kapanışında. Piyasa girişi sonraki mumun açılışında (taker %0,05).
  • Limit girişi: sonraki `lim_bars` mum içinde fiyat seviyeyi GEÇERSE (dokunmak yetmez); açılış zaten ötesindeyse
    açılıştan (maker %0,02). Dolum mumunda kâr al sayılmaz, zarar kes sayılır.
  • Kâr al (limit, maker %0,02) / zarar kes (stop, taker %0,05) mum içinde; aynı mumda ikisi de → zarar kes.
    Açılışta seviye aşılmışsa açılıştan. Sinyal çıkışı ve süre sınırı sonraki açılışta (taker).
  • Aynı anda tek pozisyon; dönem sonunda açık pozisyon son kapanıştan kapatılır.
Kullanım: python tools/backtest/strategy_lab.py  →  .cache/results/lab_15m.md
"""

from __future__ import annotations

import itertools
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

_argv = sys.argv
sys.argv = [sys.argv[0], "--tf", "15m"]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402

sys.argv = _argv

IST = A.IST
FROM2 = A.FROM
TO2 = np.datetime64("2026-07-01T00:00:00").astype("datetime64[ms]").astype(np.int64) - IST - 1
TAKER, MAKER = 5.0, 2.0  # bps / taraf
QUARTERS = ["2025Ç2", "2025Ç3", "2025Ç4", "2026Ç1", "2026Ç2"]


# ---------------------------------------------------------------- veri
def sma(x, n):
    return pd.Series(x).rolling(n).mean().to_numpy()


def prep(sym: str) -> dict:
    d = A.load(sym)  # 15 dk
    c, h, l, o, v = d["c"], d["h"], d["l"], d["o"], d["v"]
    d["atr15"] = A.atr(h, l, c, 14)
    d["patr"] = np.concatenate([[np.nan], d["atr15"][:-1]])
    H1, i1 = A.htf(d, 3600)
    d["atr1h"] = A.atr(H1["h"], H1["l"], H1["c"], 14)[i1]
    D1, id1 = A.htf(d, 86400)
    d["d50"] = A.ema(D1["c"], 50)[id1]
    d["d20"] = A.ema(D1["c"], 20)[id1]
    d["ema200"] = A.ema(c, 200)
    d["sma5"] = sma(c, 5)
    d["sma20"] = sma(c, 20)
    d["sd20"] = pd.Series(c).rolling(20).std(ddof=0).to_numpy()
    d["rsi2"] = A.rsi(c, 2)
    d["rsi14"] = A.rsi(c, 14)
    for n in (48, 96):
        d[f"hh{n}"] = pd.Series(h).shift(1).rolling(n).max().to_numpy()
        d[f"ll{n}"] = pd.Series(l).shift(1).rolling(n).min().to_numpy()
    day = d["t"] // 86_400_000
    tp_ = (h + l + c) / 3
    pv = pd.Series(tp_ * v).groupby(day).cumsum().to_numpy()
    vv = pd.Series(v).groupby(day).cumsum().to_numpy()
    d["vwap"] = pv / vv
    d["dev"] = (d["t"] >= FROM2) & (d["t"] <= TO2)
    tt = (d["t"] + IST).astype("datetime64[ms]")
    y = tt.astype("datetime64[Y]").astype(int) + 1970
    m = tt.astype("datetime64[M]").astype(int) % 12
    d["q"] = np.array([f"{a}Ç{b // 3 + 1}" for a, b in zip(y, m)])
    return d


def trend(d, kind):
    c = d["c"]
    if kind == "yok":
        return np.ones(len(c), bool), np.ones(len(c), bool)
    ref = {"ema200": d["ema200"], "g50": d["d50"], "g20": d["d20"]}[kind]
    return c > ref, c < ref


# ---------------------------------------------------------------- benzetim
def simulate(d, L, S, tp, sl, *, entry="piyasa", lim=None, lim_bars=1, xl=None, xs=None, max_bars=96, trail=None):
    """trail: iz süren stop mesafesi (fiyat); her mum kapanışında en iyi fiyattan bu kadar geride güncellenir
    (yeni seviye sonraki mumdan geçerli, yalnız lehe kayar)."""
    o, h, l, c = (d[k].tolist() for k in ("o", "h", "l", "c"))
    n = len(c)
    devi = np.flatnonzero(d["dev"])
    last = int(devi[-1])
    sig = np.flatnonzero((L ^ S) & d["dev"])
    Ll = L.tolist()
    tpl = tp.tolist() if tp is not None else None
    sll = sl.tolist() if sl is not None else None
    lml = lim.tolist() if lim is not None else None
    xll = xl.tolist() if xl is not None else None
    xsl = xs.tolist() if xs is not None else None
    trl = trail.tolist() if trail is not None else None
    out = []
    free = 0
    for i in sig.tolist():
        if i < free or i + 1 >= n or i >= last:
            continue
        dr = 1 if Ll[i] else -1
        tpd = tpl[i] if tpl is not None else math.inf
        sld = sll[i] if sll is not None else math.inf
        if not (tpd > 0 and sld > 0):
            continue
        # giriş
        full = True  # dolum mumunda tüm yol (açılıştan) geçerli mi
        if entry == "piyasa":
            j, px, fin = i + 1, o[i + 1], TAKER
        else:
            lvl = c[i] - dr * lml[i]
            j = -1
            for jj in range(i + 1, min(i + 1 + lim_bars, n, last + 1)):
                if (dr > 0 and o[jj] < lvl) or (dr < 0 and o[jj] > lvl):
                    j, px = jj, o[jj]
                    break
                if (dr > 0 and l[jj] < lvl) or (dr < 0 and h[jj] > lvl):
                    j, px, full = jj, lvl, False
                    break
            if j < 0:
                free = i + 1
                continue
            fin = MAKER
        tpl_ = px + dr * tpd
        sll_ = px - dr * sld
        trd = trl[i] if trl is not None else math.inf
        best = px
        k = j
        ex = None
        while ex is None:
            if k > j:
                # açılışta boşluk
                if (dr > 0 and o[k] <= sll_) or (dr < 0 and o[k] >= sll_):
                    ex = (k, o[k], TAKER, "SL")
                    break
                if (dr > 0 and o[k] >= tpl_) or (dr < 0 and o[k] <= tpl_):
                    ex = (k, o[k], MAKER, "TP")
                    break
            hit_sl = (l[k] <= sll_) if dr > 0 else (h[k] >= sll_)
            hit_tp = ((h[k] >= tpl_) if dr > 0 else (l[k] <= tpl_)) and (k > j or full)
            if hit_sl:
                ex = (k, sll_, TAKER, "SL")
                break
            if hit_tp:
                ex = (k, tpl_, MAKER, "TP")
                break
            if k >= last or k + 1 >= n:
                ex = (k, c[k], TAKER, "Dönem sonu")
                break
            if dr > 0 and xll is not None and xll[k]:
                ex = (k + 1, o[k + 1], TAKER, "Sinyal")
                break
            if dr < 0 and xsl is not None and xsl[k]:
                ex = (k + 1, o[k + 1], TAKER, "Sinyal")
                break
            if max_bars and k - j + 1 >= max_bars:
                ex = (k + 1, o[k + 1], TAKER, "Süre")
                break
            if trd < math.inf:
                best = max(best, h[k]) if dr > 0 else min(best, l[k])
                ns = best - dr * trd
                if (dr > 0 and ns > sll_) or (dr < 0 and ns < sll_):
                    sll_ = ns
            k += 1
        kx, pxx, fout, why = ex
        gross = dr * (pxx - px) / px * 1e4
        out.append((i, dr, gross, fin + fout, why, kx - j + 1))
        free = kx if why in ("SL", "TP", "Dönem sonu") else kx
    return out


# ---------------------------------------------------------------- aileler
def families(d):
    """(aile, ayar) → simulate argümanları üreten tanımlar."""
    c, o, h, l = d["c"], d["o"], d["h"], d["l"]
    a1 = d["atr1h"]
    body = c - o
    for tr, lo, slk, mb in itertools.product(("ema200", "g50", "yok"), (5, 10, 20), (2.0, 3.0), (32, 96)):
        up, dn = trend(d, tr)
        yield ("RSI2 geri çekilme", f"trend {tr}, RSI2<{lo}, SL {slk}×1sATR, en çok {mb}"), dict(
            L=(d["rsi2"] < lo) & up, S=(d["rsi2"] > 100 - lo) & dn, tp=None, sl=slk * a1,
            xl=c > d["sma5"], xs=c < d["sma5"], max_bars=mb)
    for tr, z, slk in itertools.product(("ema200", "g50", "yok"), (2.0, 2.5), (2.0, 3.0)):
        up, dn = trend(d, tr)
        lower = d["sma20"] - z * d["sd20"]
        upper = d["sma20"] + z * d["sd20"]
        yield ("Bollinger dönüşü", f"trend {tr}, {z}σ, SL {slk}×1sATR"), dict(
            L=(c < lower) & up, S=(c > upper) & dn, tp=None, sl=slk * a1, xl=c > d["sma20"], xs=c < d["sma20"], max_bars=96)
    for tr, x, slk in itertools.product(("ema200", "g50", "yok"), (1.0, 1.5), (2.0, 3.0)):
        up, dn = trend(d, tr)
        yield ("VWAP dönüşü", f"trend {tr}, VWAP ∓ {x}×1sATR, SL {slk}×1sATR"), dict(
            L=(c < d["vwap"] - x * a1) & up, S=(c > d["vwap"] + x * a1) & dn, tp=None, sl=slk * a1,
            xl=c > d["vwap"], xs=c < d["vwap"], max_bars=96)
    for tr, nn, (tpk, slk) in itertools.product(("ema200", "g50", "yok"), (48, 96), ((1, 2), (1, 2.5), (2, 2))):
        up, dn = trend(d, tr)
        yield ("Kırılım", f"trend {tr}, {nn} mum, TP/SL {tpk}/{slk}×1sATR"), dict(
            L=(c > d[f"hh{nn}"]) & up, S=(c < d[f"ll{nn}"]) & dn, tp=tpk * a1, sl=slk * a1, max_bars=96)
    for tr, kk, (tpk, slk), ent in itertools.product(("ema200", "g50", "yok"), (2.5, 3.0), ((1, 2), (1, 2.5)), ("piyasa", "limit")):
        up, dn = trend(d, tr)
        strong = np.abs(body) > kk * d["patr"]
        kw = dict(L=strong & (body > 0) & up, S=strong & (body < 0) & dn, tp=tpk * a1, sl=slk * a1, max_bars=96)
        if ent == "limit":
            kw.update(entry="limit", lim=0.3 * np.abs(body), lim_bars=4)
        yield ("Momentum mumu", f"trend {tr}, gövde>{kk}×ATR, TP/SL {tpk}/{slk}×1sATR, {ent}"), kw
    for tr, nn, slk, trk in itertools.product(("g50", "g20", "yok"), (96, 192), (2.0, 3.0), (3.0, 5.0)):
        up, dn = trend(d, tr)
        hh = pd.Series(h).shift(1).rolling(nn).max().to_numpy()
        ll = pd.Series(l).shift(1).rolling(nn).min().to_numpy()
        yield ("Trend takibi (kırılım + iz süren stop)", f"trend {tr}, {nn} mum kanal, SL {slk}, iz {trk}×1sATR"), dict(
            L=(c > hh) & up, S=(c < ll) & dn, tp=None, sl=slk * a1, trail=trk * a1, max_bars=960)
    for tr, slk, trk in itertools.product(("g50", "g20"), (2.0, 3.0), (3.0, 5.0)):
        up, dn = trend(d, tr)
        e50 = A.ema(c, 50)
        cross_up = (e50 > d["ema200"]) & (np.concatenate([[False], (e50 <= d["ema200"])[:-1]]))
        cross_dn = (e50 < d["ema200"]) & (np.concatenate([[False], (e50 >= d["ema200"])[:-1]]))
        yield ("Trend takibi (EMA50/200 kesişimi + iz)", f"trend {tr}, SL {slk}, iz {trk}×1sATR"), dict(
            L=cross_up & up, S=cross_dn & dn, tp=None, sl=slk * a1, trail=trk * a1, max_bars=960)
    for tr, (tpk, slk) in itertools.product(("ema200", "g50", "yok"), ((1, 2), (0.75, 1.5))):
        up, dn = trend(d, tr)
        rng_ = h - l
        lw = np.minimum(o, c) - l
        uw = h - np.maximum(o, c)
        L = (lw > 1.5 * d["patr"]) & ((c - l) > 0.66 * rng_) & up
        S = (uw > 1.5 * d["patr"]) & ((h - c) > 0.66 * rng_) & dn
        yield ("Uzun fitil", f"trend {tr}, fitil>1.5×ATR, TP/SL {tpk}/{slk}×1sATR"), dict(L=L, S=S, tp=tpk * a1, sl=slk * a1, max_bars=96)


# ---------------------------------------------------------------- değerlendirme
def evaluate(results):
    """results: coin → [(i, dir, gross, fees, why, bars)], d için q etiketleri ayrıca."""
    rows = []
    for (fam, cfg), per in results.items():
        allnet, allwin = [], []
        qn = {q: [] for q in QUARTERS}
        coin_avg = {}
        taker_net = []
        bars = []
        for s, (tr, qlab) in per.items():
            if not tr:
                coin_avg[s] = np.nan
                continue
            g = np.array([x[2] for x in tr])
            f = np.array([x[3] for x in tr])
            net = g - f
            allnet.append(net)
            allwin.append(net > 0)
            taker_net.append(g - 2 * TAKER)
            bars += [x[5] for x in tr]
            coin_avg[s] = net.mean()
            for x, nn in zip(tr, net):
                qn[qlab[x[0]]].append(nn)
        if not allnet:
            continue
        net = np.concatenate(allnet)
        win = np.concatenate(allwin)
        tn = np.concatenate(taker_net)
        qa = {q: (np.mean(v) if v else np.nan, (np.mean(np.array(v) > 0) * 100 if v else np.nan), len(v)) for q, v in qn.items()}
        pos = sum(1 for v in coin_avg.values() if v > 0)
        gp, gl = net[net > 0].sum(), -net[net <= 0].sum()
        rows.append(dict(fam=fam, cfg=cfg, n=len(net), win=win.mean() * 100, avg=net.mean(), avg_taker=tn.mean(), pf=gp / gl if gl > 0 else np.inf,
                         q=qa, pos=pos, qmin=min(v[0] for v in qa.values() if not np.isnan(v[0])),
                         qwin_min=min(v[1] for v in qa.values() if not np.isnan(v[1])), bars=np.mean(bars)))
    return rows


def main() -> None:
    data = {s: prep(s) for s in A.COINS}
    print("veri hazır")
    results: dict = {}
    for s, d in data.items():
        for (fam, cfg), kw in families(d):
            L, S = kw.pop("L"), kw.pop("S")
            tp, sl = kw.pop("tp"), kw.pop("sl")
            tr = simulate(d, L, S, tp, sl, **kw)
            results.setdefault((fam, cfg), {})[s] = (tr, d["q"])
        print(f"{s} bitti")
    rows = evaluate(results)
    A.out("# Strateji laboratuvarı — 15 dk, dev2 (2025-04 → 2026-06), 8 coin, temkinli dolum")
    A.out()
    A.out("ort. = işlem başına komisyon sonrası bps (limit %0,02 / piyasa-stop %0,05); 'hep taker' = tüm dolumlar %0,05.")
    A.out("Tutarlılık: 5 çeyreğin en kötüsü (ort. bps ve kazanma %) ve artı coin sayısı.")
    A.out()
    hdr = "| aile | ayar | işlem | kazanma % | ort. | hep taker | PF | en kötü çeyrek ort. | en kötü çeyrek kazanma % | artı coin | ort. mum |"
    for title, key, filt in [
        ("En tutarlılar (en kötü çeyrek ortalamasına göre)", lambda r: r["qmin"], lambda r: r["n"] >= 400),
        ("Kazanma ≥ %70 olanlar (en kötü çeyrek ortalamasına göre)", lambda r: r["qmin"], lambda r: r["n"] >= 400 and r["win"] >= 70),
        ("Toplam ortalamaya göre", lambda r: r["avg"], lambda r: r["n"] >= 400),
    ]:
        A.out(f"## {title}")
        A.out()
        A.out(hdr)
        A.out("|---|---|---|---|---|---|---|---|---|---|---|")
        for r in sorted(filter(filt, rows), key=key, reverse=True)[:15]:
            A.out(f"| {r['fam']} | {r['cfg']} | {r['n']} | {r['win']:.1f} | {r['avg']:+.1f} | {r['avg_taker']:+.1f} | {r['pf']:.2f} | {r['qmin']:+.1f} | {r['qwin_min']:.1f} | {r['pos']}/8 | {r['bars']:.0f} |")
        A.out()
    A.out("## Aile özetleri (her ailenin en tutarlı ayarı)")
    A.out()
    A.out(hdr)
    A.out("|---|---|---|---|---|---|---|---|---|---|---|")
    for fam in dict.fromkeys(r["fam"] for r in rows):
        best = max((r for r in rows if r["fam"] == fam and r["n"] >= 200), key=lambda r: r["qmin"], default=None)
        if best:
            r = best
            A.out(f"| {r['fam']} | {r['cfg']} | {r['n']} | {r['win']:.1f} | {r['avg']:+.1f} | {r['avg_taker']:+.1f} | {r['pf']:.2f} | {r['qmin']:+.1f} | {r['qwin_min']:.1f} | {r['pos']}/8 | {r['bars']:.0f} |")
    out = A.ROOT / ".cache" / "results" / "lab_15m.md"
    out.write_text("\n".join(A.lines) + "\n")
    print(f"rapor: {out}")


if __name__ == "__main__":
    main()
