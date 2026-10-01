"""Rejim çalışması — ileriye doğru yürüyen test (protocol.ts R_STUDY).

Fikir (kullanıcı): "Şu an hangi trendde olduğunu bulup ona göre strateji." Her test yılının (2021 … 2026) başında yalnız
o güne kadar KAPANMIŞ işlemlere bakılarak her rejim için bir kural seçilir; o yıl coin hangi rejimdeyse o rejimin
kuralıyla işlem yapılır. Böylece 2021-2026 canlı işlem yapılmış gibi değerlendirilir (seçimde gelecek bilgisi yok).

Veri: research-data, 15 dk taban, 15 coin, 2020-01 → 2026-09.
Rejim (sinyal anında son kapanmış günlük mumdan; TradingView ta.dmi(14, 14) ve ta.ema(close, 50) ile aynı hesap):
  yükseliş: kapanış > EMA50 ve +DI > −DI ve ADX > 20;  düşüş: kapanış < EMA50 ve −DI > +DI ve ADX > 20;
  yatay: diğerleri. Göstergeler hazır değilse işlem yok.
Modeller: "coin" (coinin kendi rejimi; ANA), "btc" (BTC'nin rejimi), "yok" (rejimsiz: her yıl tek kural).
Kural evreni: 1 s / 4 s / 1 g × long_study.py'nin 18 olayı × devam/ters × 7 kâr al/zarar kes × yön (her ikisi / yalnız
long / yalnız short) = 2268 kural. Kâr al/zarar kes grafiğin ATR14 katı; en uzun tutma 3 / 7 / 20 gün; giriş sonraki
mumun açılışında; aynı mumda iki seviye → zarar; komisyon %0,05 × 2; kazanma = kâr al'a ulaşan işlem.
Seçim (her test yılı Y, her rejim r): eğitim = çıkışı Y'den önceki yıllarda olan işlemler (2020'den büyüyen pencere),
sinyali r rejiminde. Aday: ≥ 60 işlem, kazanma ≥ %72, ort. > 0. Puan = ortalamanın %95 alt sınırı (ort − 1,96·ss/√n,
bps); en yüksek puanlı kural, puan > 0 ise seçilir; yoksa o yıl o rejimde işlem yapılmaz.
İşlem (Y yılı): coin başına tek pozisyon (kurallar arasında da); seçilen kuralın sinyali, sinyal anındaki rejim kuralın
rejimiyse ve sinyal Y yılındaysa alınır.
Kabul (ana model, 2021-01 → 2026-09 toplamı): kazanma ≥ %70, ort. > 0, PF > 1; 6 test yılının ≥ 4'ünde ort. > 0;
≥ 10/15 coinde PF > 1. Denetim: aynı yöntem yalnız rastgele girişli kurallarla (10 tohum) — sıfır civarı beklenir.
Kullanım: python tools/backtest/regime_study.py  →  .cache/results/regime_study.md (+ regime_study.json)
"""

from __future__ import annotations

import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.argv = [sys.argv[0], "--tf", "15m"]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as A  # noqa: E402
import long_study as L  # noqa: E402

COINS = L.COINS
TFS = {"1h": 3600, "4h": 14400, "1d": 86400}
HOLD_DAYS = {"1h": 3, "4h": 7, "1d": 20}
GEOM = L.GEOM
DIRMODES = ("her ikisi", "yalnız long", "yalnız short")
REGIMES = ("yükseliş", "düşüş", "yatay")
MODELS = ("coin", "btc", "yok")
Y0 = 2020
NY = 7  # 2020 … 2026
TEST_YEARS = list(range(2021, 2027))
SEL = {"minTrades": 60, "winRate": 72.0}
ACCEPT = {"winRate": 70.0, "yearsPositive": 4, "pfCoins": 10}
FEE = L.FEE
DAY = 86_400_000


