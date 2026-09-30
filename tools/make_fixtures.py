"""Yerleşik göstergeler için bağımsız referans verisi üretir (Pine başvuru tanımları, düz Python döngüleri).

Kullanım: python tools/make_fixtures.py  →  tests/fixtures/reference.json
Yalnız numpy gerekir. TypeScript yorumlayıcısından bağımsızdır; testler iki uygulamayı karşılaştırır.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

NA = float("nan")
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "reference.json"


def isna(x: float) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def nz(x: float, r: float = 0.0) -> float:
    return r if isna(x) else x


def pmax(a: float, b: float) -> float:  # Pine math.max: na → na
    return NA if isna(a) or isna(b) else max(a, b)


def pmin(a: float, b: float) -> float:
    return NA if isna(a) or isna(b) else min(a, b)


# ---------------------------------------------------------------- veri
def make_bars(n: int, seed: int, tf_sec: int, start_ms: int) -> dict:
    rng = np.random.default_rng(seed)
    p = 100.0
    t, o, h, lo, c, v = [], [], [], [], [], []
    for i in range(n):
        drift = math.sin(i / 90) * 0.003
        op = p
        cl = op * (1 + drift + (rng.random() - 0.5) * 0.02)
        hi = max(op, cl) * (1 + rng.random() * 0.006)
        low = min(op, cl) * (1 - rng.random() * 0.006)
        t.append(start_ms + i * tf_sec * 1000)
        o.append(op)
        h.append(hi)
        lo.append(low)
        c.append(cl)
        v.append(1000 + rng.random() * 500)
        p = cl
    return {"time": t, "open": o, "high": h, "low": lo, "close": c, "volume": v, "tfSec": tf_sec}


def resample(b: dict, tf_sec: int) -> dict:
    out = {"time": [], "open": [], "high": [], "low": [], "close": [], "volume": [], "tfSec": tf_sec}
    for i, ts in enumerate(b["time"]):
        k = ts // (tf_sec * 1000) * tf_sec * 1000
        if out["time"] and out["time"][-1] == k:
            out["high"][-1] = max(out["high"][-1], b["high"][i])
            out["low"][-1] = min(out["low"][-1], b["low"][i])
            out["close"][-1] = b["close"][i]
            out["volume"][-1] += b["volume"][i]
        else:
            for f in ("open", "high", "low", "close", "volume"):
                out[f].append(b[f][i])
            out["time"].append(k)
    return out


# ---------------------------------------------------------------- Pine tanımları
def sma(x: list[float], n: int) -> list[float]:
    out = []
    for i in range(len(x)):
        if i < n - 1:
            out.append(NA)
            continue
        w = x[i - n + 1 : i + 1]
        out.append(NA if any(isna(v) for v in w) else sum(w) / n)
    return out


def exp_ma(x: list[float], n: int, alpha: float) -> list[float]:
    out = []
    prev = NA
    for i in range(len(x)):
        if isna(prev):
            if i < n - 1:
                v = NA
            else:
                w = x[i - n + 1 : i + 1]
                v = NA if any(isna(q) for q in w) else sum(w) / n
        else:
            v = alpha * x[i] + (1 - alpha) * prev
        out.append(v)
        prev = v
    return out


def ema(x, n):
    return exp_ma(x, n, 2 / (n + 1))


def rma(x, n):
    return exp_ma(x, n, 1 / n)


def wma(x, n):
    out = []
    for i in range(len(x)):
        if i < n - 1:
            out.append(NA)
            continue
        s = sum(x[i - k] * (n - k) for k in range(n))
        out.append(s / (n * (n + 1) / 2))
    return out


def tr(b, handle_na):
    out = []
    for i in range(len(b["close"])):
        h, lo = b["high"][i], b["low"][i]
        if i == 0:
            out.append(h - lo if handle_na else NA)
        else:
            pc = b["close"][i - 1]
            out.append(max(h - lo, abs(h - pc), abs(lo - pc)))
    return out


def atr(b, n):
    return rma(tr(b, True), n)


def rsi(x, n):
    u = [NA] + [max(x[i] - x[i - 1], 0) for i in range(1, len(x))]
    d = [NA] + [max(x[i - 1] - x[i], 0) for i in range(1, len(x))]
    ru, rd = rma(u, n), rma(d, n)
    out = []
    for a, b_ in zip(ru, rd):
        if isna(a) or isna(b_):
            out.append(NA)
        elif b_ == 0:
            out.append(100.0)
        elif a == 0:
            out.append(0.0)
        else:
            out.append(100 - 100 / (1 + a / b_))
    return out


def stdev(x, n):
    out = []
    for i in range(len(x)):
        if i < n - 1:
            out.append(NA)
            continue
        w = x[i - n + 1 : i + 1]
        m = sum(w) / n
        out.append(math.sqrt(sum((v - m) ** 2 for v in w) / n))
    return out


def highest(x, n):
    return [NA if i < n - 1 else max(x[i - n + 1 : i + 1]) for i in range(len(x))]


def lowest(x, n):
    return [NA if i < n - 1 else min(x[i - n + 1 : i + 1]) for i in range(len(x))]


def supertrend(b, factor, period):
    a = atr(b, period)
    src = [(h + lo) / 2 for h, lo in zip(b["high"], b["low"])]
    c = b["close"]
    st_out, dir_out = [], []
    ub_prev = lb_prev = st_prev = NA
    for i in range(len(c)):
        ub = src[i] + factor * a[i]
        lb = src[i] - factor * a[i]
        plb, pub = nz(lb_prev), nz(ub_prev)
        c1 = c[i - 1] if i > 0 else NA
        lb = lb if (lb > plb or (not isna(c1) and c1 < plb)) else plb
        ub = ub if (ub < pub or (not isna(c1) and c1 > pub)) else pub
        prev_atr = a[i - 1] if i > 0 else NA
        if isna(prev_atr):
            d = 1
        elif not isna(st_prev) and st_prev == pub:
            d = -1 if c[i] > ub else 1
        else:
            d = 1 if c[i] < lb else -1
        st = lb if d == -1 else ub
        st_out.append(st)
        dir_out.append(d)
        ub_prev, lb_prev, st_prev = ub, lb, st
    return st_out, dir_out


def ut_bot(b, a_key, c_len):
    """UT Bot Alerts (v4, Heikin Ashi kapalı) — Pine anlamıyla."""
    src = b["close"]
    x_atr = atr(b, c_len)
    trail, pos, buy, sell = [], [], [], []
    for i in range(len(src)):
        n_loss = a_key * x_atr[i]
        prev = nz(trail[i - 1] if i > 0 else NA, 0)
        s1 = src[i - 1] if i > 0 else NA
        if src[i] > prev and (not isna(s1) and s1 > prev):
            t = pmax(prev, src[i] - n_loss)
        elif src[i] < prev and (not isna(s1) and s1 < prev):
            t = pmin(prev, src[i] + n_loss)
        elif src[i] > prev:
            t = src[i] - n_loss
        else:
            t = src[i] + n_loss
        trail.append(t)
        tp = nz(trail[i - 1] if i > 0 else NA, 0)
        pp = nz(pos[i - 1] if i > 0 else NA, 0)
        if not isna(s1) and s1 < tp and src[i] > tp:
            p = 1
        elif not isna(s1) and s1 > tp and src[i] < tp:
            p = -1
        else:
            p = pp
        pos.append(p)
        t1 = trail[i - 1] if i > 0 else NA
        above = src[i] > t and (not isna(s1) and not isna(t1) and s1 <= t1)
        below = t > src[i] and (not isna(s1) and not isna(t1) and t1 <= s1)
        buy.append(bool(src[i] > t and above))
        sell.append(bool(src[i] < t and below))
    return trail, pos, buy, sell


def htf_prev_close_series(chart: dict, htf: dict, values: list[float]) -> list[float]:
    """request.security(…, expr[1], lookahead_on): grafik mumunu içeren üst mumdan bir önceki değer."""
    out = []
    j = -1
    for t in chart["time"]:
        while j + 1 < len(htf["time"]) and htf["time"][j + 1] <= t:
            j += 1
        out.append(values[j - 1] if j >= 1 else NA)
    return out


def clean(xs):
    return [None if isna(v) else (bool(v) if isinstance(v, bool) else round(float(v), 10)) for v in xs]


def main() -> None:
    start = 1735689600000  # 2025-01-01
    b = make_bars(1500, 7, 3600, start)
    c = b["close"]
    hlc3 = [(h + lo + cl) / 3 for h, lo, cl in zip(b["high"], b["low"], c)]
    macd_line = [f - s for f, s in zip(ema(c, 12), ema(c, 26))]
    macd_sig = ema(macd_line, 9)
    basis = sma(c, 20)
    sd = stdev(c, 20)
    hh, ll = highest(b["high"], 14), lowest(b["low"], 14)
    stoch = [NA if isna(x) or isna(y) or x == y else 100 * (cl - y) / (x - y) for cl, x, y in zip(c, hh, ll)]
    st, sdir = supertrend(b, 3.0, 10)
    trail, pos, buy, sell = ut_bot(b, 1.0, 10)
    h4 = resample(b, 14400)
    fast4 = htf_prev_close_series(b, h4, ema(h4["close"], 20))
    slow4 = htf_prev_close_series(b, h4, ema(h4["close"], 100))
    ref = {
        "sma14": sma(c, 14),
        "ema20": ema(c, 20),
        "rma14": rma(c, 14),
        "wma10": wma(c, 10),
        "atr14": atr(b, 14),
        "rsi14": rsi(c, 14),
        "macd": macd_line,
        "macd_signal": macd_sig,
        "bb_upper": [NA if isna(m) else m + 2 * s for m, s in zip(basis, sd)],
        "stdev20": sd,
        "stoch14": stoch,
        "highest20": highest(c, 20),
        "hma9": wma([2 * x - y for x, y in zip(wma(c, 4), wma(c, 9))], 3),
        "vwma20": [NA if isna(p) or isna(q) else p / q for p, q in zip(sma([x * v for x, v in zip(c, b["volume"])], 20), sma(b["volume"], 20))],
        "hlc3_rsi": rsi(hlc3, 14),
        "supertrend": st,
        "supertrend_dir": sdir,
        "ut_trail": trail,
        "ut_pos": pos,
        "ut_buy": buy,
        "ut_sell": sell,
        "ema_fast_4h": fast4,
        "ema_slow_4h": slow4,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps({"bars": b, "ref": {k: clean(v) for k, v in ref.items()}}, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"yazıldı: {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
