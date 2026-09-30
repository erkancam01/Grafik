"""Bot deposunun `market-data` dalındaki 1 dakikalık Binance mumlarını deneme düzeneğinin okuduğu biçime çevirir.

Kaynak: erkancam01/bot deposundaki .github/workflows/market-data.yml, data.binance.vision arşivinden 15 coinin
1m mumlarını ve funding geçmişini indirip `market-data` dalına Parquet olarak yazar (bu ortamdan Binance'e
doğrudan erişilemediği için veri GitHub sunucularında indirilir).

Kullanım:
    git -C ../bot fetch --depth 1 origin market-data
    git -C ../bot archive origin/market-data | tar -x -C .cache/market-data
    python tools/backtest/import_market_data.py          →  .cache/bars/

Çıktı (her coin için; ikili dosyalar küçük-endian Float64, sütunlar art arda: zaman(ms) açılış yüksek düşük
kapanış hacim):
    <SYM>_1m.f64, <SYM>_5m.f64   ve   <SYM>_funding.json  ([[zaman_ms, oran], ...])
5 dakikalık mumlar Binance'inkiyle aynı kuralla üretilir: ilk açılış, en yüksek, en düşük, son kapanış, toplam hacim.
pandas ve pyarrow gerekir.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / ".cache" / "market-data" / "binanceusdm"
OUT = ROOT / ".cache" / "bars"
COLS = ["open", "high", "low", "close", "volume"]


def write_bars(df: pd.DataFrame, path: Path) -> None:
    t = (df.index.asi8 // 1_000_000).astype("float64")  # ns → ms
    cols = [t] + [df[c].to_numpy(dtype="float64") for c in COLS]
    with path.open("wb") as f:
        for c in cols:
            f.write(c.astype("<f8").tobytes())


def main() -> int:
    if not SRC.exists():
        print(f"kaynak yok: {SRC} (önce market-data dalını .cache/market-data altına çıkar)", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for p in sorted((SRC / "ohlcv").glob("*_1m.parquet")):
        sym = p.name.split("_")[0]
        df = pd.read_parquet(p, columns=COLS).sort_index()
        df = df[~df.index.duplicated(keep="last")]
        step = df.index.to_series().diff().dropna()
        gaps = int((step > pd.Timedelta(minutes=1)).sum())
        write_bars(df, OUT / f"{sym}_1m.f64")
        m5 = df.resample("5min", label="left", closed="left").agg(
            {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
        )
        m5 = m5.dropna(subset=["open"])
        write_bars(m5, OUT / f"{sym}_5m.f64")
        fund = []
        fp = SRC / "funding" / f"{sym}.parquet"
        if fp.exists():
            fr = pd.read_parquet(fp, columns=["funding_rate"]).sort_index()
            fund = [[int(ts.value // 1_000_000), float(r)] for ts, r in fr["funding_rate"].items()]
        (OUT / f"{sym}_funding.json").write_text(json.dumps(fund))
        manifest[sym] = {
            "from": str(df.index[0]),
            "to": str(df.index[-1]),
            "bars1m": len(df),
            "bars5m": len(m5),
            "gaps1m": gaps,
            "funding": len(fund),
        }
        print(f"{sym}: {manifest[sym]}")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