# ---------------------------------------------------------------- veri ve rejim
def load_all(sym: str) -> dict:
    a = np.fromfile(L.BARS / f"{sym}_15m.f64", dtype="<f8").reshape(6, -1)
    return {k: a[i] for i, k in enumerate(["t", "o", "h", "l", "c", "v"])}


def dmi(h, l, c, n=14):
    """Pine ta.dmi(n, n): +DI, −DI, ADX (Wilder, rma)."""
    up = np.diff(h, prepend=np.nan)
    dn = -np.diff(l, prepend=np.nan)
    pdm = np.where(np.isnan(up), np.nan, np.where((up > dn) & (up > 0), up, 0.0))
    mdm = np.where(np.isnan(dn), np.nan, np.where((dn > up) & (dn > 0), dn, 0.0))
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.where(np.isnan(pc), h - l, np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc))))
    atr = A.rma(tr, n)
    pdi = 100 * A.rma(pdm, n) / atr
    mdi = 100 * A.rma(mdm, n) / atr
    s = pdi + mdi
    dx = 100 * np.abs(pdi - mdi) / np.where(s == 0, 1, s)
    return pdi, mdi, A.rma(dx, n)


def daily_codes(D: dict) -> np.ndarray:
    """Günlük mum başına rejim: 0 yükseliş, 1 düşüş, 2 yatay, −1 hazır değil."""
    ema50 = A.ema(D["c"], 50)
    pdi, mdi, adx = dmi(D["h"], D["l"], D["c"], 14)
    ok = ~np.isnan(ema50) & ~np.isnan(adx) & ~np.isnan(pdi) & ~np.isnan(mdi)
    code = np.full(len(D["c"]), -1, np.int8)
    code[ok] = 2
    code[ok & (D["c"] > ema50) & (pdi > mdi) & (adx > 20)] = 0
    code[ok & (D["c"] < ema50) & (mdi > pdi) & (adx > 20)] = 1
    return code


def map_daily(t_close: np.ndarray, d_open: np.ndarray, code: np.ndarray) -> np.ndarray:
    """Her an için son KAPANMIŞ günlük mumun rejimi (ileriye bakma yok)."""
    i = np.searchsorted(d_open, t_close - DAY, side="right") - 1
    return np.where(i >= 0, code[np.maximum(i, 0)], -1).astype(np.int8)


def btc_daily() -> tuple[np.ndarray, np.ndarray]:
    D, _ = A.htf(load_all("BTCUSDT"), 86400, 900)
    return D["t"], daily_codes(D)


def year_of(ms: np.ndarray) -> np.ndarray:
    return ms.astype("datetime64[ms]").astype("datetime64[Y]").astype(int) + 1970


def random_events(d: dict) -> dict:
    n = len(d["c"])
    ev = {}
    for s in range(101, 111):
        rng = np.random.default_rng(s)
        ev[f"rastgele tohum {s}"] = (rng.random(n) < 0.05, np.where(rng.random(n) < 0.5, 1.0, -1.0))
    return ev


def coin_tf(sym: str, tf: str, btc: tuple, universe: str):
    base = load_all(sym)
    d = L.prep(base, tf, int(base["t"][-1]) + 900_000 - 1)
    sec = TFS[tf]
    tc = d["t"] + sec * 1000  # mum kapanış anı
    D, _ = A.htf(d, 86400, sec)
    rc = map_daily(tc, D["t"], daily_codes(D))
    rb = map_daily(tc, btc[0], btc[1])
    ev = L.events(d) if universe == "ana" else random_events(d)
    return d, ev, rc, rb, tc


def signals(d, m, dirn0, sgn, H):
    dirn = sgn * dirn0
    ok = m & ~np.isnan(d["atrG"]) & ~np.isnan(dirn) & (dirn != 0)
    sig = np.flatnonzero(ok)
    sig = sig[sig + 1 + H <= len(d["c"])]
    return sig, dirn


def dm_mask(dr: np.ndarray, dm: str) -> np.ndarray:
    return np.ones(len(dr), bool) if dm == "her ikisi" else (dr > 0 if dm == "yalnız long" else dr < 0)


