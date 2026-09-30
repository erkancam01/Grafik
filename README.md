# Grafik — TradingView benzeri grafik + Pine Script indikatörleri

Tarayıcıda çalışan, kurulum gerektirmeyen bir grafik ekranı. Binance mumlarını gösterir ve **Pine Script** ile
yazılmış indikatörleri çalıştırır: TradingView'daki bir göstergenin kaynak kodunu kopyalayıp buraya yapıştırman
yeterli (ör. **UT Bot Alerts**). Çizim araçları yoktur; odak grafik ve kodla indikatördür.

| Telefon | Masaüstü |
|---|---|
| <img src="docs/telefon.png" width="260"> | <img src="docs/masaustu.png" width="520"> |

## Kullanım

- **Sembol:** sol üstteki `BTC/USDT` düğmesi → ara ya da favorilerden seç (yıldızla favori ekle).
- **Zaman dilimi:** üst çubuk (1m … 1W).
- **İndikatör ekle:** `ƒx İndikatörler` → **Kütüphane** (tek dokunuş) ya da **Kod yaz** (Pine kodunu yapıştır →
  *Kaydet ve grafiğe ekle*). Hatalı kodda satır numarası gösterilir.
- **İndikatör satırı** (grafiğin sol üstü): göz = gizle/göster, dişli = ayarlar (koddaki `input` tanımlarından
  otomatik form), kalem = kodu düzenle, çarpı = kaldır.
- Kodların ve eklediğin indikatörler **bu tarayıcıda** saklanır. Başka cihaza taşımak için *Kodlarım → dışa aktar*
  (`.pine` dosyası) ve diğer cihazda *Dosyadan*.
- Telefonda tarayıcı menüsünden **Ana ekrana ekle** dersen uygulama gibi açılır.
- Grafiği sola kaydırdıkça eski mumlar yüklenir (en çok 5000 mum). Son mum canlı güncellenir.

## Veri

Binance USDT-M vadeli piyasasının herkese açık uçları (anahtar gerekmez). Vadeli uçlara ulaşılamazsa otomatik olarak
spot verisine geçer. `?demo` ile çevrimdışı demo verisi açılır (bağlantısız deneme).

## Pine Script desteği

v4, v5 ve v6 betiklerinin göstergelerde kullanılan kısmı:

- **Dil:** değişkenler, `var`/`varip`, `:=` ve `+=`…, geçmiş (`close[1]`, `x[2]`), `if`/`else if` (deyim ve
  ifade), `switch`, `for … to … by`, `for … in`, `while`, `break`/`continue`, kullanıcı fonksiyonları (tek satır
  ve blok, varsayılan parametre), demetler `[a, b] = f()`, diziler (`array.*` ve `arr.push()` yazımı), satır devamı.
- **ta.\*:** sma, ema, rma, wma, vwma, hma, swma, alma, atr, tr, rsi, macd, stoch, cci, mfi, bb, bbw, kc, kcw,
  dmi, supertrend, sar, wpr, tsi, cmo, highest, lowest, highestbars, lowestbars, crossover, crossunder, cross,
  change, mom, roc, stdev, variance, dev, median, percentrank, linreg, correlation, cum, vwap, valuewhen,
  barssince, pivothigh, pivotlow, rising, falling, range; `ta.obv`, `ta.accdist`.
- **Diğer:** `math.*`, `str.*`, `color.*`, `nz`, `na`, `fixnan`, zaman fonksiyonları (`time`, `year`, `hour`…),
  `timeframe.*`, `syminfo.*`, `barstate.*`, tüm `input.*` türleri.
- **Çizim:** `plot` (line, linebr, stepline, histogram, columns, area, circles, cross; mum başına renk, offset),
  `plotshape`, `plotchar`, `plotarrow`, `barcolor`, `bgcolor`, `hline`, `alertcondition`/`alert` (kaydedilir),
  `indicator(overlay=…)` ile fiyat paneli ya da alt panel.
- **request.security:** başka zaman dilimi veya başka sembol (`"BINANCE:ETHUSDT.P"`, `"ETHUSDT"`), `lookahead` ve
  `gaps` TradingView'daki anlamıyla, Heikin Ashi (`ticker.heikinashi`); gereken veri otomatik indirilir.
- **v4 uyumu:** `study`, `security`, `iff`, önek olmadan `sma`/`atr`/`crossover`…, `input(type=…)`, `transp`.

**Henüz yok:** `label`/`line`/`box`/`table` çizim nesneleri (hata vermez, yok sayılır ve uyarı gösterilir),
`fill` (iki çizgi arası dolgu), `strategy` betikleri, `type`/`method`/`import`, `matrix`/`map`.

Doğruluk: yerleşik göstergeler bağımsız bir Python referansıyla birebir aynı çıktıyı verir
(`tools/make_fixtures.py`, `tests/pine.ref.test.ts`); UT Bot Alerts'in v4 ve v5 yazımları dahil.

## Geliştirme

```bash
npm ci
npm run dev          # http://localhost:5173  (demo: /?demo)
npm test             # yorumlayıcı + veri testleri (vitest)
npm run e2e          # tarayıcı testleri (Playwright)
npm run build        # dist/ (statik site)
```

Yapı: `src/pine/` (lexer → parser → derleyici → yürütme, `builtins/`, `library/`), `src/data/` (Binance, demo),
`src/indicators/` (hesap akışı), `src/worker/` (yorumlayıcı ayrı iş parçacığında), `src/chart/` (lightweight-charts),
`src/ui/`.

Yayın: `render.yaml` (Render statik site). Grafik kütüphanesi: TradingView
[lightweight-charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0; grafikteki TradingView
logosu lisans gereğidir).
