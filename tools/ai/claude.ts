/**
 * Haftalık UT Bot durumunu Claude'a verir: Claude son haftanın haberlerini web'de arar, karar_ver aracıyla kararını ve
 * yorumunu bildirir. Ret (refusal) olursa sunucu tarafı yedek model devreye girer (fallbacks: "default").
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AiCevap, Karar, Kaynak, Sinyal, Yon } from "../../src/ai/yorum";

export const MODEL = "claude-opus-5-5";
/** Fiyat (USD / milyon token) ve web araması başına. Yedek model yanıtlarsa yaklaşık kalır. */
const FIYAT = { girdi: 4, cikti: 20, onbellekYaz: 5, onbellekOku: 0.4, arama: 0.01 };
const EN_COK_ARAMA = 6;

/** Kullanılan istemci parçası (testlerde sahtesi verilir). */
export interface ClaudeIstemci {
  beta: { messages: { stream(p: BetaMessageStreamParams): { finalMessage(): Promise<BetaMessage> } } };
}

export interface Baglam {
  /** Karar anı (ms). */
  simdi: number;
  /** Haftanın açılışı (ms, pazartesi 00:00 UTC). */
  hafta: number;
  sinyal: Sinyal;
  pozisyon: boolean;
  /** Açık UT Bot işlemi (varsa). */
  acikIslem: { giris: number; girisFiyat: number } | null;
  acilis: number;
  oncekiKapanis: number;
  iz: number;
  /** Son haftalar (eskiden yeniye; son eleman geçen hafta). */
  mumlar: { zaman: number; acilis: number; yuksek: number; dusuk: number; kapanis: number }[];
}

export const KARAR_ARACI: BetaTool = {
  name: "karar_ver",
  description:
    "Haftalık kararını ve yorumunu kaydeder. Haberleri araştırdıktan sonra bir kez çağır. Tüm metinler Türkçe olsun.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      karar: {
        type: "string",
        enum: ["al", "atla", "yok"],
        description: "UT Bot Al sinyali verdiyse 'al' (long aç) ya da 'atla' (bu sinyali geç). Sinyal Al değilse 'yok'.",
      },
      guven: { type: "integer", description: "Karara güvenin, 0–100." },
      yon: {
        type: "string",
        enum: ["yukari", "asagi", "kararsiz"],
        description: "Bu haftanın kapanışı açılışın üstünde mi (yukari) altında mı (asagi) olacak; emin değilsen kararsiz.",
      },
      yon_guveni: { type: "integer", description: "Yön tahminine güvenin, 50–100." },
      ozet: { type: "string", description: "Son haftanın altınla ilgili haberlerinin 2–4 cümlelik özeti." },
      gerekce: { type: "string", description: "Kararın ve yön tahmininin kısa gerekçesi (en çok 5 cümle)." },
      riskler: { type: "array", items: { type: "string" }, description: "Kararı bozabilecek en önemli 1–3 risk." },
      kaynaklar: {
        type: "array",
        description: "Dayandığın en önemli 1–5 haber (aramada bulduğun bağlantılar).",
        items: {
          type: "object",
          properties: {
            baslik: { type: "string" },
            url: { type: "string" },
            tarih: { type: "string", description: "Haberin tarihi, YYYY-AA-GG (biliniyorsa)" },
          },
          required: ["baslik", "url", "tarih"],
          additionalProperties: false,
        },
      },
    },
    required: ["karar", "guven", "yon", "yon_guveni", "ozet", "gerekce", "riskler", "kaynaklar"],
    additionalProperties: false,
  },
};