# ---------------------------------------------------------------- 1) tarama: kural × model × rejim × çıkış yılı
def scan(job: tuple[str, str]) -> dict:
    tf, universe = job
    btc = btc_daily()
    sec = TFS[tf]
    H = HOLD_DAYS[tf] * 86400 // sec
    agg: dict = {}
    for sym in COINS:
        d, ev, rc, rb, tc = coin_tf(sym, tf, btc, universe)
        for name, (m, dirn0) in ev.items():
            for side, sgn in (("devam", 1.0), ("ters", -1.0)):
                sig, dirn = signals(d, m, dirn0, sgn, H)
                if not len(sig):
                    continue
                e = sig + 1
                a = d["atrG"][sig]
                dr = dirn[sig]
                for g in GEOM:
                    ret, win, off = L.outcome(d, e, dr, g[0] * a, g[1] * a, H)
                    xb = e + off
                    xyear = year_of(tc[xb]) - Y0
                    net = ret - FEE
                    for dm in DIRMODES:
                        idx = np.flatnonzero(dm_mask(dr, dm))
                        if not len(idx):
                            continue
                        ii = idx[L.flat_only(sig[idx], xb[idx])]
                        acc = agg.setdefault((tf, name, side, g[0], g[1], dm), np.zeros((3, 3, NY, 4)))
                        c_coin = rc[sig[ii]]
                        for mi, codes in enumerate((c_coin, rb[sig[ii]], np.where(c_coin >= 0, 0, -1))):
                            k = codes >= 0
                            flat = codes[k].astype(np.int64) * NY + xyear[ii][k]
                            v = net[ii][k]
                            acc[mi, :, :, 0] += np.bincount(flat, minlength=3 * NY).reshape(3, NY)
                            acc[mi, :, :, 1] += np.bincount(flat, weights=v, minlength=3 * NY).reshape(3, NY)
                            acc[mi, :, :, 2] += np.bincount(flat, weights=v * v, minlength=3 * NY).reshape(3, NY)
                            acc[mi, :, :, 3] += np.bincount(flat, weights=win[ii][k].astype(float), minlength=3 * NY).reshape(3, NY)
    return agg


# ---------------------------------------------------------------- 2) ileriye yürüyen seçim
def train_stats(acc: np.ndarray, mi: int, slot: int, y: int):
    s = acc[mi, slot, : y - Y0, :].sum(0)
    n, sm, sq, w = s
    if n < 2:
        return None
    mean = sm / n
    var = max(0.0, (sq - sm * sm / n) / (n - 1))
    return {"n": int(n), "win": w / n * 100, "mean": mean, "score": mean - 1.96 * math.sqrt(var / n)}


def select(agg: dict, years: list[int] | None = None) -> dict:
    """{(model, yıl, rejim): (kural, eğitim istatistiği)}"""
    out = {}
    for mi, model in enumerate(MODELS):
        for y in years or TEST_YEARS:
            for slot in range(1 if model == "yok" else 3):
                best = None
                for key, acc in agg.items():
                    st = train_stats(acc, mi, slot, y)
                    if not st or st["n"] < SEL["minTrades"] or st["win"] < SEL["winRate"] or st["mean"] <= 0 or st["score"] <= 0:
                        continue
                    if best is None or st["score"] > best[1]["score"]:
                        best = (key, st)
                if best:
                    out[(model, y, slot)] = best
    return out


