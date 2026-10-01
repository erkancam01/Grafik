"""Altın verisini (fetch_gold.py → data/altin/*.parquet) deneme düzeneğinin biçimine çevirir.

Çıktı (.cache/bars/): vadeli sözleşmeler <SYM>_15m.f64 ve <SYM>_funding.json; spot seriler SPOT-<SYM>_15m.f64 ve boş
fonlama dosyası. İkili biçim import_research_data.py ile aynı (küçük-endian Float64; zaman(ms) açılış yüksek düşük
kapanış hacim, sütunlar art arda). Kapsam ve boşluk sayısı yazdırılır (getiriye bakılmaz).
Kullanım: python tools/backtest/import_gold_data.py [kaynak dizin, varsayılan data/altin]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".cache" / "bars"
COLS = ["open", "high", "low", "close", "volume"]


def write_bars(df: pd.DataFrame, path: Path) -> None:
    t = (df.index.asi8 // 1_000_000).astype("float64")  # ns → ms
    with path.open("wb") as f:
        for c in [t] + [df[c].to_numpy(dtype="float64") for c in COLS]:
            f.write(c.astype("<f8").tobytes())


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "altin"
    files = sorted(src.glob("*_15m.parquet"))
    if not files:
        print(f"kaynak yok: {src}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    for p in files:
        market, sym = p.name.split("_")[:2]
        key = sym if market == "vadeli" else f"SPOT-{sym}"
        df = pd.read_parquet(p).sort_index()
        df = df[~df.index.duplicated(keep="last")]
        gaps = df.index.to_series().diff() > pd.Timedelta(minutes=15)
        write_bars(df, OUT / f"{key}_15m.f64")
        fund = []
        fp = src / f"{sym}_funding.parquet"
        if market == "vadeli" and fp.exists():
            fr = pd.read_parquet(fp).sort_index()
            fund = [[int(ts.value // 1_000_000), float(r)] for ts, r in fr["funding_rate"].items()]
        (OUT / f"{key}_funding.json").write_text(json.dumps(fund))
        big = df.index.to_series().diff()[gaps]
        print(f"{key}: {len(df)} mum, {df.index[0]} → {df.index[-1]}, boşluk {int(gaps.sum())}"
              f" (en uzun {big.max() if len(big) else '-'}), fonlama {len(fund)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
