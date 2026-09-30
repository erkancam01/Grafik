import { expect, test, type Page } from "@playwright/test";
import { DemoSource } from "../src/data/demo";

/** Binance vadeli uçlarını sahte veriyle yanıtla (gerçek istemci kodu çalışır; WebSocket yoklamaya düşer). */
async function mockBinance(page: Page) {
  const demo = new DemoSource();
  await page.route("https://fapi.binance.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/ticker/24hr")) {
      const syms = await demo.symbols();
      return route.fulfill({
        json: syms.map((s) => ({ symbol: s.symbol, lastPrice: String(s.price), priceChangePercent: String(s.changePct), quoteVolume: String(s.quoteVolume) })),
      });
    }
    if (url.pathname.endsWith("/klines")) {
      const q = url.searchParams;
      const end = q.get("endTime");
      const b = await demo.klines(q.get("symbol")!, q.get("interval")!, Number(q.get("limit")), end ? Number(end) : undefined);
      const rows = Array.from(b.time, (t, i) => [t, String(b.open[i]), String(b.high[i]), String(b.low[i]), String(b.close[i]), String(b.volume[i]), t + b.tfSec * 1000 - 1]);
      return route.fulfill({ json: rows });
    }
    return route.fulfill({ status: 404, json: { msg: "yok" } });
  });
  await page.routeWebSocket(/fstream\.binance\.com/, (ws) => ws.close());
}

function collectErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  return errs;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("e2e-init")) {
      localStorage.clear();
      sessionStorage.setItem("e2e-init", "1");
    }
  });
});

test("demo: grafik ve UT Bot açılır, telefonda yatay taşma yok", async ({ page }) => {
  const errs = collectErrors(page);
  await page.goto("/?demo");
  await expect(page.getByTestId("chart-header")).toContainText("BTCUSDT");
  await expect(page.getByTestId("legend-row")).toHaveCount(1);
  await expect(page.getByTestId("legend-row").first()).toContainText("UT Bot Alerts");
  await expect(page.getByTestId("legend-error")).toHaveCount(0);
  await expect(page.locator("[data-testid=chart] canvas").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errs).toEqual([]);
});

test("Binance (sahte yanıt): vadeli kaynak, sembol ve zaman dilimi değişimi", async ({ page }) => {
  const errs = collectErrors(page);
  await mockBinance(page);
  await page.goto("/");
  await expect(page.getByTestId("chart-header")).toContainText("Binance vadeli");
  await page.getByTestId("symbol-button").click();
  await page.getByTestId("symbol-search").fill("eth");
  await page.getByTestId("symbol-list").getByRole("button", { name: /^ETH\/USDT/ }).click();
  await expect(page.getByTestId("chart-header")).toContainText("ETHUSDT");
  await page.getByTestId("tf-1h").click();
  await expect(page.getByTestId("chart-header")).toContainText("1h");
  await expect(page.getByTestId("legend-row").first()).toContainText("UT Bot");
  await expect(page.getByTestId("legend-error")).toHaveCount(0);
  expect(errs).toEqual([]);
});

test("kütüphaneden RSI ve EMA Trend 4s (request.security) eklenir", async ({ page }) => {
  await page.goto("/?demo");
  await expect(page.getByTestId("legend-row")).toHaveCount(1);
  await page.getByTestId("indicators-button").click();
  await page.getByTestId("add-rsi").click();
  await expect(page.getByTestId("legend-row")).toHaveCount(2);
  await page.getByTestId("indicators-button").click();
  await page.getByTestId("add-ema_trend_4h").click();
  await expect(page.getByTestId("legend-row")).toHaveCount(3);
  await expect(page.getByTestId("legend-row").nth(2)).toContainText("EMA Trend");
  await expect(page.getByTestId("legend-error")).toHaveCount(0);
});