const SISTEM = `Sen altın piyasasını izleyen bir analistsin. Her pazartesi, haftalık mum kapandıktan hemen sonra çağrılırsın.
Elinde altına bağlı PAXG/USDT'nin (1 PAXG = 1 ons altın) haftalık mumları ve UT Bot göstergesinin durumu var.
UT Bot: haftalık grafik, varsayılan ayarlar (anahtar değer 1, ATR 10), yalnız long — Al sinyalinde long açılır,
Sat sinyalinde kapatılır; işlemler sinyalden sonraki haftanın açılışında. Bu ayarın 2021–2026 geçmişi: 16 işlem,
%62,5'i kârlı, toplam +%68 (al-ve-tut +%115). Yani bir sinyali atlamanın da bedeli olabilir.

Görevin:
1. web_search ile son 7 günün altınla ilgili haberlerini araştır: Fed ve faiz beklentileri, ABD doları, enflasyon ve
   istihdam verileri, jeopolitik gelişmeler, merkez bankası alımları, altın ETF akışları. Birkaç arama yeterli.
   Yalnız karar anından önceki haberleri kullan.
2. UT Bot bu hafta Al sinyali verdiyse karar ver: "al" (sinyali uygula) ya da "atla" (geç; bir sonraki Al sinyaline
   kadar pozisyon açılmaz). Sinyal yoksa ya da Sat ise karar "yok".
3. Her hafta, bu haftanın kapanışının açılışın üstünde mi altında mı olacağını tahmin et; emin değilsen "kararsiz".
4. Sonunda karar_ver aracını bir kez çağır.

Bu, gerçek para kullanılmayan, ileriye dönük bir denemedir: kararların kayda geçer ve UT Bot'un kendi sonuçlarıyla
karşılaştırılır. Tahmin yapmak senin görevin; belirsizliği güven puanlarıyla ifade et.`;

const gun = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const saat = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const fiyat = (x: number) => x.toFixed(2);

const SINYAL_METNI: Record<Sinyal, string> = {
  al: "AL — geçen haftanın kapanışında Al sinyali; bu haftanın açılışında long açılacak (senin onayınla)",
  sat: "SAT — geçen haftanın kapanışında Sat sinyali; long bu haftanın açılışında kapatıldı",
  yok: "yok — sinyal yok",
};

export function istem(b: Baglam): string {
  const satirlar = b.mumlar.map((m) => `| ${gun(m.zaman)} | ${fiyat(m.acilis)} | ${fiyat(m.yuksek)} | ${fiyat(m.dusuk)} | ${fiyat(m.kapanis)} |`);
  const poz = b.acikIslem
    ? `long (giriş ${gun(b.acikIslem.giris)}, ${fiyat(b.acikIslem.girisFiyat)}; şimdi %${(((b.acilis / b.acikIslem.girisFiyat) - 1) * 100).toFixed(1)})`
    : "yok";
  return [
    `Karar anı: ${saat(b.simdi)} UTC`,
    `Bu hafta: ${gun(b.hafta)} (pazartesi) – ${gun(b.hafta + 6 * 86_400_000)}`,
    `UT Bot sinyali: ${SINYAL_METNI[b.sinyal]}`,
    `UT Bot pozisyonu (bu haftanın açılışından sonra): ${b.pozisyon ? poz : "yok"}`,
    `İz süren stop (geçen hafta kapanışında): ${fiyat(b.iz)} (kapanışa uzaklık %${(((b.oncekiKapanis - b.iz) / b.oncekiKapanis) * 100).toFixed(1)})`,
    `Geçen haftanın kapanışı: ${fiyat(b.oncekiKapanis)}; bu haftanın açılışı: ${fiyat(b.acilis)}`,
    "",
    "Son haftalık mumlar (PAXG/USDT, hafta başı tarihiyle):",
    "| hafta | açılış | yüksek | düşük | kapanış |",
    "|---|---|---|---|---|",
    ...satirlar,
    "",
    "Haberleri araştır, sonra karar_ver aracıyla kararını bildir.",
  ].join("\n");
}

export class YanitYok extends Error {}

const SECENEK = <T extends string>(x: unknown, izinli: readonly T[], yedek: T): T => (izinli.includes(x as T) ? (x as T) : yedek);
const SINIRLA = (x: unknown, lo: number, hi: number, yedek: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : yedek);
const METIN = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** Yanıttaki web araması sonuçlarının bağlantıları (yapay zekânın verdiği kaynaklar bunlarla sınanır). */
export function aramaBaglantilari(bloklar: BetaContentBlock[]): Set<string> {
  const urls = new Set<string>();
  for (const b of bloklar) {
    if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
    for (const r of b.content) if (r.type === "web_search_result") urls.add(r.url);
  }
  return urls;
}

