/**
 * UT Bot sinyalini (günlük ya da haftalık) ya da haftanın durumunu Claude'a verir: Claude son haberleri web'de arar ve
 * degerlendir aracıyla 0–100 arası al-sat puanını ve açıklamasını bildirir (0 = kesin sat, 50 = nötr, 100 = kesin al).
 * Ret (refusal) olursa sunucu tarafı yedek model devreye girer (fallbacks: "default").
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Degerlendirme, Kaynak, Sinyal, Tf } from "../../src/ai/yorum";

export const MODEL = "claude-opus-5-5";
/** Fiyat (USD / milyon token) ve web araması başına. Yedek model yanıtlarsa yaklaşık kalır. */
const FIYAT = { girdi: 4, cikti: 20, onbellekYaz: 5, onbellekOku: 0.4, arama: 0.01 };
const EN_COK_ARAMA = 6;
const GUN = 86_400_000;

/** Kullanılan istemci parçası (testlerde sahtesi verilir). */
export interface ClaudeIstemci {
  beta: { messages: { stream(p: BetaMessageStreamParams): { finalMessage(): Promise<BetaMessage> } } };
}

export interface Baglam {
  /** Karar anı (ms). */
  simdi: number;
  tf: Tf;
  /** İşlem mumunun açılışı (ms, UTC) = sinyal mumunun kapanışı. */
  zaman: number;
  sinyal: Sinyal;
  pozisyon: boolean;
  /** Açık UT Bot işlemi (varsa). */
  acikIslem: { giris: number; girisFiyat: number } | null;
  acilis: number;
  oncekiKapanis: number;
  iz: number;
  /** Son mumlar (eskiden yeniye; son eleman sinyal mumu). */
  mumlar: { zaman: number; acilis: number; yuksek: number; dusuk: number; kapanis: number }[];
}

export const PUAN_ARACI: BetaTool = {
  name: "degerlendir",
  description: "Al-sat puanını ve açıklamasını kaydeder. Haberleri araştırdıktan sonra bir kez çağır. Tüm metinler Türkçe olsun.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      puan: {
        type: "integer",
        description: "0–100 al-sat puanı: 0 kesinlikle sat (altın düşecek), 50 nötr, 100 kesinlikle al (altın yükselecek).",
      },
      aciklama: { type: "string", description: "Puanın açıklaması: haberlere ve grafiğe dayanarak 2–4 cümle." },
      ozet: { type: "string", description: "Altınla ilgili son haberlerin 2–3 cümlelik özeti." },
      riskler: { type: "array", items: { type: "string" }, description: "Görüşünü bozabilecek en önemli 1–3 risk." },
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
    required: ["puan", "aciklama", "ozet", "riskler", "kaynaklar"],
    additionalProperties: false,
  },
};

const SISTEM = `Sen altın piyasasını izleyen bir analistsin. Elinde altına bağlı PAXG/USDT'nin (1 PAXG = 1 ons altın) mumları
ve UT Bot göstergesinin durumu var. UT Bot varsayılan ayarlarla (anahtar değer 1, ATR 10) çalışır: Al sinyalinde long
açılır, Sat sinyalinde kapatılır; işlem sinyal mumundan sonraki mumun açılışında. 2021–2026 geçmişi (yalnız long):
günlük grafikte 93 işlem, %42'si kârlı, toplam +%69 (kazançlar kayıplardan büyük); haftalık grafikte 16 işlem, %62,5'i
kârlı, toplam +%68. Aynı dönemde altını alıp tutmak +%116.

Görevin, sana verilen sinyal (ya da haftanın genel durumu) için 0–100 arası bir al-sat puanı vermek:
0 = kesinlikle sat, 25 = sat, 50 = nötr, 75 = al, 100 = kesinlikle al.
Puan, sinyalin yönünden bağımsız olarak senin görüşündür: Al sinyaline 30 verirsen sinyale katılmıyorsun demektir; Sat
sinyaline 30 verirsen satışa katılıyorsun demektir. Ufuk: günlük sinyalde önümüzdeki birkaç gün ile birkaç hafta,
haftalık sinyalde birkaç hafta ile birkaç ay, sinyalsiz haftalık görünümde bu haftanın kapanışı.

Adımlar:
1. web_search ile altınla ilgili son haberleri araştır: Fed ve faiz beklentileri, ABD doları, enflasyon ve istihdam
   verileri, jeopolitik gelişmeler, merkez bankası alımları, altın ETF akışları. Birkaç arama yeterli. Yalnız karar
   anından önceki haberleri kullan.
2. Haberleri ve verilen mumları birlikte değerlendir.
3. Sonunda degerlendir aracını bir kez çağır.

Bu, gerçek para kullanılmayan, ileriye dönük bir denemedir: puanların kayda geçer ve UT Bot'un kendi sonuçlarıyla
karşılaştırılır. Kararsızsan 50'ye yakın, eminsen uçlara yakın puan ver.`;

const gun = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const saat = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const fiyat = (x: number) => x.toFixed(2);
const TF_METNI: Record<Tf, { ad: string; mum: string; bu: string }> = {
  "1d": { ad: "Günlük", mum: "dünkü günlük mumun", bu: "bugünün" },
  "1w": { ad: "Haftalık", mum: "geçen haftanın", bu: "bu haftanın" },
};

