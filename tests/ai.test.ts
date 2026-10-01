import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { AI_BASLANGIC, puanla, yeniKayit, ZAMANINDA_MS, type AiCevap, type Hafta, type Kayit } from "../src/ai/yorum";
import type { BarsData } from "../src/pine/types";
import { KARAR_ARACI, MODEL, yorumla, YanitYok, type Baglam, type ClaudeIstemci } from "../tools/ai/claude";
import { calistir, utBotDurumu } from "../tools/ai/haftalik";
import { barsFromCloses } from "./helpers";

const HAFTA = 7 * 86_400_000;
const PAZARTESI = Date.UTC(2025, 0, 6);

/** Haftalık mumlar; son mum oluşan hafta (açılışı = önceki kapanış). */
function haftalik(closes: number[]): BarsData {
  const b = barsFromCloses(closes, 604_800, PAZARTESI);
  b.symbol = "PAXGUSDT";
  b.lastRealtime = true;
  return b;
}
const dusus = (n: number) => Array.from({ length: n }, (_, i) => 3000 - 10 * i);
/** 40 hafta düşüş, son kapanmış haftada sert yükseliş (Al), ardından oluşan hafta. */
const AL = [...dusus(40), 2700, 2702];
/** Al'dan sonra 4 hafta yükseliş, son kapanmış haftada sert düşüş (Sat). */
const SAT = [...dusus(40), 2700, 2720, 2740, 2760, 2780, 2600, 2598];

describe("UT Bot haftalık durum (yalnız long)", () => {
  it("sinyal yok / Al / Sat ve işlem fiyatı oluşan haftanın açılışı", () => {
    const yok = utBotDurumu(haftalik([...dusus(41), 2590]));
    expect(yok.sinyal).toBe("yok");
    expect(yok.pozisyon).toBe(false);

    const al = utBotDurumu(haftalik(AL));
    expect(al.sinyal).toBe("al");
    expect(al.pozisyon).toBe(true);
    expect(al.hafta).toBe(PAZARTESI + 41 * HAFTA);
    expect(al.acikIslem).toEqual({ giris: al.hafta, girisFiyat: 2700 });
    expect(al.acilis).toBe(2700);
    expect(al.oncekiKapanis).toBe(2700);
    expect(al.iz).toBeLessThan(2700);

    const sat = utBotDurumu(haftalik(SAT));
    expect(sat.sinyal).toBe("sat");
    expect(sat.pozisyon).toBe(false);
    const son = sat.islemler.at(-1)!;
    expect(son).toMatchObject({ giris: PAZARTESI + 41 * HAFTA, girisFiyat: 2700, cikis: PAZARTESI + 46 * HAFTA, cikisFiyat: 2600, acik: false });
    expect(son.getiri).toBeCloseTo((2600 / 2700 - 1) * 100 - 0.1, 1);
  });

  it("yeni hafta mumu yoksa hata verir", () => {
    const b = haftalik(AL);
    b.lastRealtime = false;
    expect(() => utBotDurumu(b)).toThrow(/Yeni haftanın mumu/);
  });
});

// ---------------------------------------------------------------- sahte Claude
const kullanim = (girdi: number, cikti: number, arama = 0) => ({
  input_tokens: girdi,
  output_tokens: cikti,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: arama, web_fetch_requests: 0 },
});
const mesaj = (stop: string, content: unknown[], u = kullanim(1000, 200)) =>
  ({ id: "m", type: "message", role: "assistant", model: MODEL, content, stop_reason: stop, stop_details: null, usage: u }) as unknown as BetaMessage;
const ARAMA = [
  { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "gold price news" } },
  {
    type: "web_search_tool_result",
    tool_use_id: "s1",
    content: [{ type: "web_search_result", url: "https://ornek.com/altin", title: "Altın rekor kırdı", encrypted_content: "x", page_age: "2 gün" }],
  },
];
const karar = (input: Record<string, unknown>) => ({ type: "tool_use", id: "t1", name: "karar_ver", input });
const GIRDI = {
  karar: "atla",
  guven: 70,
  yon: "asagi",
  yon_guveni: 60,
  ozet: "Fed faiz indirimini erteledi.",
  gerekce: "Dolar güçleniyor.",
  riskler: ["Jeopolitik gerginlik"],
  kaynaklar: [
    { baslik: "Altın rekor kırdı", url: "https://ornek.com/altin", tarih: "2026-10-03" },
    { baslik: "Uydurma", url: "https://uydurma.example/x", tarih: "" },
  ],
};

function sahte(cevaplar: BetaMessage[]) {
  const istekler: BetaMessageStreamParams[] = [];
  const istemci: ClaudeIstemci = {
    beta: {
      messages: {
        stream(p) {
          istekler.push(structuredClone(p));
          const m = cevaplar.shift();
          if (!m) throw new Error("beklenmeyen çağrı");
          return { finalMessage: async () => m };
        },
      },
    },
  };
  return { istemci, istekler };
}