export function cevabiOku(girdi: unknown, sinyal: Sinyal, bulunan: Set<string>): Omit<AiCevap, "model" | "arama" | "girdiToken" | "ciktiToken" | "maliyet"> {
  const g = (girdi ?? {}) as Record<string, unknown>;
  // Al haftası dışında karar yok; Al haftasında "yok" gelirse UT Bot'a uyulur (puanlamada "al" gibi).
  const karar: Karar = sinyal === "al" ? SECENEK(g.karar, ["al", "atla", "yok"] as const, "yok") : "yok";
  const kaynaklar: Kaynak[] = (Array.isArray(g.kaynaklar) ? g.kaynaklar : [])
    .map((k) => k as Record<string, unknown>)
    .map((k) => ({ baslik: METIN(k.baslik), url: METIN(k.url), tarih: METIN(k.tarih) }))
    .filter((k) => k.url && bulunan.has(k.url))
    .slice(0, 5);
  return {
    karar,
    guven: SINIRLA(g.guven, 0, 100, 50),
    yon: SECENEK(g.yon, ["yukari", "asagi", "kararsiz"] as const, "kararsiz") as Yon,
    yonGuveni: SINIRLA(g.yon_guveni, 50, 100, 50),
    ozet: METIN(g.ozet),
    gerekce: METIN(g.gerekce),
    riskler: (Array.isArray(g.riskler) ? g.riskler : []).map(METIN).filter(Boolean).slice(0, 3),
    kaynaklar,
  };
}

/** Claude'a sorar; karar_ver çağrısı gelene kadar (en çok birkaç tur) sürdürür. */
export async function yorumla(istemci: ClaudeIstemci, b: Baglam): Promise<AiCevap> {
  const mesajlar: BetaMessageParam[] = [{ role: "user", content: istem(b) }];
  const bloklar: BetaContentBlock[] = [];
  let girdi = 0;
  let cikti = 0;
  let maliyet = 0;
  let arama = 0;
  let model: string = MODEL;
  let hatirlatildi = false;
  for (let tur = 0; tur < 6; tur++) {
    const m = await istemci.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: SISTEM,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: EN_COK_ARAMA }, KARAR_ARACI],
        messages: mesajlar,
      })
      .finalMessage();
    model = m.model;
    const u = m.usage;
    const s = u.server_tool_use?.web_search_requests ?? 0;
    girdi += u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    cikti += u.output_tokens;
    arama += s;
    maliyet +=
      (u.input_tokens * FIYAT.girdi + (u.cache_creation_input_tokens ?? 0) * FIYAT.onbellekYaz + (u.cache_read_input_tokens ?? 0) * FIYAT.onbellekOku + u.output_tokens * FIYAT.cikti) / 1e6 +
      s * FIYAT.arama;
    bloklar.push(...m.content);
    if (m.stop_reason === "refusal") {
      throw new YanitYok(`Claude yanıt vermedi (ret${m.stop_details?.category ? `: ${m.stop_details.category}` : ""})`);
    }
    const arac = m.content.find((x) => x.type === "tool_use" && x.name === KARAR_ARACI.name);
    if (arac && arac.type === "tool_use") {
      return { ...cevabiOku(arac.input, b.sinyal, aramaBaglantilari(bloklar)), model, arama, girdiToken: girdi, ciktiToken: cikti, maliyet };
    }
    if (m.stop_reason === "max_tokens") throw new YanitYok("Yanıt yarıda kesildi (max_tokens)");
    mesajlar.push({ role: "assistant", content: m.content });
    if (m.stop_reason === "pause_turn") continue; // sunucu tarafı arama döngüsü sürüyor: aynen devam
    if (hatirlatildi) break;
    hatirlatildi = true;
    mesajlar.push({ role: "user", content: "Lütfen kararını ve yorumunu karar_ver aracıyla bildir." });
  }
  throw new YanitYok("Claude karar_ver aracını çağırmadı");
}

/** Gerçek istemci (ANTHROPIC_API_KEY ortam değişkeninden). */
export async function istemciKur(): Promise<ClaudeIstemci> {
  const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
  const c: Anthropic = new AnthropicSdk({ maxRetries: 4, timeout: 15 * 60_000 });
  return c;
}
