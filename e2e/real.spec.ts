/**
 * Gerçek Binance verisiyle (önbellek: .cache/bars, bkz. tools/backtest) Trend Avcısı Strateji'yi uygulamada çalıştırır:
 * Binance uçları önbellekteki mumlarla yanıtlanır, saat verinin sonuna sabitlenir, tarih kutuları İstanbul saatiyle.
 * Uygulamanın gösterdiği işlem ve kazanan sayısı, deneme düzeneğinin "uygulama gibi yükle" hesabıyla aynı olmalı.
 * Yalnız BT_REAL=1 ile çalışır (CI'da atlanır). Ekran görüntüleri: e2e/screenshots/gercek-*.png
 */
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { resample } from "../src/data/source";
import type { BarsData } from "../src/pine/types";
import { BARS_DIR, loadBars, lowerBound, ROOT, Runner } from "../tools/backtest/lib";
import { dayEnd, dayStart } from "../tools/backtest/protocol";

const REAL = process.env.BT_REAL === "1" && existsSync(`${BARS_DIR}/BTCUSDT_5m.f64`);
test.skip(!REAL, "gerçek veri testi: BT_REAL=1 ve .cache/bars gerekli");
test.use({ timezoneId: "Europe/Istanbul" });
test.setTimeout(180_000);

const NOW = Date.parse("2026-09-30T00:00:00Z");
const SEC: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const COINS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT"];
const cache = new Map<string, BarsData>();

function barsFor(symbol: string, interval: string): BarsData {
  const key = `${symbol}|${interval}`;
  let b = cache.get(key);
  if (!b) {
    const m5 = loadBars(symbol, "5m");
    cache.set(key, (b = SEC[interval] === 300 ? m5 : resample(m5, SEC[interval]!)));
  }
  return b;
}

async function mockReal(page: Page) {
  await page.route("https://fapi.binance.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/ticker/24hr")) {
      return route.fulfill({ json: COINS.map((s, i) => ({ symbol: s, lastPrice: "1", priceChangePercent: "0", quoteVolume: String(1e9 - i) })) });
    }
    if (url.pathname.endsWith("/klines")) {
      const q = url.searchParams;
      const b = barsFor(q.get("symbol")!, q.get("interval")!);
      const end = q.get("endTime") ? Number(q.get("endTime")) : Number.POSITIVE_INFINITY;
      const hi = lowerBound(b.time, end + 1);
      const lo = Math.max(0, hi - Number(q.get("limit") ?? 500));
      const rows = [];
      for (let i = lo; i < hi; i++) {
        rows.push([b.time[i], String(b.open[i]), String(b.high[i]), String(b.low[i]), String(b.close[i]), String(b.volume[i]), b.time[i]! + b.tfSec * 1000 - 1]);
      }
      return route.fulfill({ json: rows });
    }
    return route.fulfill({ status: 404, json: { msg: "yok" } });
  });
  await page.routeWebSocket(/fstream\.binance\.com/, (ws) => ws.close());
}

const CASES = [
  { sym: "BTCUSDT", pick: null, from: "2026-07-01", to: "2026-09-29", name: "btc-son-sinav" },
  { sym: "DOGEUSDT", pick: /^DOGE\/USDT/, from: "2025-05-01", to: "2026-09-29", name: "doge-gorulmemis" },
];

for (const c of CASES) {
  test(`gerçek veri: Trend Avcısı ${c.sym} ${c.from} → ${c.to}, düzenekle aynı sonuç`, async ({ page }, info) => {
    await page.clock.setFixedTime(NOW);
    await mockReal(page);
    await page.goto("/");
    await expect(page.getByTestId("chart-header")).toContainText("Binance vadeli");
    if (c.pick) {
      await page.getByTestId("symbol-button").click();
      await page.getByTestId("symbol-search").fill(c.sym.replace("USDT", "").toLowerCase());
      await page.getByTestId("symbol-list").getByRole("button", { name: c.pick }).click();
    }
    await page.getByTestId("tf-15m").click();
    await expect(page.getByTestId("chart-header")).toContainText(c.sym);
    await expect(page.getByTestId("chart-header")).toContainText("15m");
    await page.getByRole("button", { name: "UT Bot Alerts kaldır" }).click();
    await page.getByTestId("indicators-button").click();
    await page.getByTestId("add-trend_avcisi_strategy").click();
    const strip = page.getByTestId("strategy-strip");
    await expect(strip).toContainText("Trend Avcısı");
    await strip.click();
    const sheet = page.getByTestId("strategy-sheet");
    await sheet.getByTestId("range-from").fill(c.from);
    await sheet.getByTestId("range-to").fill(c.to);

    const exp = new Runner().run({
      script: `${ROOT}src/pine/library/trend_avcisi_strategy.pine`,
      symbol: c.sym,
      from: dayStart(c.from),
      to: dayEnd(c.to),
      inputs: {},
      tf: 900,
      appLike: { now: NOW },
    });
    const n = exp.trades.length;
    const wins = exp.trades.filter((t) => t.ret > 0).length;
    expect(n).toBeGreaterThan(5);
    await expect(sheet.getByTestId("st-tab-trades")).toHaveText(`İşlemler (${n})`, { timeout: 120_000 });
    await expect(sheet.getByTestId("strategy-summary")).toContainText(`${wins}/${n}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `e2e/screenshots/gercek-${c.name}-ozet-${info.project.name}.png` });
    // grafik görüntüsü: dönemin en kârlı işlemi (liste en yeniden eskiye sıralı)
    const best = exp.trades.reduce((bi, t, i, a) => (t.ret > a[bi]!.ret ? i : bi), 0);
    await sheet.getByTestId("st-tab-trades").click();
    await sheet.getByTestId("trade-row").nth(n - 1 - best).click();
    await expect(sheet).toHaveCount(0);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `e2e/screenshots/gercek-${c.name}-grafik-${info.project.name}.png` });
  });
}