const BAGLAM: Baglam = {
  simdi: PAZARTESI + 41 * HAFTA + 20 * 60_000,
  hafta: PAZARTESI + 41 * HAFTA,
  sinyal: "al",
  pozisyon: true,
  acikIslem: { giris: PAZARTESI + 41 * HAFTA, girisFiyat: 2700 },
  acilis: 2700,
  oncekiKapanis: 2700,
  iz: 2650,
  mumlar: [{ zaman: PAZARTESI + 40 * HAFTA, acilis: 2610, yuksek: 2701, dusuk: 2609, kapanis: 2700 }],
};

describe("Claude yorumcusu", () => {
  it("istek biçimi, pause_turn'den devam, karar ve kaynak süzme", async () => {
    const { istemci, istekler } = sahte([mesaj("pause_turn", ARAMA, kullanim(1000, 200, 1)), mesaj("tool_use", [karar(GIRDI)])]);
    const c = await yorumla(istemci, BAGLAM);
    expect(istekler).toHaveLength(2);
    const p = istekler[0]!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 6 }, KARAR_ARACI]);
    expect(p.tool_choice).toBeUndefined();
    const ilk = p.messages[0]!.content as string;
    expect(ilk).toContain("UT Bot sinyali: AL");
    expect(ilk).toContain("| 2025-10-13 | 2610.00 | 2701.00 | 2609.00 | 2700.00 |");
    // pause_turn: asistan turu aynen geri gönderilir, kullanıcı mesajı eklenmez
    expect(istekler[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c).toMatchObject({ karar: "atla", guven: 70, yon: "asagi", yonGuveni: 60, riskler: ["Jeopolitik gerginlik"], model: MODEL, arama: 1 });
    expect(c.kaynaklar).toEqual([{ baslik: "Altın rekor kırdı", url: "https://ornek.com/altin", tarih: "2026-10-03" }]);
    expect(c.girdiToken).toBe(2000);
    expect(c.ciktiToken).toBe(400);
    expect(c.maliyet).toBeCloseTo((2 * (1000 * 4 + 200 * 20)) / 1e6 + 0.01, 6);
  });

  it("araç çağrılmazsa bir kez hatırlatır; sinyal Al değilse karar 'yok'; sınırlar", async () => {
    const { istemci, istekler } = sahte([
      mesaj("end_turn", [{ type: "text", text: "Haberlere baktım." }]),
      mesaj("tool_use", [karar({ ...GIRDI, karar: "atla", guven: 150, yon_guveni: 20 })]),
    ]);
    const c = await yorumla(istemci, { ...BAGLAM, sinyal: "yok" });
    expect(istekler[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(c.karar).toBe("yok");
    expect(c.guven).toBe(100);
    expect(c.yonGuveni).toBe(50);
  });

  it("ret ve araçsız bitiş hata verir", async () => {
    const ret = { ...mesaj("refusal", []), stop_details: { type: "refusal", category: "general_harms", explanation: null } } as unknown as BetaMessage;
    await expect(yorumla(sahte([ret]).istemci, BAGLAM)).rejects.toThrow(YanitYok);
    const metin = () => mesaj("end_turn", [{ type: "text", text: "..." }]);
    await expect(yorumla(sahte([metin(), metin()]).istemci, BAGLAM)).rejects.toThrow(/karar_ver/);
  });
});

describe("haftalık iş", () => {
  const W = PAZARTESI + 41 * HAFTA;

  it("yeni hafta: zamanında karar kaydedilir; aynı hafta yeniden sorulmaz; ertesi hafta kapanış yazılır", async () => {
    const { istemci, istekler } = sahte([mesaj("tool_use", [...ARAMA, karar(GIRDI)])]);
    const k0 = { ...yeniKayit(), baslangic: PAZARTESI };
    const a = await calistir({ kayit: k0, mumlar: haftalik(AL), simdi: W + 20 * 60_000, istemci, aiYokNedeni: "-" });
    expect(istekler).toHaveLength(1);
    expect(a.hafta).toMatchObject({ hafta: W, sinyal: "al", pozisyon: true, zamaninda: true, acilis: 2700, kapanis: null, aiHata: null });
    expect(a.hafta.ai?.karar).toBe("atla");
    expect(k0.haftalar).toHaveLength(0); // girdi kaydı değişmez

    const b = await calistir({ kayit: a.kayit, mumlar: haftalik(AL), simdi: W + 5 * 3_600_000, istemci, aiYokNedeni: "-" });
    expect(istekler).toHaveLength(1);
    expect(b.kayit.haftalar).toHaveLength(1);

    const c = await calistir({ kayit: b.kayit, mumlar: haftalik([...AL.slice(0, -1), 2720, 2730]), simdi: W + HAFTA + 60_000, istemci: null, aiYokNedeni: "anahtar yok" });
    expect(c.kayit.haftalar.map((h) => [h.hafta, h.kapanis])).toEqual([
      [W, 2720],
      [W + HAFTA, null],
    ]);
    expect(c.hafta.aiHata).toBe("anahtar yok");
    // atlanan işlem yapay zekâ defterine girmez
    const p = puanla(c.kayit);
    expect(p.duz.acik?.giris).toBe(W);
    expect(p.ai.acik).toBeNull();
  });

  it("yorum alınamadıysa sonraki çalışmada yeniden sorulur; geç karar sayılmaz", async () => {
    const a = await calistir({ kayit: yeniKayit(), mumlar: haftalik(AL), simdi: W + 60_000, istemci: null, aiYokNedeni: "anahtar yok" });
    expect(a.hafta.ai).toBeNull();
    const { istemci, istekler } = sahte([mesaj("tool_use", [karar(GIRDI)])]);
    const b = await calistir({ kayit: a.kayit, mumlar: haftalik(AL), simdi: W + ZAMANINDA_MS + 60_000, istemci, aiYokNedeni: "-" });
    expect(istekler).toHaveLength(1);
    expect(b.hafta.zamaninda).toBe(false);
    expect(b.hafta.ai?.karar).toBe("atla");
    expect(b.hafta.aiHata).toBeNull();
  });

  it("API hatası kayda yazılır", async () => {
    const istemci: ClaudeIstemci = {
      beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new Error("401 invalid x-api-key")) }) } },
    };
    const a = await calistir({ kayit: yeniKayit(), mumlar: haftalik(AL), simdi: W + 60_000, istemci, aiYokNedeni: "-" });
    expect(a.hafta.ai).toBeNull();
    expect(a.hafta.aiHata).toContain("401");
  });
});