# ---------------------------------------------------------------- 3) seçilen kurallarla örneklem dışı işlemler
def candidates(job: tuple[str, str, list]) -> list:
    """Bir zaman dilimindeki seçilmiş kurallar için coin başına aday işlemler (sinyal anı, çıkış anı, net, kazanma)."""
    tf, universe, needs = job
    btc = btc_daily()
    sec = TFS[tf]
    H = HOLD_DAYS[tf] * 86400 // sec
    res = []
    for sym in COINS:
        d, ev, rc, rb, tc = coin_tf(sym, tf, btc, universe)
        for (model, y, slot, key) in needs:
            _, name, side, tp, sl, dm = key
            m, dirn0 = ev[name]
            sig, dirn = signals(d, m, dirn0, 1.0 if side == "devam" else -1.0, H)
            if not len(sig):
                continue
            dr = dirn[sig]
            codes = {"coin": rc[sig], "btc": rb[sig], "yok": np.where(rc[sig] >= 0, 0, -1)}[model]
            keep = dm_mask(dr, dm) & (codes == slot) & (year_of(tc[sig]) == y)
            sig, dr = sig[keep], dr[keep]
            if not len(sig):
                continue
            e = sig + 1
            a = d["atrG"][sig]
            ret, win, off = L.outcome(d, e, dr, tp * a, sl * a, H)
            res.append((model, y, sym, tc[sig], tc[e + off], ret - FEE, win, dr, slot, key))
    return res


def system_trades(cands: list) -> dict:
    """Coin başına tek pozisyon (kurallar ve yıllar arasında da): sinyal anına göre sırala, açık işlem varken gelenleri
    atla. İşlem, sinyalinin yılına yazılır."""
    by: dict = {}
    for model, y, sym, ts, tx, net, win, dr, slot, key in cands:
        n = len(ts)
        by.setdefault((model, sym), []).append((np.full(n, y), ts, tx, net, win, dr, np.full(n, slot), np.full(n, rule_txt(key), dtype=object)))
    out: dict = {}
    for (model, sym), parts in by.items():
        yy, ts, tx, net, win, dr, sl, rk = (np.concatenate([p[k] for p in parts]) for k in range(8))
        free = -np.inf
        for k in np.argsort(ts, kind="stable"):
            if ts[k] > free:
                out.setdefault(model, []).append({"y": int(yy[k]), "sym": sym, "ts": float(ts[k]), "tx": float(tx[k]),
                                                  "net": float(net[k]), "win": bool(win[k]), "dir": int(dr[k]),
                                                  "slot": int(sl[k]), "rule": str(rk[k])})
                free = tx[k]
    return out


# ---------------------------------------------------------------- rapor
FUND: dict = {}


def funding_bps(t: dict) -> float:
    """İşlemin fonlama maliyeti (bps; artı = ödeme): giriş ile çıkış mumu kapanışı arasındaki 8 saatlik oranlar."""
    if t["sym"] not in FUND:
        a = np.array(json.loads((L.BARS / f"{t['sym']}_funding.json").read_text()), dtype=float).reshape(-1, 2)
        FUND[t["sym"]] = (a[:, 0], np.concatenate([[0.0], np.cumsum(a[:, 1])]))
    ft, cs = FUND[t["sym"]]
    return t["dir"] * (cs[np.searchsorted(ft, t["tx"], side="right")] - cs[np.searchsorted(ft, t["ts"], side="right")]) * 1e4


def st(tr: list) -> dict:
    if not tr:
        return {"n": 0, "win": math.nan, "avg": math.nan, "pf": math.nan, "t": math.nan}
    x = np.array([t["net"] for t in tr])
    g, b = x[x > 0].sum(), -x[x < 0].sum()
    return {"n": len(x), "win": float(np.mean([t["win"] for t in tr]) * 100), "avg": float(x.mean()),
            "pf": float(g / b) if b > 0 else math.inf, "t": float(A.tstat(x)) if len(x) > 2 else math.nan}


def equity(tr: list) -> tuple[float, float]:
    """Coin başına bileşik özsermaye (her işlemde %100): son çarpan, en büyük düşüş."""
    eq, peak, dd = 1.0, 1.0, 0.0
    for t in sorted(tr, key=lambda t: t["tx"]):
        eq *= 1 + t["net"] / 1e4
        peak = max(peak, eq)
        dd = max(dd, 1 - eq / peak)
    return eq, dd


