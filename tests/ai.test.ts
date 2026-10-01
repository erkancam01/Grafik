import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { AI_BASLANGIC, kayitOku, puanAdi, puanla, yeniKayit, ZAMANINDA_MS, type Degerlendirme, type Kayit, type Olay, type Tf } from "../src/ai/yorum";
import type { BarsData } from "../src/pine/types";
import { MODEL, PUAN_ARACI, yorumla, YanitYok, type Baglam, type ClaudeIstemci } from "../tools/ai/claude";
import { calistir, utBotDurumu } from "../tools/ai/yorumcu";
import { barsFromCloses } from "./helpers";

const GUN = 86_400_000;
const HAFTA = 7 * GUN;
const PAZARTESI = Date.UTC(2025, 0, 6);
/** Oluşan mumun açılışı (haftalık ve günlük testlerde aynı pazartesi). */
const W = PAZARTESI + 41 * HAFTA;

/** Son mum oluşan mum (açılışı = önceki kapanış); son mumun açılışı W. */
function mumlar(closes: number[], tf: Tf): BarsData {
  const sn = tf === "1w" ? 604_800 : 86_400;
  const b = barsFromCloses(closes, sn, W - (closes.length - 1) * sn * 1000);
  b.symbol = "PAXGUSDT";
  b.lastRealtime = true;
  return b;
}
const dusus = (n: number) => Array.from({ length: n }, (_, i) => 3000 - 10 * i);
/** 40 mum düşüş, son kapanmış mumda sert yükseliş (Al), ardından oluşan mum. */
const AL = [...dusus(40), 2700, 2702];
/** Al'dan sonra 4 mum yükseliş, son kapanmış mumda sert düşüş (Sat). */
const SAT = [...dusus(40), 2700, 2720, 2740, 2760, 2780, 2600, 2598];
const YOK = [...dusus(41), 2590];

