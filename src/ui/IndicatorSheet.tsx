/** İndikatör çekmecesi: Kütüphane · Kodlarım · Kod yaz (Pine Script editörü). */
import { useEffect, useRef, useState } from "react";
import { check } from "../pine";
import { LIBRARY } from "../pine/library";
import { NEW_SCRIPT, uid, type UserScript } from "../store/state";
import { CodeEditor } from "./CodeEditor";
import { IconDownload, IconPencil, IconPlus, IconTrash, IconUpload } from "./icons";
import { Sheet } from "./Sheet";

export type SheetTab = "library" | "mine" | "editor";

export interface EditTarget {
  id: string | null;
  name: string;
  code: string;
}

function scriptTitle(code: string): string | null {
  const m = /(?:indicator|study)\(\s*(?:title\s*=\s*)?["']([^"']+)["']/.exec(code);
  return m ? m[1]! : null;
}

function download(name: string, code: string): void {
  const blob = new Blob([code], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "indikator"}.pine`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function IndicatorSheet({
  open,
  onClose,
  tab,
  setTab,
  scripts,
  edit,
  setEdit,
  onAddLibrary,
  onAddUser,
  onSave,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  tab: SheetTab;
  setTab: (t: SheetTab) => void;
  scripts: UserScript[];
  edit: EditTarget;
  setEdit: (e: EditTarget) => void;
  onAddLibrary: (id: string) => void;
  onAddUser: (id: string) => void;
  onSave: (s: UserScript, addToChart: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [err, setErr] = useState<{ message: string; line: number } | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setErr(null);
    setOkMsg(null);
  }, [edit.id, open]);

  const validate = (): boolean => {
    const r = check(edit.code);
    if (!r.ok) {
      setErr({ message: r.error.message, line: r.error.line });
      setOkMsg(null);
      return false;
    }
    setErr(null);
    return true;
  };

  const save = (add: boolean) => {
    if (!validate()) return;
    const name = edit.name.trim() || scriptTitle(edit.code) || "İndikatörüm";
    const s: UserScript = { id: edit.id ?? uid("s"), name, code: edit.code, updatedAt: Date.now() };
    setEdit({ id: s.id, name, code: edit.code });
    onSave(s, add);
    setOkMsg(add ? "Kaydedildi ve grafiğe eklendi." : "Kaydedildi.");
  };

  const tabs: [SheetTab, string][] = [
    ["library", "Kütüphane"],
    ["mine", `Kodlarım (${scripts.length})`],
    ["editor", edit.id ? "Düzenle" : "Kod yaz"],
  ];

  return (
    <Sheet open={open} title="İndikatörler" onClose={onClose} wide testId="indicator-sheet">
      <div className="flex gap-1 border-b border-line px-2 py-1.5" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} className="pill" onClick={() => setTab(k)} data-testid={`tab-${k}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "library" && (
        <ul className="divide-y divide-line" data-testid="library-list">
          {LIBRARY.map((it) => (
            <li key={it.id} className="flex items-center gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[14px] font-medium">
                  {it.name}
                  {it.strategy && <span className="rounded bg-accent/15 px-1.5 text-[10px] font-semibold uppercase text-accent">Strateji</span>}
                </div>
                <div className="truncate text-[12px] text-muted">{it.description}</div>
              </div>
              <button
                type="button"
                className="btn btn-icon"
                title="Kodu kopyala ve düzenle"
                aria-label={`${it.name} kodunu düzenle`}
                onClick={() => {
                  setEdit({ id: null, name: `${it.name} (kopya)`, code: it.code });
                  setTab("editor");
                }}
              >
                <IconPencil />
              </button>
              <button type="button" className="btn btn-primary" onClick={() => onAddLibrary(it.id)} data-testid={`add-${it.id}`}>
                <IconPlus size={14} /> Ekle
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === "mine" && (
        <div>
          <div className="flex gap-2 px-3 py-2">
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                setEdit({ id: null, name: "", code: NEW_SCRIPT });
                setTab("editor");
              }}
            >
              <IconPlus size={14} /> Yeni
            </button>
            <button type="button" className="btn btn-outline" onClick={() => fileRef.current?.click()}>
              <IconUpload size={14} /> Dosyadan
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".pine,.txt,text/plain"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const code = await f.text();
                setEdit({ id: null, name: scriptTitle(code) ?? f.name.replace(/\.[^.]+$/, ""), code });
                setTab("editor");
                e.target.value = "";
              }}
            />
          </div>
          {scripts.length === 0 && (
            <p className="px-3 pb-4 text-[13px] text-muted">
              Henüz kodun yok. TradingView'da bir indikatörün kaynak kodunu kopyala, "Kod yaz" sekmesine yapıştır.
            </p>
          )}
          <ul className="divide-y divide-line" data-testid="my-scripts">
            {scripts.map((s) => (
              <li key={s.id} className="flex items-center gap-1 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px]">{s.name}</div>
                  <div className="text-[12px] text-subtle">{new Date(s.updatedAt).toLocaleString("tr-TR")}</div>
                </div>
                <button type="button" className="btn btn-icon" title="Dışa aktar (.pine)" aria-label="Dışa aktar" onClick={() => download(s.name, s.code)}>
                  <IconDownload />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Düzenle"
                  aria-label={`${s.name} düzenle`}
                  onClick={() => {
                    setEdit({ id: s.id, name: s.name, code: s.code });
                    setTab("editor");
                  }}
                >
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className="btn btn-icon"
                  title="Sil"
                  aria-label={`${s.name} sil`}
                  onClick={() => {
                    if (window.confirm(`"${s.name}" silinsin mi?`)) onDelete(s.id);
                  }}
                >
                  <IconTrash />
                </button>
                <button type="button" className="btn btn-primary" onClick={() => onAddUser(s.id)}>
                  <IconPlus size={14} /> Ekle
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "editor" && (
        <div className="space-y-2 p-3">
          <input
            className="input"
            placeholder="Ad (boşsa indicator() başlığı)"
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            aria-label="İndikatör adı"
          />
          <CodeEditor value={edit.code} onChange={(code) => setEdit({ ...edit, code })} errorLine={err?.line ?? null} />
          {err && (
            <div role="alert" className="rounded-md border border-down/50 bg-down/10 px-3 py-2 text-[13px] text-down" data-testid="editor-error">
              {err.line > 0 ? `Satır ${err.line}: ` : ""}
              {err.message}
            </div>
          )}
          {okMsg && !err && <div className="text-[13px] text-up">{okMsg}</div>}
          <p className="text-[12px] text-subtle">
            TradingView'daki bir göstergenin ya da stratejinin kodunu (Pine Script v4/v5/v6) buraya yapıştırabilirsin.
            strategy() betikleri Strateji Test Aracı'nda işlem işlem test edilir. Tablo/etiket/çizgi nesneleri henüz
            çizilmiyor.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-outline" onClick={() => validate() && setOkMsg("Kod geçerli.")} data-testid="editor-check">
              Denetle
            </button>
            <button type="button" className="btn btn-outline" onClick={() => save(false)}>
              Kaydet
            </button>
            <span className="flex-1" />
            <button type="button" className="btn btn-primary" onClick={() => save(true)} data-testid="editor-add">
              {edit.id ? "Kaydet ve uygula" : "Kaydet ve grafiğe ekle"}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
