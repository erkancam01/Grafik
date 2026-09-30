/** Hazır indikatörler (kendi yazdıklarımız; TradingView'daki kodlar da doğrudan yapıştırılabilir). */
import bollinger from "./bollinger.pine?raw";
import emaRibbon from "./ema_ribbon.pine?raw";
import emaTrend from "./ema_trend_4h.pine?raw";
import macd from "./macd.pine?raw";
import rsi from "./rsi.pine?raw";
import supertrend from "./supertrend.pine?raw";
import utBot from "./ut_bot.pine?raw";

export interface LibraryItem {
  id: string;
  name: string;
  description: string;
  code: string;
}

export const LIBRARY: LibraryItem[] = [
  { id: "ut_bot", name: "UT Bot Alerts", description: "ATR iz süren stop; Al/Sat etiketleri, mum renkleri, alarmlar", code: utBot },
  { id: "ema_trend_4h", name: "EMA Trend 4s (bot sistemi)", description: "Botun seçilen sistemi: 4s EMA20/EMA100, stop ve boyut", code: emaTrend },
  { id: "supertrend", name: "Supertrend", description: "ATR tabanlı trend çizgisi ve dönüş sinyalleri", code: supertrend },
  { id: "ema_ribbon", name: "EMA 20/50/200", description: "Üç üssel hareketli ortalama", code: emaRibbon },
  { id: "bollinger", name: "Bollinger Bantları", description: "SMA ± standart sapma bantları", code: bollinger },
  { id: "rsi", name: "RSI", description: "Göreceli güç endeksi (alt panel)", code: rsi },
  { id: "macd", name: "MACD", description: "MACD, sinyal ve histogram (alt panel)", code: macd },
];
