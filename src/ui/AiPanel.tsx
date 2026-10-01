/**
 * Yapay zekâ yorumu: altında haftalık UT Bot sinyallerini Claude'un haberlerle yorumladığı ileriye dönük kâğıt
 * denemenin kaydı (GitHub "ai-yorum" dalı). Son haftanın yorumu, iki defterin puanı ve geçmiş haftalar.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AI_KAYIT_URL, puanla, kayitMi, type Defter, type Hafta, type Kayit, type Sinyal, type Yon } from "../ai/yorum";
import { pct } from "./StrategyPanel";
import { Sheet } from "./Sheet";

type Durum = { tur: "yukleniyor" } | { tur: "yok" } | { tur: "hata"; mesaj: string } | { tur: "tamam"; kayit: Kayit };

const tarih = (ms: number) => new Date(ms).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const zaman = (ms: number) =>
  new Date(ms).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" });
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "");
const SINYAL: Record<Sinyal, string> = { al: "AL", sat: "SAT", yok: "Sinyal yok" };
const YON: Record<Yon, string> = { yukari: "Yukarı", asagi: "Aşağı", kararsiz: "Kararsız" };

async function kayitGetir(): Promise<Durum> {
  try {
    const r = await fetch(AI_KAYIT_URL, { cache: "no-store" });
    if (r.status === 404) return { tur: "yok" };
    if (!r.ok) return { tur: "hata", mesaj: `HTTP ${r.status}` };
    const x: unknown = await r.json();
    return kayitMi(x) ? { tur: "tamam", kayit: x } : { tur: "hata", mesaj: "beklenmeyen kayıt biçimi" };
  } catch (e) {
    return { tur: "hata", mesaj: e instanceof Error ? e.message : String(e) };
  }
}

function Rozet({ children, renk }: { children: ReactNode; renk: "up" | "down" | "warn" | "muted" }) {
  const c = { up: "bg-up/15 text-up", down: "bg-down/15 text-down", warn: "bg-warn/15 text-warn", muted: "bg-panel-2 text-muted" }[renk];
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${c}`}>{children}</span>;
}

function sayilma(k: Kayit, h: Hafta): ReactNode {
  if (h.hafta < k.baslangic) return <Rozet renk="muted">Deneme öncesi</Rozet>;
  if (!h.zamaninda) return <Rozet renk="warn">Geç verildi · sayılmaz</Rozet>;
  return null;
}

function SonHafta({ k, h }: { k: Kayit; h: Hafta }) {
  const a = h.ai;
  return (
    <section className="space-y-2 px-3 py-3" data-testid="ai-son">
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="text-[14px] font-semibold">{tarih(h.hafta)} haftası</h3>
        {sayilma(k, h)}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md bg-panel-2/60 px-2.5 py-2">
          <div className="text-[11px] text-muted">UT Bot (geçen hafta kapanışı)</div>
          <div className={`text-[15px] font-semibold ${h.sinyal === "al" ? "text-up" : h.sinyal === "sat" ? "text-down" : ""}`}>{SINYAL[h.sinyal]}</div>
          <div className="text-[11px] text-muted">{h.pozisyon ? "Pozisyon: long" : "Pozisyon yok"} · açılış {h.acilis.toFixed(2)}</div>
        </div>
        <div className="rounded-md bg-panel-2/60 px-2.5 py-2" data-testid="ai-karar">
          <div className="text-[11px] text-muted">{h.sinyal === "al" ? "Yapay zekâ kararı" : "Yön tahmini (bu hafta)"}</div>
          {!a ? (
            <div className="text-[15px] font-semibold text-subtle">—</div>
          ) : h.sinyal === "al" ? (
            <>
              <div className={`text-[15px] font-semibold ${a.karar === "atla" ? "text-down" : "text-up"}`}>
                {a.karar === "atla" ? "Atla" : a.karar === "al" ? "Uygula (al)" : "Karar yok (uygulanır)"}
              </div>
              <div className="text-[11px] text-muted">
                güven %{a.guven} · yön: {YON[a.yon]} %{a.yonGuveni}
              </div>
            </>
          ) : (
            <>
              <div className={`text-[15px] font-semibold ${a.yon === "yukari" ? "text-up" : a.yon === "asagi" ? "text-down" : ""}`}>{YON[a.yon]}</div>
              <div className="text-[11px] text-muted">güven %{a.yonGuveni}</div>
            </>
          )}
        </div>
      </div>
      {a ? (
        <div className="space-y-2 text-[13px] leading-relaxed">
          <p>
            <b>Haberler:</b> {a.ozet}
          </p>
          <p>
            <b>Gerekçe:</b> {a.gerekce}
          </p>
          {a.riskler.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-muted">
              {a.riskler.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {a.kaynaklar.length > 0 && (
            <ul className="space-y-0.5 text-[12px]" data-testid="ai-kaynaklar">
              {a.kaynaklar.map((s, i) => (
                <li key={i} className="truncate">
                  <a className="text-accent underline-offset-2 hover:underline" href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.baslik || s.url}
                  </a>
                  {s.tarih && <span className="text-subtle"> · {s.tarih}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="text-[11px] text-subtle">
            {a.model} · {a.arama} arama · ~${a.maliyet.toFixed(2)} · {zaman(h.zaman)}
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted" data-testid="ai-hata">
          Yapay zekâ yorumu yok{h.aiHata ? `: ${h.aiHata}` : ""}
        </p>
      )}
    </section>
  );
}

function DefterKutusu({ ad, d, testId }: { ad: string; d: Defter; testId: string }) {
  return (
    <div className="rounded-md bg-panel-2/60 px-2.5 py-2" data-testid={testId}>
      <div className="text-[11px] text-muted">{ad}</div>
      <div className={`text-[15px] font-semibold tabular-nums ${tone(d.getiri)}`}>{pct(d.getiri)}</div>
      <div className="text-[11px] text-muted tabular-nums">
        {d.kazanan}/{d.islem} kârlı{d.acik ? ` · açık ${pct(d.acik.getiri)}` : ""}
      </div>
    </div>
  );
}

function Puanlar({ k }: { k: Kayit }) {
  const p = puanla(k);
  return (
    <section className="space-y-2 border-t border-line px-3 py-3" data-testid="ai-puan">
      <h3 className="text-[13px] font-semibold">Puan · {tarih(k.baslangic)}'ten beri</h3>
      <div className="grid grid-cols-2 gap-2">
        <DefterKutusu ad="UT Bot (olduğu gibi)" d={p.duz} testId="ai-defter-duz" />
        <DefterKutusu ad="Yapay zekâ süzgeçli" d={p.ai} testId="ai-defter-ai" />
      </div>
      <div className="text-[12px] text-muted">
        Atlanan işlem: {p.atlanan.islem}
        {p.atlanan.islem > 0 && ` (${p.atlanan.zararli} tanesi zararlıydı, toplam ${pct(p.atlanan.getiri)})`} · Yön tahmini:{" "}
        {p.yon.tahmin ? `${p.yon.dogru}/${p.yon.tahmin} doğru` : "henüz yok"}
      </div>
    </section>
  );
}

function Gecmis({ k }: { k: Kayit }) {
  const hs = [...k.haftalar].reverse().slice(1);
  if (!hs.length) return null;
  return (
    <section className="border-t border-line px-3 py-3" data-testid="ai-gecmis">
      <h3 className="mb-1 text-[13px] font-semibold">Önceki haftalar</h3>
      <ul className="divide-y divide-line text-[12px]">
        {hs.map((h) => {
          const deg = h.kapanis === null ? Number.NaN : (h.kapanis / h.acilis - 1) * 100;
          const a = h.ai;
          const dogru = a && a.yon !== "kararsiz" && Number.isFinite(deg) ? (a.yon === "yukari") === deg > 0 : null;
          return (
            <li key={h.hafta} className="flex items-center gap-2 py-1.5">
              <span className="w-24 shrink-0 tabular-nums text-muted">{tarih(h.hafta)}</span>
              <span className="w-14 shrink-0 font-medium">{h.sinyal === "yok" ? "—" : SINYAL[h.sinyal]}</span>
              <span className="min-w-0 flex-1 truncate">
                {!a ? <span className="text-subtle">yorum yok</span> : `${h.sinyal === "al" ? (a.karar === "atla" ? "Atla · " : "Uygula · ") : ""}${YON[a.yon]}`}
                {dogru !== null && <span className={dogru ? "text-up" : "text-down"}>{dogru ? " ✓" : " ✗"}</span>}
                {(h.hafta < k.baslangic || !h.zamaninda) && <span className="text-subtle"> (sayılmaz)</span>}
              </span>
              <span className={`shrink-0 tabular-nums ${tone(deg)}`}>{Number.isFinite(deg) ? pct(deg) : "…"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AiPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [d, setD] = useState<Durum>({ tur: "yukleniyor" });
  useEffect(() => {
    if (!open) return;
    let iptal = false;
    setD({ tur: "yukleniyor" });
    void kayitGetir().then((x) => !iptal && setD(x));
    return () => {
      iptal = true;
    };
  }, [open]);
  const son = d.tur === "tamam" ? d.kayit.haftalar.at(-1) : undefined;
  return (
    <Sheet open={open} title="Yapay zekâ yorumu · altın, haftalık UT Bot" onClose={onClose} testId="ai-sheet">
      <p className="border-b border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
        Her pazartesi haftalık mum kapanınca UT Bot'un (varsayılan ayarlar, yalnız long; PAXG/USDT) sinyalini Claude son haftanın
        haberleriyle yorumlar: Al sinyalinde "uygula" ya da "atla" der, her hafta yön tahmini yapar. Gerçek para yok; iki kâğıt
        defter karşılaştırılır.
      </p>
      {d.tur === "yukleniyor" && <p className="px-3 py-6 text-center text-[13px] text-muted">Yükleniyor…</p>}
      {(d.tur === "yok" || (d.tur === "tamam" && !son)) && (
        <p className="px-3 py-6 text-center text-[13px] text-muted" data-testid="ai-bos">
          Henüz kayıt yok. İlk yorum pazartesi 03:20'de (TSİ) gelir.
        </p>
      )}
      {d.tur === "hata" && (
        <p className="px-3 py-6 text-center text-[13px] text-down" data-testid="ai-yukleme-hatasi">
          Kayıt okunamadı: {d.mesaj}
        </p>
      )}
      {d.tur === "tamam" && son && (
        <>
          <SonHafta k={d.kayit} h={son} />
          <Puanlar k={d.kayit} />
          <Gecmis k={d.kayit} />
          <p className="border-t border-line px-3 py-2 text-[11px] text-subtle">Son güncelleme: {zaman(d.kayit.guncelleme)}</p>
        </>
      )}
    </Sheet>
  );
}