def rule_txt(key) -> str:
    tf, name, side, tp, sl, dm = key
    return f"{tf} · {name} · {side} · TP/SL {tp}/{sl} · {dm}"


def report(title: str, sel: dict, trades: dict, lines: list, primary: bool) -> dict:
    verdicts = {}
    for model in MODELS:
        tr = trades.get(model, [])
        lines += [f"### {title} — model: {model}", ""]
        lines += ["| yıl | rejim | seçilen kural (yalnız önceki yıllara bakarak) | eğitim: işlem / kazanma % / ort. bps |", "|---|---|---|---|"]
        for y in TEST_YEARS:
            for slot in range(1 if model == "yok" else 3):
                s = sel.get((model, y, slot))
                reg = "hepsi" if model == "yok" else REGIMES[slot]
                if s:
                    lines.append(f"| {y} | {reg} | {rule_txt(s[0])} | {s[1]['n']} / {s[1]['win']:.1f} / {s[1]['mean']:+.1f} |")
                else:
                    lines.append(f"| {y} | {reg} | — (işlem yok) | |")
        lines += ["", "| yıl (örneklem dışı) | işlem | kazanma % | ort. bps | PF |", "|---|---|---|---|---|"]
        pos_years = 0
        for y in TEST_YEARS:
            s = st([t for t in tr if t["y"] == y])
            pos_years += s["n"] > 0 and s["avg"] > 0
            lines.append(f"| {y} | {s['n']} | {s['win']:.1f} | {s['avg']:+.1f} | {s['pf']:.2f} |")
        tot = st(tr)
        lines.append(f"| **2021-2026** | {tot['n']} | **{tot['win']:.1f}** | **{tot['avg']:+.1f}** (t {tot['t']:+.1f}) | {tot['pf']:.2f} |")
        if tr:
            fb = st([{**t, "net": t["net"] - funding_bps(t)} for t in tr])
            lines.append(f"| fonlama dahil | {fb['n']} | {fb['win']:.1f} | {fb['avg']:+.1f} (t {fb['t']:+.1f}) | {fb['pf']:.2f} |")
        if model != "yok":
            lines += ["", "| rejim (örneklem dışı) | işlem | kazanma % | ort. bps | PF |", "|---|---|---|---|---|"]
            for slot in range(3):
                r = st([t for t in tr if t["slot"] == slot])
                lines.append(f"| {REGIMES[slot]} | {r['n']} | {r['win']:.1f} | {r['avg']:+.1f} | {r['pf']:.2f} |")
        coins = {c: st([t for t in tr if t["sym"] == c]) for c in COINS}
        pf_coins = sum(1 for s in coins.values() if s["n"] and s["pf"] > 1)
        eqs = [equity([t for t in tr if t["sym"] == c]) for c in COINS if coins[c]["n"]]
        lines += ["", "Coinler (işlem / kazanma % / ort. bps): " + ", ".join(
            f"{c.replace('USDT', '')} {s['n']}/{s['win']:.0f}/{s['avg']:+.0f}" for c, s in coins.items() if s["n"]), ""]
        if eqs:
            med = lambda xs: sorted(xs)[len(xs) // 2]  # noqa: E731
            lines.append(f"Bileşik özsermaye (her işlemde %100, coin başına): son değer medyanı ×{med([e for e, _ in eqs]):.2f}, "
                         f"en büyük düşüş medyanı %{med([dd for _, dd in eqs]) * 100:.0f}, en kötü %{max(dd for _, dd in eqs) * 100:.0f}.")
        ok = [
            (f"kazanma ≥ %{ACCEPT['winRate']:.0f} ({tot['win']:.1f})", tot["n"] > 0 and tot["win"] >= ACCEPT["winRate"]),
            (f"ort. > 0 ({tot['avg']:+.1f} bps)", tot["n"] > 0 and tot["avg"] > 0),
            (f"PF > 1 ({tot['pf']:.2f})", tot["n"] > 0 and tot["pf"] > 1),
            (f"artı yıl ≥ {ACCEPT['yearsPositive']}/6 ({pos_years})", pos_years >= ACCEPT["yearsPositive"]),
            (f"PF > 1 coin ≥ {ACCEPT['pfCoins']}/15 ({pf_coins})", pf_coins >= ACCEPT["pfCoins"]),
        ]
        lines += ["", ("**Kabul (ana model):**" if primary and model == "coin" else "Kabul ölçütleri (bilgi):")]
        lines += [f"- {'✅' if v else '❌'} {t}" for t, v in ok]
        lines.append("")
        verdicts[model] = {"total": tot, "posYears": pos_years, "pfCoins": pf_coins, "pass": all(v for _, v in ok)}
    return verdicts


def run_universe(universe: str, pool: ProcessPoolExecutor) -> tuple[dict, dict, dict]:
    agg: dict = {}
    for part in pool.map(scan, [(tf, universe) for tf in TFS]):
        agg.update(part)
    sel = select(agg)
    needs: dict = {}
    for (model, y, slot), (key, _) in sel.items():
        needs.setdefault(key[0], []).append((model, y, slot, key))
    cands = [c for part in pool.map(candidates, [(tf, universe, nd) for tf, nd in needs.items()]) for c in part]
    return sel, system_trades(cands), agg


def main() -> None:
    lines = ["# Rejim çalışması — ileriye doğru yürüyen test (2021-01 → 2026-09, 15 coin)", "",
             "Her yılın başında yalnız o güne kadar kapanmış işlemlere bakılarak her rejim için kural seçilir; o yıl coin "
             "hangi rejimdeyse o kuralla işlem yapılır. Ort. bps komisyon sonrası. Ana model: coinin kendi rejimi.", ""]
    with ProcessPoolExecutor(max_workers=3) as pool:
        sel, trades, agg = run_universe("ana", pool)
        verdicts = report("Kural evreni (2268 kural)", sel, trades, lines, True)
        cur = select(agg, [TEST_YEARS[-1] + 1])
        lines += ["## Güncel seçim (eğitim: 2026-09 sonuna kadar kapanan bütün işlemler)", "",
                  "Ana modelin seçimi Rejim Strateji'nin (src/pine/library/rejim_strategy.pine) varsayılanlarıdır.", "",
                  "| model | rejim | kural | eğitim: işlem / kazanma % / ort. bps |", "|---|---|---|---|"]
        for (model, _, slot), (key, tst) in sorted(cur.items()):
            reg = "hepsi" if model == "yok" else REGIMES[slot]
            lines.append(f"| {model} | {reg} | {rule_txt(key)} | {tst['n']} / {tst['win']:.1f} / {tst['mean']:+.1f} |")
        lines.append("")
        sel_r, trades_r, _ = run_universe("rastgele", pool)
        lines += ["## Denetim: aynı yöntem yalnız rastgele girişlerle (10 tohum × 2 × 7 × 3 × 3 = 1260 kural)", ""]
        verdicts_r = report("Rastgele kurallar", sel_r, trades_r, lines, False)
    main_ok = verdicts["coin"]["pass"]
    lines += ["## Sonuç", "", f"Ana model (coin rejimi): **{'GEÇTİ' if main_ok else 'GEÇMEDİ'}**.", ""]
    L.OUT.mkdir(parents=True, exist_ok=True)
    (L.OUT / "regime_study.md").write_text("\n".join(lines) + "\n")
    (L.OUT / "regime_study.json").write_text(json.dumps({
        "selection": {f"{m}|{y}|{s}": [list(k), v] for (m, y, s), (k, v) in sel.items()},
        "verdicts": verdicts, "verdicts_random": verdicts_r, "trades": trades}, ensure_ascii=False, default=float))
    print("\n".join(lines))
    print(f"rapor: {L.OUT / 'regime_study.md'}")


if __name__ == "__main__":
    main()