export function istem(b: Baglam): string {
  const t = TF_METNI[b.tf];
  const sinyal =
    b.sinyal === "al"
      ? `AL — ${t.mum} kapanışında Al sinyali; long ${t.bu} açılışında açılır`
      : b.sinyal === "sat"
        ? `SAT — ${t.mum} kapanışında Sat sinyali; long ${t.bu} açılışında kapatılır (iki yönlü işlemde short açılır)`
        : "yok — bu hafta yeni sinyal yok; haftanın genel görünümü için puan ver";
  const poz = b.acikIslem
    ? `long (giriş ${gun(b.acikIslem.giris)}, ${fiyat(b.acikIslem.girisFiyat)}; şimdi %${((b.acilis / b.acikIslem.girisFiyat - 1) * 100).toFixed(1)})`
    : "yok";
  const bitis = b.tf === "1w" ? ` – ${gun(b.zaman + 6 * GUN)}` : "";
  return [
    `Karar anı: ${saat(b.simdi)} UTC`,
    `Grafik: ${t.ad} (PAXG/USDT). Mum: ${gun(b.zaman)}${bitis}`,
    `UT Bot sinyali: ${sinyal}`,
    `UT Bot pozisyonu (yalnız long, bu mumun açılışından sonra): ${b.pozisyon ? poz : "yok"}`,
    `İz süren stop (sinyal mumunun kapanışında): ${fiyat(b.iz)} (kapanışa uzaklık %${(((b.oncekiKapanis - b.iz) / b.oncekiKapanis) * 100).toFixed(1)})`,
    `Önceki kapanış: ${fiyat(b.oncekiKapanis)}; bu mumun açılışı: ${fiyat(b.acilis)}`,
    "",
    `Son ${t.ad.toLowerCase()} mumlar (açılış tarihiyle):`,
    "| tarih | açılış | yüksek | düşük | kapanış |",
    "|---|---|---|---|---|",
    ...b.mumlar.map((m) => `| ${gun(m.zaman)} | ${fiyat(m.acilis)} | ${fiyat(m.yuksek)} | ${fiyat(m.dusuk)} | ${fiyat(m.kapanis)} |`),
    "",
    "Haberleri araştır, sonra degerlendir aracıyla 0–100 al-sat puanını ve açıklamasını bildir.",
  ].join("\n");
}

export class YanitYok extends Error {}

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

export function cevabiOku(girdi: unknown, bulunan: Set<string>): Pick<Degerlendirme, "puan" | "aciklama" | "ozet" | "riskler" | "kaynaklar"> {
  const g = (girdi ?? {}) as Record<string, unknown>;
  if (typeof g.puan !== "number" || !Number.isFinite(g.puan)) throw new YanitYok("Puan gelmedi");
  const kaynaklar: Kaynak[] = (Array.isArray(g.kaynaklar) ? g.kaynaklar : [])
    .map((k) => k as Record<string, unknown>)
    .map((k) => ({ baslik: METIN(k.baslik), url: METIN(k.url), tarih: METIN(k.tarih) }))
    .filter((k) => k.url && bulunan.has(k.url))
    .slice(0, 5);
  return {
    puan: SINIRLA(g.puan, 0, 100, 50),
    aciklama: METIN(g.aciklama),
    ozet: METIN(g.ozet),
    riskler: (Array.isArray(g.riskler) ? g.riskler : []).map(METIN).filter(Boolean).slice(0, 3),
    kaynaklar,
  };
}

/** Claude'a sorar; degerlendir çağrısı gelene kadar (en çok birkaç tur) sürdürür. */
export async function yorumla(istemci: ClaudeIstemci, b: Baglam): Promise<Degerlendirme> {
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
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: EN_COK_ARAMA }, PUAN_ARACI],
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
    const arac = m.content.find((x) => x.type === "tool_use" && x.name === PUAN_ARACI.name);
    if (arac && arac.type === "tool_use") {
      return { ...cevabiOku(arac.input, aramaBaglantilari(bloklar)), model, arama, girdiToken: girdi, ciktiToken: cikti, maliyet };
    }
    if (m.stop_reason === "max_tokens") throw new YanitYok("Yanıt yarıda kesildi (max_tokens)");
    mesajlar.push({ role: "assistant", content: m.content });
    if (m.stop_reason === "pause_turn") continue; // sunucu tarafı arama döngüsü sürüyor: aynen devam
    if (hatirlatildi) break;
    hatirlatildi = true;
    mesajlar.push({ role: "user", content: "Lütfen puanını ve açıklamanı degerlendir aracıyla bildir." });
  }
  throw new YanitYok("Claude degerlendir aracını çağırmadı");
}

/** Gerçek istemci (ANTHROPIC_API_KEY ortam değişkeninden). */
export async function istemciKur(): Promise<ClaudeIstemci> {
  const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
  const c: Anthropic = new AnthropicSdk({ maxRetries: 4, timeout: 15 * 60_000 });
  return c;
}
