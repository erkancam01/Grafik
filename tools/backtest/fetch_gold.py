"""Altın verisi: Binance'in herkese açık arşivinden (data.binance.vision) altın sözleşmelerinin 15 dk mumları ve fonlama
oranları. GitHub Actions'ta çalışır (.github/workflows/altin-verisi.yml): bu geliştirme ortamından Binance'e
erişilemiyor, veri GitHub sunucusunda indirilip tetikleyen dala data/altin/ altına yazılır.

Adaylar: vadeli (USDT-M) XAUUSDT, PAXGUSDT, XAUTUSDT ve spot PAXGUSDT; arşivde hangisi varsa indirilir.
Çıktı: data/altin/<piyasa>_<SYM>_15m.parquet (UTC zaman dizini; open high low close volume),
data/altin/<SYM>_funding.parquet (vadeli; funding_rate), data/altin/README.md (kapsam).
Kullanım (yerelde de çalışır): python tools/backtest/fetch_gold.py
"""

from __future__ import annotations

import datetime as dt
import io
import zipfile
from pathlib import Path

import pandas as pd
import requests

BASE = "https://data.binance.vision/data"
OUT = Path("data/altin")
CANDIDATES = [("futures/um", "XAUUSDT"), ("futures/um", "PAXGUSDT"), ("futures/um", "XAUTUSDT"), ("spot", "PAXGUSDT")]
START = dt.date(2019, 9, 1)
S = requests.Session()


def months(start: dt.date, end: dt.date):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def get_zip(url: str) -> bytes | None:
    r = S.get(url, timeout=120)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        return z.read(z.namelist()[0])


def parse_klines(raw: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), header=None, usecols=range(6))
    if not str(df.iloc[0, 0]).strip().isdigit():  # başlık satırı
        df = df.iloc[1:]
    df.columns = ["t", "open", "high", "low", "close", "volume"]
    df = df.astype(float)
    t = df["t"].where(df["t"] < 1e14, df["t"] // 1000)  # 2025'ten itibaren spot zaman damgaları mikrosaniye
    df.index = pd.to_datetime(t.astype("int64"), unit="ms", utc=True)
    return df[["open", "high", "low", "close", "volume"]]


def klines(market: str, sym: str) -> pd.DataFrame:
    today = dt.datetime.now(dt.timezone.utc).date()
    parts = []
    for y, m in months(START, today):
        raw = get_zip(f"{BASE}/{market}/monthly/klines/{sym}/15m/{sym}-15m-{y}-{m:02d}.zip")
        if raw is not None:
            parts.append(parse_klines(raw))
            continue
        # aylık arşiv henüz yoksa (son aylar) günlük dosyalar
        if (today.year - y) * 12 + today.month - m <= 1:
            d = dt.date(y, m, 1)
            while d.month == m and d < today:
                raw = get_zip(f"{BASE}/{market}/daily/klines/{sym}/15m/{sym}-15m-{d.isoformat()}.zip")
                if raw is not None:
                    parts.append(parse_klines(raw))
                d += dt.timedelta(days=1)
    if not parts:
        return pd.DataFrame()
    df = pd.concat(parts).sort_index()
    return df[~df.index.duplicated(keep="last")]


def funding(sym: str) -> pd.DataFrame:
    today = dt.datetime.now(dt.timezone.utc).date()
    parts = []
    for y, m in months(START, today):
        raw = get_zip(f"{BASE}/futures/um/monthly/fundingRate/{sym}/{sym}-fundingRate-{y}-{m:02d}.zip")
        if raw is None:
            continue
        df = pd.read_csv(io.BytesIO(raw))
        df.columns = [c.strip() for c in df.columns]
        df.index = pd.to_datetime(df["calc_time"].astype("int64"), unit="ms", utc=True)
        parts.append(df[["last_funding_rate"]].rename(columns={"last_funding_rate": "funding_rate"}).astype(float))
    if not parts:
        return pd.DataFrame()
    df = pd.concat(parts).sort_index()
    return df[~df.index.duplicated(keep="last")]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    lines = ["# Altın verisi", "", f"Kaynak: data.binance.vision (15 dk mumlar, fonlama). Üretim: {dt.datetime.now(dt.timezone.utc):%Y-%m-%dT%H:%MZ}.",
             "Üreten: .github/workflows/altin-verisi.yml (tools/backtest/fetch_gold.py).", "",
             "| piyasa | sembol | ilk | son | mum | boşluk (> 15 dk) | fonlama kaydı |", "|---|---|---|---|---|---|---|"]
    for market, sym in CANDIDATES:
        df = klines(market, sym)
        if df.empty:
            lines.append(f"| {market} | {sym} | — | — | 0 | — | — |")
            print(f"{market} {sym}: arşivde yok")
            continue
        tag = "vadeli" if market.startswith("futures") else "spot"
        df.to_parquet(OUT / f"{tag}_{sym}_15m.parquet", engine="pyarrow", compression="zstd")
        gaps = int((df.index.to_series().diff() > pd.Timedelta(minutes=15)).sum())
        nf = 0
        if market.startswith("futures"):
            fr = funding(sym)
            nf = len(fr)
            if nf:
                fr.to_parquet(OUT / f"{sym}_funding.parquet", engine="pyarrow", compression="zstd")
        lines.append(f"| {market} | {sym} | {df.index[0]:%Y-%m-%d %H:%M} | {df.index[-1]:%Y-%m-%d %H:%M} | {len(df)} | {gaps} | {nf} |")
        print(f"{market} {sym}: {len(df)} mum, {df.index[0]} → {df.index[-1]}, boşluk {gaps}, fonlama {nf}")
    (OUT / "README.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
