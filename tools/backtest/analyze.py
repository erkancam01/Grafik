"""Piyasa davranışı analizi — yöntemi deneme-yanılma yerine ölçümle kurmak için.

Yalnız geliştirme dönemi (2025-04-01 → 2026-03-31, İstanbul saati) ve sınavlarda kullanılmayan coinler:
BTC, ETH, SOL (geliştirme) + BCH, DOT, ETC, TRX, XLM (hiçbir sınavda yok). XRP/BNB/DOGE ve yedek coinler
(ADA/AVAX/LINK/LTC) ile doğrulama/son sınav dönemlerine dokunulmaz.

Sorular:
  A) Ufuklara göre devam mı geri dönüş mü: geçmiş getiri (5 dk … 1 gün) ile gelecek getiri ilişkisi.
  B) Olay sonrası: UT Al/Sat, sert mum, RSI aşırılığı, 1 saatlik EMA'dan uzaklaşma → sonraki yol, "önce hangisi"
     olasılıkları (1 saatlik ATR cinsinden kâr al / zarar kes) ve komisyon sonrası beklenti; devam ve ters yön.
  C) Saat bazında oynaklık ve komisyonun hareketin ne kadarını yediği.
Kullanım: python tools/backtest/analyze.py [--tf 5m|15m]  →  .cache/results/analysis_<tf>.md
Giriş sinyal mumunun kapanışından sonraki mumun açılışında (Strateji Test Aracı gibi); aynı mumda iki seviye
birden → zarar sayılır (temkinli).
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BARS = ROOT / ".cache" / "bars"
TF = sys.argv[sys.argv.index("--tf") + 1] if "--tf" in sys.argv else "5m"
TF_SEC = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400}[TF]
OUT = ROOT / ".cache" / "results" / f"analysis_{TF}.md"
COINS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BCHUSDT", "DOTUSDT", "ETCUSDT", "TRXUSDT", "XLMUSDT"]
IST = 3 * 3_600_000
FROM = np.datetime64("2025-04-01T00:00:00").astype("datetime64[ms]").astype(np.int64) - IST
TO = np.datetime64("2026-04-01T00:00:00").astype("datetime64[ms]").astype(np.int64) - IST - 1
FEE_BPS = 10.0  # %0,05 × 2 taraf
H_MAX = 86400 // TF_SEC  # 1 gün

FWD = {k: max(1, v // TF_SEC) for k, v in {"5dk": 300, "15dk": 900, "1s": 3600, "4s": 14400, "12s": 43200, "1g": 86400}.items() if v >= TF_SEC}

lines: list[str] = []


def out(s: str = "") -> None:
    print(s)
    lines.append(s)


# ---------------------------------------------------------------- veri ve göstergeler
def load(sym: str):
    a = np.fromfile(BARS / f"{sym}_5m.f64", dtype="<f8").reshape(6, -1)
    d = {k: a[i] for i, k in enumerate(["t", "o", "h", "l", "c", "v"])}
    if TF_SEC == 300:
        return d
    H, _ = htf(d, TF_SEC, 300)
    return H


def rma(x: np.ndarray, n: int) -> np.ndarray:
    """Pine ta.rma: ilk değer SMA, sonra alfa = 1/n."""
    y = np.full_like(x, np.nan)
    ok = np.flatnonzero(~np.isnan(x))
    if len(ok) < n:
        return y
    s = ok[0]
    y[s + n - 1] = x[s : s + n].mean()
    al = 1.0 / n
    for i in range(s + n, len(x)):
        y[i] = al * x[i] + (1 - al) * y[i - 1]
    return y


def ema(x: np.ndarray, n: int) -> np.ndarray:
    y = np.full_like(x, np.nan)
    if len(x) < n:
        return y
    y[n - 1] = x[:n].mean()
    al = 2.0 / (n + 1)
    for i in range(n, len(x)):
        y[i] = al * x[i] + (1 - al) * y[i - 1]
    return y


def atr(h, l, c, n):
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.where(np.isnan(pc), h - l, np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc))))
    return rma(tr, n)


def rsi(c, n=14):
    d = np.diff(c, prepend=np.nan)
    up = rma(np.where(np.isnan(d), np.nan, np.maximum(d, 0)), n)
    dn = rma(np.where(np.isnan(d), np.nan, np.maximum(-d, 0)), n)
    return np.where(dn == 0, 100.0, 100 - 100 / (1 + up / dn))


def ut_bot(c, x_atr, a, with_trail=False):
    """UT Bot Alerts (tools/make_fixtures.py ile aynı mantık)."""
    n = len(c)
    trail = np.zeros(n)
    buy = np.zeros(n, bool)
    sell = np.zeros(n, bool)
    prev = 0.0
    for i in range(n):
        nl = a * x_atr[i] if not math.isnan(x_atr[i]) else math.nan
        s, s1 = c[i], (c[i - 1] if i else math.nan)
        if s > prev and s1 > prev:
            t = max(prev, s - nl) if not math.isnan(nl) else math.nan
        elif s < prev and s1 < prev:
            t = min(prev, s + nl) if not math.isnan(nl) else math.nan
        elif s > prev:
            t = s - nl
        else:
            t = s + nl
        t1 = trail[i - 1] if i else math.nan
        buy[i] = s > t and s1 <= t1
        sell[i] = s < t and t1 <= s1
        trail[i] = t
        prev = 0.0 if math.isnan(t) else t
    return (buy, sell, trail) if with_trail else (buy, sell)


def htf(d, sec, bar_sec=None):
    """Üst zaman dilimi mumları ve her grafik mumunun kapanışında son kapanmış üst mumun indeksi."""
    bar_sec = TF_SEC if bar_sec is None else bar_sec
    k = (d["t"] // (sec * 1000)).astype(np.int64)
    starts = np.flatnonzero(np.diff(k, prepend=k[0] - 1))
    ends = np.append(starts[1:], len(k)) - 1
    H = {"t": k[starts] * sec * 1000, "o": d["o"][starts], "c": d["c"][ends]}
    H["h"] = np.maximum.reduceat(d["h"], starts)
    H["l"] = np.minimum.reduceat(d["l"], starts)
    H["v"] = np.add.reduceat(d["v"], starts)
    idx = np.searchsorted(H["t"], d["t"] + bar_sec * 1000 - sec * 1000, side="right") - 1
    return H, idx


# ---------------------------------------------------------------- ölçümler
def barrier(d, e, dirn, tp, sl, H=H_MAX):
    """Giriş e (açılış), yön dirn; tp/sl fiyat mesafesi. Döner: sonuç getirisi (bps, komisyonsuz) ve kazandı mı."""
    n = len(d["h"])
    ok = e + H < n
    e, dirn, tp, sl = e[ok], dirn[ok], tp[ok], sl[ok]
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
    return ret, win


def fwd(d, e, dirn, hs):
    n = len(d["c"])
    res = {}
    for h in hs:
        ok = e + h - 1 < n
        px = d["o"][e[ok]]
        res[h] = dirn[ok] * (d["c"][e[ok] + h - 1] - px) / px * 1e4
    return res


def tstat(x):
    x = x[~np.isnan(x)]
    return x.mean() / (x.std(ddof=1) / math.sqrt(len(x))) if len(x) > 2 else math.nan


def main() -> None:
    data = {}
    for s in COINS:
        d = load(s)
        d["atr5"] = atr(d["h"], d["l"], d["c"], 14)
        d["atr10"] = atr(d["h"], d["l"], d["c"], 10)
        d["rsi"] = rsi(d["c"])
        H1, i1 = htf(d, 3600)
        d["atr1h"] = atr(H1["h"], H1["l"], H1["c"], 14)[i1]
        d["ema1h"] = ema(H1["c"], 50)[i1]
        D1, id1 = htf(d, 86400)
        d["ema1d"] = ema(D1["c"], 20)[id1]
        d["dev"] = (d["t"] >= FROM) & (d["t"] <= TO)
        data[s] = d
        print(f"{s}: {d['dev'].sum()} geliştirme mumu")

    out(f"# Piyasa davranışı analizi — {TF} grafik (geliştirme dönemi, 8 coin)")
    out()
    # ------------------------------------------------ A) devam mı geri dönüş mü
    out("## A) Geçmiş getiri → gelecek getiri (korelasyon ×100; ort. 8 coin; örtüşmesiz örnekler)")
    out()
    hz = {k: v // TF_SEC for k, v in {"5dk": 300, "15dk": 900, "1s": 3600, "4s": 14400, "1g": 86400}.items() if v >= TF_SEC}
    out("| geçmiş \\ gelecek | " + " | ".join(hz) + " |")
    out("|---|" + "---|" * len(hz))
    for ln, L in hz.items():
        row = []
        for hn, H in hz.items():
            cs = []
            for d in data.values():
                lp = np.log(d["c"])
                idx = np.flatnonzero(d["dev"])
                idx = idx[(idx >= L) & (idx + H < len(lp))][:: max(H, 1)]
                past = lp[idx] - lp[idx - L]
                fut = lp[idx + H] - lp[idx]
                cs.append(np.corrcoef(past, fut)[0, 1] * 100)
            row.append(f"{np.mean(cs):+.1f} ({sum(c > 0 for c in cs)}/8+)")
        out(f"| {ln} | " + " | ".join(row) + " |")
    out()
    out("Pozitif = devam (momentum), negatif = geri dönüş. Parantez: kaç coinde pozitif.")
    out()

    # ------------------------------------------------ B) olaylar
    def events():
        for s, d in data.items():
            dv = d["dev"]
            n = len(d["c"])
            ev = {}
            for a in (1, 2, 3):
                b, sl = ut_bot(d["c"], d["atr10"], a)
                ev[f"UT Al/Sat a={a}"] = (b | sl, np.where(b, 1, -1))
            body = d["c"] - d["o"]
            prev_atr = np.concatenate([[np.nan], d["atr5"][:-1]])
            for k in (2, 3):
                ev[f"sert mum > {k}×ATR"] = (np.abs(body) > k * prev_atr, np.sign(body))
            ev["RSI < 25 / > 75"] = ((d["rsi"] < 25) | (d["rsi"] > 75), np.where(d["rsi"] > 50, 1, -1))
            z = (d["c"] - d["ema1h"]) / d["atr1h"]
            ev["1s EMA50'den > 2 ATR uzak"] = (np.abs(z) > 2, np.sign(z))
            rng = np.random.default_rng(7)
            base = rng.random(n) < 0.05
            ev["rastgele (taban)"] = (base, np.where(rng.random(n) < 0.5, 1, -1))
            for name, (m, dirn) in ev.items():
                sig = np.flatnonzero(m & dv & ~np.isnan(d["atr1h"]))
                sig = sig[sig + 1 + H_MAX < n]
                yield s, name, sig, dirn[sig].astype(float)

    agg: dict[str, dict] = {}
    for s, name, sig, dirn in events():
        d = data[s]
        e = sig + 1
        a1 = d["atr1h"][sig]
        g = agg.setdefault(name, {"n": 0, "fwd": {}, "bar": {}, "coin": {}})
        g["n"] += len(sig)
        for h, v in fwd(d, e, dirn, tuple(FWD.values())).items():
            g["fwd"].setdefault(h, []).append(v)
        for tpk, slk in ((1, 1), (0.5, 1.5), (1, 2), (2, 2), (2, 4)):
            for side, sd in (("devam", 1.0), ("ters", -1.0)):
                ret, win = barrier(d, e, sd * dirn, tpk * a1, slk * a1)
                key = (tpk, slk, side)
                g["bar"].setdefault(key, [[], []])
                g["bar"][key][0].append(ret)
                g["bar"][key][1].append(win)
                g["coin"].setdefault(key, {})[s] = ret.mean() - FEE_BPS

    out("## B) Olaylardan sonra: yön = olayın yönü (devam), getiriler bps (1 bps = %0,01), komisyonsuz")
    out()
    out("| olay | olay sayısı | " + " | ".join(f"+{k}" for k in FWD) + " |")
    out("|---|---|" + "---|" * len(FWD))
    for name, g in agg.items():
        cells = []
        for h in FWD.values():
            v = np.concatenate(g["fwd"][h])
            cells.append(f"{v.mean():+.1f} (t {tstat(v):+.1f})")
        out(f"| {name} | {g['n']} | " + " | ".join(cells) + " |")
    out()
    out("## B2) Önce hangisi: kâr al / zarar kes (1 saatlik ATR katı), 1 gün içinde; kazanma % ve komisyon sonrası ort. bps")
    out()
    out("Rastgele girişte beklenen kazanma ≈ SL/(TP+SL); beklenti ≈ −10 bps (komisyon). Coinler: kaç coinde komisyon sonrası artı.")
    out()
    out("| olay | yön | TP/SL | kazanma % | ort. bps (kom. sonrası) | t | artı coin |")
    out("|---|---|---|---|---|---|---|")
    best = []
    for name, g in agg.items():
        for (tpk, slk, side), (rets, wins) in g["bar"].items():
            r = np.concatenate(rets)
            w = np.concatenate(wins)
            net = r - FEE_BPS
            pos = sum(v > 0 for v in g["coin"][(tpk, slk, side)].values())
            out(f"| {name} | {side} | {tpk}/{slk} | {w.mean() * 100:.1f} | {net.mean():+.1f} | {tstat(net):+.1f} | {pos}/8 |")
            best.append((net.mean(), w.mean() * 100, name, side, tpk, slk, tstat(net), pos))
    out()
    out("### En iyi 10 (komisyon sonrası ortalamaya göre)")
    out()
    for b in sorted(best, reverse=True)[:10]:
        out(f"- {b[2]} · {b[3]} · TP/SL {b[4]}/{b[5]}: ort {b[0]:+.1f} bps, kazanma %{b[1]:.1f}, t {b[6]:+.1f}, artı coin {b[7]}/8")
    out()

    # ------------------------------------------------ C) saatler
    out(f"## C) Saat (UTC) bazında: ort. |{TF} getiri| (bps), 1 saatlik ATR (%), komisyonun 1 saatlik ATR'ye oranı")
    out()
    out("| saat | ort. |getiri| bps | 1s ATR % | komisyon / 1s ATR | ort. yönlü getiri bps (t) |")
    out("|---|---|---|---|---|")
    for hr in range(24):
        ab, at, sg = [], [], []
        for d in data.values():
            hh = ((d["t"] // 3_600_000) % 24).astype(int)
            m = d["dev"] & (hh == hr)
            r = (d["c"][m] - d["o"][m]) / d["o"][m] * 1e4
            ab.append(np.abs(r))
            sg.append(r)
            at.append(d["atr1h"][m] / d["c"][m] * 100)
        ab, at, sg = np.concatenate(ab), np.concatenate(at), np.concatenate(sg)
        out(f"| {hr:02d} | {ab.mean():.1f} | {np.nanmean(at):.2f} | {FEE_BPS / 100 / np.nanmean(at):.2f} | {sg.mean():+.2f} ({tstat(sg):+.1f}) |")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print(f"\nrapor: {OUT}")


if __name__ == "__main__":
    main()