describe("UT Bot durumu (yalnız long)", () => {
  it("sinyal yok / Al / Sat ve işlem fiyatı oluşan mumun açılışı", () => {
    const yok = utBotDurumu(mumlar(YOK, "1w"));
    expect(yok.sinyal).toBe("yok");
    expect(yok.pozisyon).toBe(false);

    const al = utBotDurumu(mumlar(AL, "1d"));
    expect(al.sinyal).toBe("al");
    expect(al.zaman).toBe(W);
    expect(al.acikIslem).toEqual({ giris: W, girisFiyat: 2700 });
    expect(al.iz).toBeLessThan(2700);

    const sat = utBotDurumu(mumlar(SAT, "1w"));
    expect(sat.sinyal).toBe("sat");
    expect(sat.pozisyon).toBe(false);
    const son = sat.islemler.at(-1)!;
    expect(son).toMatchObject({ girisFiyat: 2700, cikis: W, cikisFiyat: 2600, acik: false });
    expect(son.getiri).toBeCloseTo((2600 / 2700 - 1) * 100 - 0.1, 1);
  });

  it("yeni mum yoksa hata verir", () => {
    const b = mumlar(AL, "1d");
    b.lastRealtime = false;
    expect(() => utBotDurumu(b)).toThrow(/Yeni mum/);
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
const arac = (input: Record<string, unknown>) => ({ type: "tool_use", id: "t1", name: "degerlendir", input });
const GIRDI = {
  puan: 35,
  aciklama: "Fed şahin, dolar güçleniyor; Al sinyaline katılmıyorum.",
  ozet: "Fed faiz indirimini erteledi.",
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
/** Her çağrıda aynı puanı veren sahte istemci. */
function sabit(puan: number) {
  const istekler: BetaMessageStreamParams[] = [];
  const istemci: ClaudeIstemci = {
    beta: {
      messages: {
        stream(p) {
          istekler.push(structuredClone(p));
          return { finalMessage: async () => mesaj("tool_use", [arac({ ...GIRDI, puan })]) };
        },
      },
    },
  };
  return { istemci, istekler };
}

const BAGLAM: Baglam = {
  simdi: W + 20 * 60_000,
  tf: "1d",
  zaman: W,
  sinyal: "al",
  pozisyon: true,
  acikIslem: { giris: W, girisFiyat: 2700 },
  acilis: 2700,
  oncekiKapanis: 2700,
  iz: 2650,
  mumlar: [{ zaman: W - GUN, acilis: 2610, yuksek: 2701, dusuk: 2609, kapanis: 2700 }],
};

describe("Claude puanı", () => {
  it("istek biçimi, pause_turn'den devam, puan ve kaynak süzme", async () => {
    const { istemci, istekler } = sahte([mesaj("pause_turn", ARAMA, kullanim(1000, 200, 1)), mesaj("tool_use", [arac(GIRDI)])]);
    const c = await yorumla(istemci, BAGLAM);
    expect(istekler).toHaveLength(2);
    const p = istekler[0]!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.tools).toEqual([{ type: "web_search_20260209", name: "web_search", max_uses: 6 }, PUAN_ARACI]);
    expect(p.tool_choice).toBeUndefined();
    const ilk = p.messages[0]!.content as string;
    expect(ilk).toContain("Grafik: Günlük");
    expect(ilk).toContain("UT Bot sinyali: AL");
    expect(ilk).toContain("0–100 al-sat puanını");
    expect(ilk).toContain(`| ${new Date(W - GUN).toISOString().slice(0, 10)} | 2610.00 | 2701.00 | 2609.00 | 2700.00 |`);
    // pause_turn: asistan turu aynen geri gönderilir, kullanıcı mesajı eklenmez
    expect(istekler[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(c).toMatchObject({ puan: 35, aciklama: GIRDI.aciklama, riskler: ["Jeopolitik gerginlik"], model: MODEL, arama: 1 });
    expect(c.kaynaklar).toEqual([{ baslik: "Altın rekor kırdı", url: "https://ornek.com/altin", tarih: "2026-10-03" }]);
    expect(c.girdiToken).toBe(2000);
    expect(c.ciktiToken).toBe(400);
    expect(c.maliyet).toBeCloseTo((2 * (1000 * 4 + 200 * 20)) / 1e6 + 0.01, 6);
  });

  it("haftalık görünüm istemi; araç çağrılmazsa bir kez hatırlatır; puan 0–100'e sıkıştırılır", async () => {
    const { istemci, istekler } = sahte([mesaj("end_turn", [{ type: "text", text: "Haberlere baktım." }]), mesaj("tool_use", [arac({ ...GIRDI, puan: 140 })])]);
    const c = await yorumla(istemci, { ...BAGLAM, tf: "1w", sinyal: "yok" });
    expect(istekler[0]!.messages[0]!.content as string).toContain("bu hafta yeni sinyal yok");
    expect(istekler[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(c.puan).toBe(100);
  });

  it("ret, puansız yanıt ve araçsız bitiş hata verir", async () => {
    const ret = { ...mesaj("refusal", []), stop_details: { type: "refusal", category: "general_harms", explanation: null } } as unknown as BetaMessage;
    await expect(yorumla(sahte([ret]).istemci, BAGLAM)).rejects.toThrow(YanitYok);
    await expect(yorumla(sahte([mesaj("tool_use", [arac({ ...GIRDI, puan: "yüksek" })])]).istemci, BAGLAM)).rejects.toThrow(/Puan/);
    const metin = () => mesaj("end_turn", [{ type: "text", text: "..." }]);
    await expect(yorumla(sahte([metin(), metin()]).istemci, BAGLAM)).rejects.toThrow(/degerlendir/);
  });
});

describe("günlük iş", () => {
  const k0 = (): Kayit => ({ ...yeniKayit(), baslangic: PAZARTESI });

  it("günlük Al sinyali ve yeni hafta: iki puan; aynı gün yeniden sorulmaz; ertesi gün kapanış yazılır", async () => {
    const { istemci, istekler } = sabit(35);
    const a = await calistir({ kayit: k0(), mumlar: { "1d": mumlar(AL, "1d"), "1w": mumlar(YOK, "1w") }, simdi: W + 20 * 60_000, istemci, aiYokNedeni: "-" });
    expect(istekler).toHaveLength(2);
    expect(a.yeni.map((e) => [e.tf, e.sinyal])).toEqual([
      ["1w", "yok"],
      ["1d", "al"],
    ]);
    expect(a.kayit.olaylar.every((e) => e.zamaninda && e.ai?.puan === 35)).toBe(true);
    expect(istekler.map((p) => (p.messages[0]!.content as string).split("\n")[1])).toEqual([
      expect.stringContaining("Haftalık"),
      expect.stringContaining("Günlük"),
    ]);

    const b = await calistir({ kayit: a.kayit, mumlar: { "1d": mumlar(AL, "1d"), "1w": mumlar(YOK, "1w") }, simdi: W + 5 * 3_600_000, istemci, aiYokNedeni: "-" });
    expect(istekler).toHaveLength(2);
    expect(b.yeni).toEqual([]);

    // ertesi gün: günlükte yeni sinyal yok (olay açılmaz), dünkü günlük olayın kapanışı yazılır
    const ertesi = mumlar([...AL.slice(1, -1), 2720, 2730], "1d");
    ertesi.time = ertesi.time.map((t) => t + GUN);
    const c = await calistir({ kayit: b.kayit, mumlar: { "1d": ertesi, "1w": mumlar(YOK, "1w") }, simdi: W + GUN + 60_000, istemci: null, aiYokNedeni: "anahtar yok" });
    expect(c.yeni).toEqual([]);
    expect(c.kayit.olaylar.find((e) => e.tf === "1d")!.kapanis).toBe(2720);
    // puanı 50'nin altında olan Al işlemi yapay zekâ defterine girmez
    const p = puanla(c.kayit);
    expect(p.tf["1d"].duz.acik?.giris).toBe(W);
    expect(p.tf["1d"].ai.acik).toBeNull();
  });

  it("yorum alınamadıysa sonraki çalışmada yeniden sorulur; geç karar sayılmaz", async () => {
    const m = { "1d": mumlar(YOK, "1d"), "1w": mumlar(AL, "1w") };
    const a = await calistir({ kayit: k0(), mumlar: m, simdi: W + 60_000, istemci: null, aiYokNedeni: "anahtar yok" });
    expect(a.kayit.olaylar).toHaveLength(1);
    expect(a.kayit.olaylar[0]).toMatchObject({ tf: "1w", sinyal: "al", ai: null, aiHata: "anahtar yok" });
    const { istemci, istekler } = sabit(70);
    const b = await calistir({ kayit: a.kayit, mumlar: m, simdi: W + ZAMANINDA_MS + 60_000, istemci, aiYokNedeni: "-" });
    expect(istekler).toHaveLength(1);
    expect(b.kayit.olaylar[0]).toMatchObject({ zamaninda: false, aiHata: null, ai: expect.objectContaining({ puan: 70 }) });
  });

  it("API hatası kayda yazılır", async () => {
    const istemci: ClaudeIstemci = {
      beta: { messages: { stream: () => ({ finalMessage: async () => Promise.reject(new Error("401 invalid x-api-key")) }) } },
    };
    const a = await calistir({ kayit: k0(), mumlar: { "1d": mumlar(SAT, "1d"), "1w": mumlar(YOK, "1w") }, simdi: W + 60_000, istemci, aiYokNedeni: "-" });
    expect(a.kayit.olaylar.map((e) => [e.tf, e.sinyal, e.ai])).toEqual([
      ["1w", "yok", null],
      ["1d", "sat", null],
    ]);
    expect(a.kayit.olaylar.every((e) => e.aiHata?.includes("401"))).toBe(true);
  });
});

describe("puanlama ve kayıt", () => {
  const T = AI_BASLANGIC;
  const ai = (puan: number): Degerlendirme => ({ puan, aciklama: "", ozet: "", riskler: [], kaynaklar: [], model: MODEL, arama: 0, girdiToken: 0, ciktiToken: 0, maliyet: 0 });
  const olay = (tf: Tf, i: number, o: Partial<Olay>): Olay => ({
    tf,
    zaman: T + i * (tf === "1w" ? HAFTA : GUN),
    sinyal: "yok",
    karar: T + i * (tf === "1w" ? HAFTA : GUN) + 60_000,
    zamaninda: true,
    pozisyon: false,
    acilis: 100,
    oncekiKapanis: 100,
    iz: 90,
    ai: ai(50),
    aiHata: null,
    kapanis: null,
    ...o,
  });

  it("günlük defterler (eşik 50), atlananlar ve haftalık yön isabeti", () => {
    const k: Kayit = {
      ...yeniKayit(),
      olaylar: [
        olay("1w", -1, { ai: ai(80), kapanis: 110 }), // başlangıçtan önce: sayılmaz
        olay("1w", 0, { ai: ai(70), kapanis: 105 }), // doğru
        olay("1w", 1, { ai: ai(30), acilis: 105, kapanis: 106 }), // yanlış
        olay("1w", 2, { ai: ai(52), kapanis: 90 }), // 45-55 arası: sayılmaz
        olay("1w", 3, { ai: ai(20), zamaninda: false, kapanis: 80 }), // geç: sayılmaz
        olay("1d", 1, { sinyal: "al", ai: ai(65) }),
        olay("1d", 5, { sinyal: "al", ai: ai(40) }), // atlanır
        olay("1d", 9, { sinyal: "al", ai: ai(30), zamaninda: false }), // geç: alınır
      ],
      islemler: {
        "1w": [],
        "1d": [
          { giris: T - 2 * GUN, girisFiyat: 1, cikis: T, cikisFiyat: 1, getiri: 50, acik: false },
          { giris: T + GUN, girisFiyat: 100, cikis: T + 3 * GUN, cikisFiyat: 105, getiri: 5, acik: false },
          { giris: T + 5 * GUN, girisFiyat: 100, cikis: T + 7 * GUN, cikisFiyat: 97, getiri: -3, acik: false },
          { giris: T + 9 * GUN, girisFiyat: 100, cikis: T + 11 * GUN, cikisFiyat: 104, getiri: 4, acik: false },
          { giris: T + 12 * GUN, girisFiyat: 100, cikis: null, cikisFiyat: 102, getiri: 2, acik: true },
        ],
      },
    };
    const p = puanla(k);
    const g = p.tf["1d"];
    expect(g.duz).toMatchObject({ islem: 3, kazanan: 2 });
    expect(g.duz.getiri).toBeCloseTo((1.05 * 0.97 * 1.04 - 1) * 100, 9);
    expect(g.ai).toMatchObject({ islem: 2, kazanan: 2 });
    expect(g.ai.getiri).toBeCloseTo((1.05 * 1.04 - 1) * 100, 9);
    expect(g.ai.acik?.giris).toBe(T + 12 * GUN);
    expect(g.atlanan).toMatchObject({ islem: 1, zararli: 1 });
    expect(p.tf["1w"].duz.islem).toBe(0);
    expect(p.hafta).toEqual({ tahmin: 2, dogru: 1 });
  });

  it("puan adları", () => {
    expect([90, 70, 50, 35, 10].map((x) => puanAdi(x).ad)).toEqual(["Güçlü al", "Al", "Nötr", "Sat", "Güçlü sat"]);
  });

  it("kayıt okuma: v2 olduğu gibi, v1 haftalık olaylara çevrilir, bozuk kayıt reddedilir", () => {
    const v2 = yeniKayit();
    expect(kayitOku(v2)).toBe(v2);
    const v1 = {
      surum: 1,
      sembol: "PAXGUSDT",
      baslangic: T,
      guncelleme: 5,
      haftalar: [{ hafta: W, zaman: W + 1, zamaninda: false, sinyal: "yok", pozisyon: false, acilis: 1, oncekiKapanis: 1, iz: 2, ai: null, aiHata: "ANTHROPIC_API_KEY tanımlı değil", kapanis: null }],
      islemler: [],
    };
    const y = kayitOku(v1)!;
    expect(y.surum).toBe(2);
    expect(y.olaylar).toEqual([
      { tf: "1w", zaman: W, sinyal: "yok", karar: W + 1, zamaninda: false, pozisyon: false, acilis: 1, oncekiKapanis: 1, iz: 2, ai: null, aiHata: "ANTHROPIC_API_KEY tanımlı değil", kapanis: null },
    ]);
    expect(y.islemler).toEqual({ "1d": [], "1w": [] });
    expect(kayitOku({ surum: 3 })).toBeNull();
    expect(kayitOku(null)).toBeNull();
  });
});
