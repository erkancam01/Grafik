/** Hazır indikatörler (kendi yazdıklarımız; TradingView'daki kodlar da doğrudan yapıştırılabilir). */
import bollinger from "./bollinger.pine?raw";
import emaRibbon from "./ema_ribbon.pine?raw";
import emaTrend from "./ema_trend_4h.pine?raw";
import emaTrendStrategy from "./ema_trend_4h_strategy.pine?raw";
import macd from "./macd.pine?raw";
import rejim from "./rejim.pine?raw";
import rejimStrategy from "./rejim_strategy.pine?raw";
import rsi from "./rsi.pine?raw";
import supertrend from "./supertrend.pine?raw";
import trendAvcisi from "./trend_avcisi.pine?raw";
import trendAvcisiStrategy from "./trend_avcisi_strategy.pine?raw";
import utBot from "./ut_bot.pine?raw";
import utBotStrategy from "./ut_bot_strategy.pine?raw";

export interface LibraryItem {
  id: string;
  name: string;
  description: string;
  code: string;
  /** strategy() betiği: eklenince Strateji Test Aracı açılır. */
  strategy?: boolean;
}

export const LIBRARY: LibraryItem[] = [
  { id: "ut_bot", name: "UT Bot Alerts", description: "ATR iz süren stop; Al/Sat etiketleri, mum renkleri, alarmlar", code: utBot },
  { id: "ema_trend_4h", name: "EMA Trend 4s (bot sistemi)", description: "Botun seçilen sistemi: 4s EMA20/EMA100, stop ve boyut", code: emaTrend },
  { id: "rejim", name: "Rejim (günlük)", description: "Günlük rejim (yükseliş/düşüş/yatay) arka planda; rejimin kuralıyla Al/Sat/Çık ve alarmlar", code: rejim },
  { id: "trend_avcisi", name: "Trend Avcısı (15 dk)", description: "Günlük trend yönünde 2 günlük kanal kırılımı, iz süren stop; Al/Sat/Çık ve alarmlar", code: trendAvcisi },
  { id: "ut_bot_strategy", name: "UT Bot Strateji", description: "Backtest: Al'da long, Sat'ta short; kâr, işlem listesi, düşüş", code: utBotStrategy, strategy: true },
  { id: "ema_trend_4h_strategy", name: "EMA Trend 4s Strateji (bot sistemi)", description: "Backtest: botun sistemi, 3×ATR stop ile", code: emaTrendStrategy, strategy: true },
  { id: "rejim_strategy", name: "Rejim Strateji (günlük)", description: "Backtest: rejime göre kural; ileriye yürüyen testte %70,6 kazanma, 2026'da zarar", code: rejimStrategy, strategy: true },
  { id: "trend_avcisi_strategy", name: "Trend Avcısı Strateji (15 dk)", description: "Backtest: 15 dk kanal kırılımı + iz süren stop; kazanma ~%35. 2024-26 artı, 2020-24 eksi", code: trendAvcisiStrategy, strategy: true },
  { id: "supertrend", name: "Supertrend", description: "ATR tabanlı trend çizgisi ve dönüş sinyalleri", code: supertrend },
  { id: "ema_ribbon", name: "EMA 20/50/200", description: "Üç üssel hareketli ortalama", code: emaRibbon },
  { id: "bollinger", name: "Bollinger Bantları", description: "SMA ± standart sapma bantları", code: bollinger },
  { id: "rsi", name: "RSI", description: "Göreceli güç endeksi (alt panel)", code: rsi },
  { id: "macd", name: "MACD", description: "MACD, sinyal ve histogram (alt panel)", code: macd },
];