test("kod yapıştır: hata satırı gösterilir, düzeltince grafiğe eklenir ve kalıcıdır", async ({ page }) => {
  await page.goto("/?demo");
  await page.getByTestId("indicators-button").click();
  await page.getByTestId("tab-editor").click();
  const editor = page.getByTestId("code-editor");
  await editor.fill(`//@version=5\nindicator("Deneme EMA", overlay=true)\nplot(close +)`);
  await page.getByTestId("editor-check").click();
  await expect(page.getByTestId("editor-error")).toContainText("Satır 3");
  await editor.fill(`//@version=5\nindicator("Deneme EMA", overlay=true)\nlen = input.int(9, "Uzunluk")\nplot(ta.ema(close, len), "EMA", color=color.orange)`);
  await page.getByTestId("editor-add").click();
  await expect(page.getByTestId("legend-row")).toHaveCount(2);
  await expect(page.getByTestId("legend-row").nth(1)).toContainText("Deneme EMA");
  // ayarlar: girdiden otomatik form
  await page.getByTestId("legend-row").nth(1).getByTestId("legend-settings").click();
  await expect(page.getByTestId("inputs-dialog")).toContainText("Uzunluk");
  await page.getByTestId("inputs-dialog").getByRole("spinbutton").fill("21");
  await page.getByTestId("inputs-apply").click();
  await expect(page.getByTestId("legend-error")).toHaveCount(0);
  // yeniden yüklemede kodlar ve indikatörler korunur
  await page.reload();
  await expect(page.getByTestId("legend-row")).toHaveCount(2);
  await page.getByTestId("indicators-button").click();
  await page.getByTestId("tab-mine").click();
  await expect(page.getByTestId("my-scripts")).toContainText("Deneme EMA");
});

test("çalışma hatası açıkça gösterilir", async ({ page }) => {
  await page.goto("/?demo");
  await page.getByTestId("indicators-button").click();
  await page.getByTestId("tab-editor").click();
  await page.getByTestId("code-editor").fill(`indicator("Strateji mi?")\nstrategy.entry("L", strategy.long)`);
  await page.getByTestId("editor-add").click();
  await expect(page.getByTestId("editor-error").or(page.getByTestId("legend-error"))).toContainText(/strategy\(/);
});

test("strateji: UT Bot Strateji → Strateji Test Aracı (özet, işlemler, ayarlar)", async ({ page }, info) => {
  const errs = collectErrors(page);
  await page.goto("/?demo");
  await page.getByTestId("indicators-button").click();
  await page.getByTestId("add-ut_bot_strategy").click();
  const strip = page.getByTestId("strategy-strip");
  await expect(strip).toContainText("UT Bot Strateji");
  await expect(page.getByTestId("strategy-net")).toHaveText(/%/);
  await strip.click();
  const sheet = page.getByTestId("strategy-sheet");
  // strateji varken geçmiş 5000 muma tamamlanır
  await expect(sheet.getByTestId("strategy-period")).toContainText("5000 mum");
  await expect(sheet.getByTestId("equity-chart")).toBeVisible();
  await expect(sheet.getByTestId("strategy-table")).toContainText("Kâr faktörü");
  const net1 = await sheet.getByTestId("kpi-net").innerText();
  await page.screenshot({ path: `e2e/screenshots/strateji-ozet-${info.project.name}.png` });
  await sheet.getByTestId("st-tab-trades").click();
  const rows = sheet.getByTestId("trade-row");
  expect(await rows.count()).toBeGreaterThan(5);
  await page.screenshot({ path: `e2e/screenshots/strateji-islemler-${info.project.name}.png` });
  await rows.nth(2).click();
  await expect(sheet).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `e2e/screenshots/strateji-grafik-${info.project.name}.png` });
  // ayarlar → strateji özellikleri: komisyonu sıfırla → sonuç değişir
  await strip.click();
  await page.getByTestId("st-settings").click();
  const dlg = page.getByTestId("inputs-dialog");
  await expect(dlg).toContainText("Strateji özellikleri");
  await dlg.locator('[id="in-__s.comm"]').fill("0");
  await page.getByTestId("inputs-apply").click();
  await strip.click();
  await page.getByTestId("st-tab-summary").click();
  await expect(page.getByTestId("kpi-net")).not.toHaveText(net1);
  expect(errs).toEqual([]);
});

test("strateji kodu yapıştır (Pine v4): test aracı çıkar", async ({ page }) => {
  await page.goto("/?demo");
  await page.getByTestId("indicators-button").click();
  await page.getByTestId("tab-editor").click();
  await page.getByTestId("code-editor").fill(`//@version=4
strategy("Kesişim v4", overlay=true, initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
fast = ema(close, 9)
slow = ema(close, 21)
strategy.entry("L", strategy.long, when = crossover(fast, slow))
strategy.close("L", when = crossunder(fast, slow))
plot(fast)
plot(slow, color=color.orange)`);
  await page.getByTestId("editor-add").click();
  await expect(page.getByTestId("strategy-strip")).toContainText("Kesişim v4");
  await expect(page.getByTestId("legend-error")).toHaveCount(0);
});

test("ekran görüntüleri", async ({ page }, info) => {
  await page.goto("/?demo");
  await page.getByTestId("indicators-button").click();
  await page.getByTestId("add-rsi").click();
  await expect(page.getByTestId("legend-row")).toHaveCount(2);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `e2e/screenshots/${info.project.name}.png` });
});
