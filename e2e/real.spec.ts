/**
 * Gerçek Binance altın verisiyle (önbellek: .cache/bars; tools/backtest/import_gold_data.py) stratejileri uygulamada
 * çalıştırır: vadeli (XAUUSDT) ve spot (PAXGUSDT) uçları önbellekteki 15 dk mumlarla yanıtlanır, saat verinin sonuna
 * sabitlenir, tarih kutuları İstanbul saatiyle. Uygulamanın gösterdiği işlem ve kazanan sayısı, deneme düzeneğinin
 * "uygulama gibi yükle" hesabıyla aynı olmalı. Yalnız BT_REAL=1 ile çalışır (CI'da atlanır).
 * Ekran görüntüleri: e2e/screenshots/gercek-*.png
 */
import { existsSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { resample } from "../src/data/source";
import type { BarsData } from "../src/pine/types";
import { BARS_DIR, loadBars, lowerBound, ROOT, Runner } from "../tools/backtest/lib";
import { dayEnd, dayStart } from "../tools/backtest/protocol";

const REAL = process.env.BT_REAL === "1" && existsSync(`${BARS_DIR}/SPOT-PAXGUSDT_15m.f64`) && existsSync(`${BARS_DIR}/XAUUSDT_15m.f64`);
test.skip(!REAL, "gerçek veri testi: BT_REAL=1 ve .cache/bars altın verisi gerekli");
test.use({ timezoneId: "Europe/Istanbul" });
test.setTimeout(180_000);

const NOW = Date.parse("2026-09-30T00:00:00Z");
const SEC: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
/** Uygulamadaki sembol → önbellek dosyası (PAXGUSDT spot uçtan gelir). */
const FILE: Record<string, string> = { XAUUSDT: "XAUUSDT", PAXGUSDT: "SPOT-PAXGUSDT" };
const cache = new Map<string, BarsData>();

function barsFor(symbol: string, interval: string): BarsData {
  const key = `${symbol}|${interval}`;
  let b = cache.get(key);
  if (!b) {
    const m15 = loadBars(FILE[symbol]!, "15m");
    cache.set(key, (b = SEC[interval] === 900 ? m15 : resample(m15, SEC[interval]!)));
  }
  return b;
}

async function mockReal(page: Page) {
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams;
    if (url.pathname.endsWith("/ticker/24hr")) {
      const sym = q.get("symbol") ?? "XAUUSDT";
      const b = barsFor(sym, "1d");
      return route.fulfill({ json: { symbol: sym, lastPrice: String(b.close[b.close.length - 1]), priceChangePercent: "0", quoteVolume: "1000000" } });
    }
    if (url.pathname.endsWith("/klines")) {
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
  };
  await page.route("https://fapi.binance.com/**", handler);
  await page.route("https://data-api.binance.vision/**", handler);
  await page.routeWebSocket(/fstream\.binance\.com|data-stream\.binance\.vision/, (ws) => ws.close());
}

const UT = { id: "ut_bot_strategy", title: "UT Bot", file: "ut_bot_strategy.pine" };
const RJ = { id: "rejim_strategy", title: "Rejim", file: "rejim_strategy.pine" };
const CASES = [
  { s: UT, sym: "PAXGUSDT", tf: "1w", inputs: {} as Record<string, string>, from: "2021-01-01", to: "2026-09-29", name: "ut-paxg-haftalik" },
  { s: UT, sym: "PAXGUSDT", tf: "1w", inputs: { "İşlem yönü": "Yalnız long" }, from: "2021-01-01", to: "2026-09-29", name: "ut-paxg-haftalik-long" },
  { s: UT, sym: "XAUUSDT", tf: "1d", inputs: {}, from: "2026-01-01", to: "2026-09-29", name: "ut-xau-gunluk" },
  { s: RJ, sym: "PAXGUSDT", tf: "1d", inputs: {}, from: "2021-01-01", to: "2026-09-29", name: "rejim-paxg-gunluk" },
];

for (const c of CASES) {
  const label = Object.keys(c.inputs).length ? ` (${Object.values(c.inputs).join(", ")})` : "";
  test(`gerçek veri: ${c.s.title}${label} ${c.sym} ${c.tf} ${c.from} → ${c.to}, düzenekle aynı sonuç`, async ({ page }, info) => {
    await page.clock.setFixedTime(NOW);
    await mockReal(page);
    await page.goto("/");
    await expect(page.getByTestId("chart-header")).toContainText("XAUUSDT");
    if (c.sym !== "XAUUSDT") {
      await page.getByTestId("symbol-button").click();
      await page.getByTestId("symbol-list").getByRole("button", { name: new RegExp(`^${c.sym.replace("USDT", "")}/USDT`) }).click();
    }
    await page.getByTestId(`tf-${c.tf}`).click();
    await expect(page.getByTestId("chart-header")).toContainText(c.sym);
    await expect(page.getByTestId("chart-header")).toContainText(c.tf.toUpperCase());
    await page.getByRole("button", { name: "UT Bot Alerts kaldır" }).click();
    await page.getByTestId("indicators-button").click();
    await page.getByTestId(`add-${c.s.id}`).click();
    const strip = page.getByTestId("strategy-strip");
    await expect(strip).toContainText(c.s.title);
    for (const [k, v] of Object.entries(c.inputs)) {
      await page.getByTestId("legend-settings").click();
      await page.getByLabel(k).selectOption(v);
      await page.getByTestId("inputs-apply").click();
    }
    await strip.click();
    const sheet = page.getByTestId("strategy-sheet");
    await sheet.getByTestId("range-from").fill(c.from);
    await sheet.getByTestId("range-to").fill(c.to);

    const exp = new Runner().run({
      script: `${ROOT}src/pine/library/${c.s.file}`,
      symbol: FILE[c.sym]!,
      from: dayStart(c.from),
      to: dayEnd(c.to),
      inputs: c.inputs,
      tf: SEC[c.tf],
      data: "15m",
      appLike: { now: NOW },
    });
    const n = exp.trades.length;
    const wins = exp.trades.filter((t) => t.ret > 0).length;
    expect(n).toBeGreaterThan(3);
    await expect(sheet.getByTestId("st-tab-trades")).toHaveText(`İşlemler (${n + exp.openTrades})`, { timeout: 120_000 });
    await expect(sheet.getByTestId("strategy-summary")).toContainText(`${wins}/${n}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `e2e/screenshots/gercek-${c.name}-ozet-${info.project.name}.png` });
    // grafik görüntüsü: dönemin en kârlı işlemi (liste en yeniden eskiye sıralı)
    const best = exp.trades.reduce((bi, t, i, a) => (t.ret > a[bi]!.ret ? i : bi), 0);
    await sheet.getByTestId("st-tab-trades").click();
    await sheet.getByTestId("trade-row").nth(exp.openTrades + n - 1 - best).click();
    await expect(sheet).toHaveCount(0);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `e2e/screenshots/gercek-${c.name}-grafik-${info.project.name}.png` });
  });
}