describe("puanlama", () => {
  const T = AI_BASLANGIC;
  const ai = (karar: AiCevap["karar"], yon: AiCevap["yon"] = "kararsiz"): AiCevap => ({
    karar,
    guven: 60,
    yon,
    yonGuveni: 60,
    ozet: "",
    gerekce: "",
    riskler: [],
    kaynaklar: [],
    model: MODEL,
    arama: 0,
    girdiToken: 0,
    ciktiToken: 0,
    maliyet: 0,
  });
  const hafta = (i: number, o: Partial<Hafta>): Hafta => ({
    hafta: T + i * HAFTA,
    zaman: T + i * HAFTA + 60_000,
    zamaninda: true,
    sinyal: "yok",
    pozisyon: false,
    acilis: 100,
    oncekiKapanis: 100,
    iz: 90,
    ai: ai("yok"),
    aiHata: null,
    kapanis: null,
    ...o,
  });

  it("iki defter, atlanan işlemler ve yön isabeti", () => {
    const k: Kayit = {
      ...yeniKayit(),
      haftalar: [
        hafta(-1, { ai: ai("yok", "yukari"), kapanis: 110 }), // başlangıçtan önce: sayılmaz
        hafta(1, { sinyal: "al", ai: ai("al", "yukari"), kapanis: 105 }), // doğru
        hafta(5, { sinyal: "al", ai: ai("atla", "asagi"), kapanis: 104 }), // yanlış
        hafta(9, { sinyal: "al", ai: ai("atla", "yukari"), zamaninda: false, kapanis: 120 }), // geç: sayılmaz, işlem alınır
        hafta(10, { ai: ai("yok", "kararsiz"), kapanis: 90 }), // kararsız: sayılmaz
        hafta(12, { ai: ai("yok", "asagi") }), // kapanmadı
      ],
      islemler: [
        { giris: T - 2 * HAFTA, girisFiyat: 1, cikis: T, cikisFiyat: 1, getiri: 50, acik: false },
        { giris: T + HAFTA, girisFiyat: 100, cikis: T + 3 * HAFTA, cikisFiyat: 105, getiri: 5, acik: false },
        { giris: T + 5 * HAFTA, girisFiyat: 100, cikis: T + 7 * HAFTA, cikisFiyat: 97, getiri: -3, acik: false },
        { giris: T + 9 * HAFTA, girisFiyat: 100, cikis: T + 11 * HAFTA, cikisFiyat: 104, getiri: 4, acik: false },
        { giris: T + 12 * HAFTA, girisFiyat: 100, cikis: null, cikisFiyat: 102, getiri: 2, acik: true },
      ],
    };
    const p = puanla(k);
    expect(p.duz).toMatchObject({ islem: 3, kazanan: 2 });
    expect(p.duz.getiri).toBeCloseTo((1.05 * 0.97 * 1.04 - 1) * 100, 9);
    expect(p.duz.acik?.giris).toBe(T + 12 * HAFTA);
    expect(p.ai).toMatchObject({ islem: 2, kazanan: 2 });
    expect(p.ai.getiri).toBeCloseTo((1.05 * 1.04 - 1) * 100, 9);
    expect(p.ai.acik?.giris).toBe(T + 12 * HAFTA);
    expect(p.atlanan).toMatchObject({ islem: 1, zararli: 1 });
    expect(p.atlanan.getiri).toBeCloseTo(-3, 9);
    expect(p.yon).toEqual({ tahmin: 2, dogru: 1 });
  });
});
