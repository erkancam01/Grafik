/**
 * Yapay zekâ yorumu: altında UT Bot (günlük ve haftalık) sinyal verdiğinde Claude'un verdiği 0–100 al-sat puanı ve
 * açıklaması; her pazartesi haftanın puanı. İleriye dönük kâğıt denemenin kaydı (GitHub "ai-yorum" dalı).
 */
import { useEffect, type ReactNode } from "react";
import type { AiDurum } from "../ai/useAiKayit";
import { ESIK, puanAdi, puanla, TF_AD, TF_LISTE, type Defter, type Kayit, type Olay, type Sinyal } from "../ai/yorum";
import { pct } from "./StrategyPanel";
import { Sheet } from "./Sheet";

export const tarih = (ms: number) => new Date(ms).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const zaman = (ms: number) =>
  new Date(ms).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" });
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "");
export const SINYAL_AD: Record<Sinyal, string> = { al: "AL", sat: "SAT", yok: "Sinyal yok" };
const RENK = { up: "text-up", down: "text-down", muted: "text-muted" } as const;

function Rozet({ children, renk }: { children: ReactNode; renk: "up" | "down" | "warn" | "muted" }) {
  const c = { up: "bg-up/15 text-up", down: "bg-down/15 text-down", warn: "bg-warn/15 text-warn", muted: "bg-panel-2 text-muted" }[renk];
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${c}`}>{children}</span>;
}

/** 0 (kesin sat) – 100 (kesin al) göstergesi. */
function PuanCubugu({ puan }: { puan: number }) {
  return (
    <div className="relative mt-1.5 h-1.5 rounded-full bg-linear-to-r from-down via-subtle to-up" aria-hidden="true">
      <span className="absolute -top-1 h-3.5 w-1 -translate-x-1/2 rounded bg-fg" style={{ left: `${puan}%` }} />
    </div>
  );
}

function sayilma(k: Kayit, e: Olay): ReactNode {
  if (e.zaman < k.baslangic) return <Rozet renk="muted">Deneme öncesi</Rozet>;
  if (!e.zamaninda) return <Rozet renk="warn">Geç verildi · sayılmaz</Rozet>;
  return null;
}

function Kart({ k, e, testId }: { k: Kayit; e: Olay; testId: string }) {
  const a = e.ai;
  const ad = a ? puanAdi(a.puan) : null;
  const baslik = e.sinyal === "yok" ? `${TF_AD[e.tf]} · ${tarih(e.zaman)} haftası` : `${TF_AD[e.tf]} ${SINYAL_AD[e.sinyal]} sinyali · ${tarih(e.zaman)}`;
  return (
    <section className="space-y-2 px-3 py-3" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-1.5">
        <h3 className="text-[14px] font-semibold">{baslik}</h3>
        {sayilma(k, e)}
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-md bg-panel-2/60 px-3 py-2">
        <div className="text-center" data-testid="ai-puan-degeri">
          <div className={`text-[26px] font-bold leading-none tabular-nums ${ad ? RENK[ad.renk] : "text-subtle"}`}>{a ? a.puan : "—"}</div>
          <div className="text-[11px] text-muted">/ 100</div>
        </div>
        <div className="min-w-0">
          <div className={`text-[14px] font-semibold ${ad ? RENK[ad.renk] : "text-subtle"}`}>{ad ? ad.ad : "Puan yok"}</div>
          <div className="text-[11px] text-muted">
            {e.sinyal === "yok" ? "Bu hafta UT Bot'ta yeni sinyal yok" : `UT Bot ${SINYAL_AD[e.sinyal]} · açılış ${e.acilis.toFixed(2)}`}
          </div>
          {a && <PuanCubugu puan={a.puan} />}
        </div>
      </div>
      {a ? (
        <div className="space-y-2 text-[13px] leading-relaxed">
          <p data-testid="ai-aciklama">
            <b>Açıklama:</b> {a.aciklama}
          </p>
          {a.ozet && (
            <p className="text-muted">
              <b className="text-fg">Haberler:</b> {a.ozet}
            </p>
          )}
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
            {a.model} · {a.arama} arama · ~${a.maliyet.toFixed(2)} · {zaman(e.karar)}
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-muted" data-testid="ai-hata">
          Yapay zekâ puanı yok{e.aiHata ? `: ${e.aiHata}` : ""}
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
      <h3 className="text-[13px] font-semibold">Kâğıt defterler · {tarih(k.baslangic)}'ten beri</h3>
      {TF_LISTE.map((tf) => {
        const q = p.tf[tf];
        return (
          <div key={tf} className="space-y-1">
            <div className="grid grid-cols-2 gap-2">
              <DefterKutusu ad={`${TF_AD[tf]} UT Bot`} d={q.duz} testId={`ai-defter-${tf}-duz`} />
              <DefterKutusu ad={`${TF_AD[tf]} · puan ${ESIK}+ olanlar`} d={q.ai} testId={`ai-defter-${tf}-ai`} />
            </div>
            {q.atlanan.islem > 0 && (
              <div className="text-[12px] text-muted">
                Puanı düşük diye atlanan: {q.atlanan.islem} ({q.atlanan.zararli} tanesi zararlıydı, toplam {pct(q.atlanan.getiri)})
              </div>
            )}
          </div>
        );
      })}
      <div className="text-[12px] text-muted">Haftalık puanın yön isabeti: {p.hafta.tahmin ? `${p.hafta.dogru}/${p.hafta.tahmin}` : "henüz yok"}</div>
    </section>
  );
}

function Gecmis({ k, gosterilen }: { k: Kayit; gosterilen: Set<Olay> }) {
  const es = [...k.olaylar].reverse().filter((e) => !gosterilen.has(e));
  if (!es.length) return null;
  return (
    <section className="border-t border-line px-3 py-3" data-testid="ai-gecmis">
      <h3 className="mb-1 text-[13px] font-semibold">Önceki puanlar</h3>
      <ul className="divide-y divide-line text-[12px]">
        {es.map((e) => {
          const ad = e.ai ? puanAdi(e.ai.puan) : null;
          const deg = e.kapanis === null ? Number.NaN : (e.kapanis / e.acilis - 1) * 100;
          return (
            <li key={`${e.tf}-${e.zaman}`} className="py-1.5">
              <div className="flex items-center gap-2">
                <span className="w-24 shrink-0 tabular-nums text-muted">{tarih(e.zaman)}</span>
                <span className="w-24 shrink-0 font-medium">
                  {TF_AD[e.tf]} {e.sinyal === "yok" ? "" : SINYAL_AD[e.sinyal]}
                </span>
                <span className={`w-14 shrink-0 font-semibold tabular-nums ${ad ? RENK[ad.renk] : "text-subtle"}`}>{e.ai ? `${e.ai.puan}/100` : "—"}</span>
                <span className="min-w-0 flex-1 truncate text-muted">
                  {(e.zaman < k.baslangic || !e.zamaninda) && "(sayılmaz) "}
                  {e.ai ? e.ai.aciklama : (e.aiHata ?? "")}
                </span>
                {e.tf === "1w" && <span className={`shrink-0 tabular-nums ${tone(deg)}`}>{Number.isFinite(deg) ? pct(deg) : ""}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function AiPanel({ open, onClose, durum, onYenile }: { open: boolean; onClose: () => void; durum: AiDurum; onYenile: () => void }) {
  useEffect(() => {
    if (open) onYenile();
  }, [open, onYenile]);
  const k = durum.tur === "tamam" ? durum.kayit : null;
  const hafta = k ? [...k.olaylar].reverse().find((e) => e.tf === "1w") : undefined;
  const gunluk = k ? [...k.olaylar].reverse().find((e) => e.tf === "1d") : undefined;
  const gosterilen = new Set([hafta, gunluk].filter((e): e is Olay => !!e));
  return (
    <Sheet open={open} title="Yapay zekâ puanı · altın, UT Bot" onClose={onClose} testId="ai-sheet">
      <p className="border-b border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
        UT Bot (varsayılan ayarlar, PAXG/USDT) günlük ya da haftalık grafikte sinyal verdiğinde Claude son haberleri okuyup o
        sinyale 0–100 arası bir al-sat puanı verir (0 kesin sat, 50 nötr, 100 kesin al) ve açıklamasını yazar; her pazartesi
        haftanın puanını verir. Puan, PAXG/USDT günlük ve haftalık grafikte sinyalin yanında da görünür. Gerçek para yok.
      </p>
      {durum.tur === "yukleniyor" && <p className="px-3 py-6 text-center text-[13px] text-muted">Yükleniyor…</p>}
      {(durum.tur === "yok" || (k && !k.olaylar.length)) && (
        <p className="px-3 py-6 text-center text-[13px] text-muted" data-testid="ai-bos">
          Henüz kayıt yok. Puanlar her gün 03:20'de (TSİ) güncellenir.
        </p>
      )}
      {durum.tur === "hata" && (
        <p className="px-3 py-6 text-center text-[13px] text-down" data-testid="ai-yukleme-hatasi">
          Kayıt okunamadı: {durum.mesaj}
        </p>
      )}
      {k && k.olaylar.length > 0 && (
        <>
          {hafta && <Kart k={k} e={hafta} testId="ai-kart-1w" />}
          {gunluk && (
            <div className="border-t border-line">
              <Kart k={k} e={gunluk} testId="ai-kart-1d" />
            </div>
          )}
          <Puanlar k={k} />
          <Gecmis k={k} gosterilen={gosterilen} />
          <p className="border-t border-line px-3 py-2 text-[11px] text-subtle">Son güncelleme: {zaman(k.guncelleme)}</p>
        </>
      )}
    </Sheet>
  );
}
