"""Bot deposunun `research-data` dalındaki 15 dakikalık Binance mumlarını (2020-01 → bugün) düzeneğin biçimine çevirir.

Kaynak: erkancam01/bot deposundaki .github/workflows/research-data.yml, data.binance.vision arşivinden 15 coinin
15m mumlarını ve funding geçmişini 2020-01-01'den başlayarak `research-data` dalına Parquet olarak yazar.

Kullanım:
    git -C ../bot fetch --depth 1 origin research-data:refs/remotes/origin/research-data
    git -C ../bot archive origin/research-data | tar -x -C .cache/research-data
    python tools/backtest/import_research_data.py        →  .cache/bars/<SYM>_15m.f64 (+ funding birleştirilir)

Denetimler (getiriye bakmadan): yineleme/boşluk sayısı; market-data dalıyla örtüşen dönemde (2024-09 → ) 15 dk
mumların 1 dk verisinden üretilenlerle aynı olduğu (arşivde coin başına 0-4 mum ayrışıyor, 72 binde); funding
oranlarının örtüşen zamanlarda aynı olduğu.
Funding: `<SYM>_funding.json` iki kaynağın birleşimi olarak yeniden yazılır (örtüşen kayıtlar aynıysa).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / ".cache" / "research-data" / "binanceusdm"
OUT = ROOT / ".cache" / "bars"
COLS = ["open", "high", "low", "close", "volume"]


def write_bars(df: pd.DataFrame, path: Path) -> None:
    t = df.index.as_unit("ms").asi8.astype("float64")  # dizinin çözünürlüğü ne olursa olsun ms
    cols = [t] + [df[c].to_numpy(dtype="float64") for c in COLS]
    with path.open("wb") as f:
        for c in cols:
            f.write(c.astype("<f8").tobytes())


def read_bars(path: Path) -> pd.DataFrame:
    a = np.fromfile(path, dtype="<f8")
    n = len(a) // 6
    a = a.reshape(6, n)
    idx = pd.to_datetime(a[0].astype("int64"), unit="ms", utc=True)
    return pd.DataFrame({c: a[i + 1] for i, c in enumerate(COLS)}, index=idx)


def main() -> int:
    if not SRC.exists():
        print(f"kaynak yok: {SRC} (önce research-data dalını .cache/research-data altına çıkar)", file=sys.stderr)
        return 1
    manifest_p = OUT / "manifest_15m.json"
    manifest = {}
    bad = 0
    for p in sorted((SRC / "ohlcv").glob("*_15m.parquet")):
        sym = p.name.split("_")[0]
        df = pd.read_parquet(p, columns=COLS).sort_index()
        dup = int(df.index.duplicated().sum())
        df = df[~df.index.duplicated(keep="last")]
        step = df.index.to_series().diff().dropna()
        gaps = int((step > pd.Timedelta(minutes=15)).sum())
        write_bars(df, OUT / f"{sym}_15m.f64")
        # örtüşme denetimi: 1 dk verisinden üretilen 15 dk mumlarla aynı mı
        diff = None
        m1p = OUT / f"{sym}_1m.f64"
        if m1p.exists():
            m1 = read_bars(m1p)
            m15 = m1.resample("15min", label="left", closed="left").agg(
                {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
            ).dropna(subset=["open"])
            j = df.join(m15, rsuffix="_m", how="inner")
            off = np.zeros(len(j), bool)
            for c in ("open", "high", "low", "close"):
                off |= np.abs(j[c].to_numpy() / j[c + "_m"].to_numpy() - 1) > 1e-9
            diff = {"bars": len(j), "differing": int(off.sum())}
            # Binance arşivinde 15m ve 1m dosyaları tek tük mumda ayrışabiliyor; %0,01'den fazlası hata sayılır
            if len(j) == 0 or off.sum() > len(j) * 1e-4:
                bad += 1
        # funding birleşimi
        fund_new = []
        fp = SRC / "funding" / f"{sym}.parquet"
        if fp.exists():
            fr = pd.read_parquet(fp, columns=["funding_rate"]).sort_index()
            fund_new = [[int(ts.value // 1_000_000), float(r)] for ts, r in fr["funding_rate"].items()]
        fj = OUT / f"{sym}_funding.json"
        old = json.loads(fj.read_text()) if fj.exists() else []
        merged = {t: r for t, r in fund_new}
        mism = 0
        for t, r in old:
            if t in merged and abs(merged[t] - r) > 1e-12:
                mism += 1
            merged[t] = r
        if mism:
            bad += 1
        fj.write_text(json.dumps([[t, merged[t]] for t in sorted(merged)]))
        manifest[sym] = {
            "from": str(df.index[0]),
            "to": str(df.index[-1]),
            "bars15m": len(df),
            "duplicates": dup,
            "gaps15m": gaps,
            "overlap_with_1m": diff,
            "funding": len(merged),
            "funding_mismatch": mism,
        }
        print(f"{sym}: {manifest[sym]}")
    manifest_p.write_text(json.dumps(manifest, indent=1))
    if bad:
        print(f"UYARI: {bad} coinde örtüşme/funding uyuşmazlığı", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
