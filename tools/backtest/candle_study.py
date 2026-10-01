"""Sert momentum mumu sonrası devam — sağlamlık incelemesi (geliştirme dönemi, analiz evreni 8 coin).

analyze.py'de 15 dk grafikte bulunan etki: gövdesi 3×ATR'yi aşan mumdan sonra aynı yönde gitmek, kâr al 1 /
zarar kes 2 (1 saatlik ATR) ile rastgele girişin (%64) üstünde kazanma verdi. Burada: eşik, yön, çeyrek, coin,
UT sinyaliyle kesişim, çıkış geometrisi ve "aynı anda tek pozisyon" (stratejideki gibi) incelenir.
Kullanım: python tools/backtest/candle_study.py --tf 15m
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402  (zaman dilimi --tf ile)

QUARTERS = ["2025Ç2", "2025Ç3", "2025Ç4", "2026Ç1"]


def quarter(t_ms: np.ndarray) -> np.ndarray:
    d = (t_ms + A.IST).astype("datetime64[ms]")
    y = d.astype("datetime64[Y]").astype(int) + 1970
    m = d.astype("datetime64[M]").astype(int) % 12
    return np.array([f"{a}Ç{b // 3 + 1}" for a, b in zip(y, m)])


def outcome(d, e, dirn, tp, sl, H):
    """Barrier sonucu: getiri (bps, komisyonsuz), kazandı mı, çıkış mumu (girişe göre)."""
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


def flat_only(sig, exit_bar):
    """Stratejideki gibi: açık işlem varken gelen sinyaller atlanır."""
    keep = np.zeros(len(sig), bool)
    free = -1
    for k, (s, x) in enumerate(zip(sig, exit_bar)):
        if s >= free:
            keep[k] = True
            free = x + 1  # çıkış mumunda yeni sinyal ancak sonraki mumda
    return keep


def row(label, net, win, coins_pos, n_coins, q):
    t = A.tstat(net)
    qs = " ".join(f"{q.get(k, (0, np.nan, np.nan))[1]:.0f}%/{q.get(k, (0, np.nan, np.nan))[2]:+.0f}" for k in QUARTERS)
    A.out(f"| {label} | {len(net)} | {win.mean() * 100:.1f} | {net.mean():+.1f} | {t:+.1f} | {coins_pos}/{n_coins} | {qs} |")


def main() -> None:
    data = {}
    for s in A.COINS:
        d = A.load(s)
        d["atrC"] = A.atr(d["h"], d["l"], d["c"], 14)
        d["atr10"] = A.atr(d["h"], d["l"], d["c"], 10)
        H1, i1 = A.htf(d, 3600)
        d["atr1h"] = A.atr(H1["h"], H1["l"], H1["c"], 14)[i1]
        D1, id1 = A.htf(d, 86400)
        d["ema1d"] = A.ema(D1["c"], 20)[id1]
        b, sl, tr = A.ut_bot(d["c"], d["atr10"], 1, with_trail=True)
        d["ut"] = b | sl
        # mumdan ÖNCEKİ UT durumu: kapanış izin üstünde +1, altında -1
        st = np.sign(d["c"] - tr)
        d["utPrev"] = np.concatenate([[0.0], st[:-1]])
        d["dev"] = (d["t"] >= A.FROM) & (d["t"] <= A.TO)
        data[s] = d
    H = A.H_MAX

    def study(title, k=3.0, tpk=1.0, slk=2.0, flt=None, seq=True, direction=0):
        nets, wins, pos, q = [], [], 0, {}
        qn: dict[str, list] = {}
        for s, d in data.items():
            body = d["c"] - d["o"]
            prev = np.concatenate([[np.nan], d["atrC"][:-1]])
            m = (np.abs(body) > k * prev) & d["dev"] & ~np.isnan(d["atr1h"])
            if flt is not None:
                m &= flt(d, np.sign(body))
            if direction:
                m &= np.sign(body) == direction
            sig = np.flatnonzero(m)
            sig = sig[sig + 1 + H < len(d["c"])]
            dirn = np.sign(body[sig])
            e = sig + 1
            a1 = d["atr1h"][sig]
            ret, win, off = outcome(d, e, dirn, tpk * a1, slk * a1, H)
            if seq:
                keep = flat_only(sig, e + off)
                ret, win, sig = ret[keep], win[keep], sig[keep]
            net = ret - A.FEE_BPS
            nets.append(net)
            wins.append(win)
            pos += net.mean() > 0 if len(net) else 0
            for qq, r, w in zip(quarter(d["t"][sig]), net, win):
                qn.setdefault(qq, []).append((r, w))
        for qq, v in qn.items():
            a = np.array(v)
            q[qq] = (len(a), a[:, 1].mean() * 100, a[:, 0].mean())
        row(title, np.concatenate(nets), np.concatenate(wins), pos, len(data), q)

    A.out(f"# Sert momentum mumu sonrası devam — {A.TF} grafik, geliştirme dönemi, 8 coin")
    A.out()
    A.out("Giriş: mum gövdesi > k × ATR14 (önceki mum) → sonraki açılışta mum yönünde. Çıkış: 1s ATR katı, 1 gün süre.")
    A.out("Aksi belirtilmedikçe aynı anda tek pozisyon (stratejideki gibi). Komisyon %0,05/taraf düşüldü.")
    A.out()
    hdr = "| durum | işlem | kazanma % | ort. bps | t | artı coin | çeyrekler (kazanma%/ort bps): " + " ".join(QUARTERS) + " |"
    for title, cases in [
        ("Eşik (TP/SL 1/2)", [(f"k = {k}", dict(k=k)) for k in (2.0, 2.5, 3.0, 3.5, 4.0)]),
        ("Çıkış geometrisi (k = 3)", [(f"TP/SL {t}/{s}", dict(tpk=t, slk=s)) for t, s in ((0.5, 1), (0.75, 1.5), (1, 1.5), (1, 2), (1, 2.5), (1.25, 2.5), (1.5, 3))]),
        ("Yön (k = 3, 1/2)", [("yalnız long", dict(direction=1)), ("yalnız short", dict(direction=-1))]),
        (
            "UT sinyali ve günlük trend (k = 3, 1/2)",
            [
                ("aynı mumda UT sinyali var", dict(flt=lambda d, s: d["ut"])),
                ("aynı mumda UT sinyali yok", dict(flt=lambda d, s: ~d["ut"])),
                ("günlük EMA20 yönünde", dict(flt=lambda d, s: np.sign(d["c"] - d["ema1d"]) == s)),
                ("günlük EMA20 tersine", dict(flt=lambda d, s: np.sign(d["c"] - d["ema1d"]) == -s)),
            ],
        ),
        ("Örtüşme (k = 3, 1/2)", [("tüm olaylar (örtüşmeli)", dict(seq=False))]),
        (
            "UT trendi yönünde (mumdan önceki UT durumu = mum yönü) — eşik ve çıkış komşulukları",
            [(f"k = {k}, TP/SL 1/2", dict(k=k, flt=lambda d, s: d["utPrev"] == s)) for k in (2.5, 3.0, 3.5)]
            + [(f"k = 3, TP/SL {t}/{sl_}", dict(tpk=t, slk=sl_, flt=lambda d, s: d["utPrev"] == s)) for t, sl_ in ((0.75, 1.5), (1, 1.5), (1, 2.5), (1.25, 2.5))]
            + [("k = 3, 1/2, UT trendi TERSİNE", dict(flt=lambda d, s: d["utPrev"] == -s))],
        ),
    ]:
        A.out(f"## {title}")
        A.out()
        A.out(hdr)
        A.out("|---|---|---|---|---|---|---|")
        for label, kw in cases:
            study(label, **kw)
        A.out()
    out = A.ROOT / ".cache" / "results" / f"candle_study_{A.TF}.md"
    out.write_text("\n".join(A.lines) + "\n")
    print(f"rapor: {out}")


if __name__ == "__main__":
    main()
