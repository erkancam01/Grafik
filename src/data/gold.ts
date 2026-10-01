/**
 * Yalnız altın: Binance vadeli XAUUSDT (altın sözleşmesi, 2025-12'den beri) ve Binance spot PAXGUSDT (altına bağlı PAX
 * Gold tokeni, 2020'den beri; haftalık ve uzun geçmiş için). Her sembol kendi ucundan çekilir; tarayıcıdan ulaşılamayan
 * uç atlanır, hiçbirine ulaşılamazsa hata verir.
 */
import type { BarsData } from "../pine/types";
import { BinanceSource, FUTURES, SPOT } from "./binance";
import type { DataSource, LiveBar, SymbolInfo } from "./source";

export const GOLD_SYMBOLS = [
  { symbol: "XAUUSDT", market: FUTURES },
  { symbol: "PAXGUSDT", market: SPOT },
] as const;

/** Uygulamanın gösterdiği semboller (sıra: varsayılan önce). */
export const GOLD_IDS: readonly string[] = GOLD_SYMBOLS.map((g) => g.symbol);

export class GoldSource implements DataSource {
  readonly name = "gold";
  readonly label = "Binance (altın)";

  private constructor(private readonly routes: ReadonlyMap<string, BinanceSource>) {}

  /** Her altın sembolünün ucunu dener; ulaşılabilenlerle kaynak kurar. */
  static async detect(): Promise<GoldSource> {
    const ok = await Promise.all(
      GOLD_SYMBOLS.map(async (g): Promise<[string, BinanceSource] | null> => {
        const s = new BinanceSource(g.market);
        try {
          await s.klines(g.symbol, "1h", 1);
          return [g.symbol, s];
        } catch {
          return null;
        }
      }),
    );
    const routes = new Map(ok.filter((x): x is [string, BinanceSource] => x !== null));
    if (!routes.size) throw new Error("Binance altın verisine ulaşılamadı (XAUUSDT vadeli, PAXGUSDT spot)");
    return new GoldSource(routes);
  }

  get available(): readonly string[] {
    return [...this.routes.keys()];
  }

  private route(symbol: string): BinanceSource {
    const r = this.routes.get(symbol);
    if (!r) throw new Error(`${symbol} bu uygulamada yok (yalnız altın: ${this.available.join(", ")})`);
    return r;
  }

  labelFor(symbol: string): string {
    return this.routes.get(symbol)?.label ?? this.label;
  }

  async symbols(): Promise<SymbolInfo[]> {
    const rows = await Promise.all(
      [...this.routes].map(async ([sym, s]) => {
        try {
          return await s.ticker(sym);
        } catch {
          return { symbol: sym, price: Number.NaN, changePct: Number.NaN, quoteVolume: 0 };
        }
      }),
    );
    return rows;
  }

  async klines(symbol: string, interval: string, limit: number, endTime?: number): Promise<BarsData> {
    return this.route(symbol).klines(symbol, interval, limit, endTime);
  }

  subscribe(symbol: string, interval: string, onBar: (b: LiveBar) => void, onStatus?: (live: boolean) => void): () => void {
    return this.route(symbol).subscribe(symbol, interval, onBar, onStatus);
  }
}
