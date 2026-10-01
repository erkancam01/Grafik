/** Yapay zekâ kaydını ("ai-yorum" dalı) okur: uygulama açılınca bir kez, `yenile` ile yeniden (ör. panel açılınca). */
import { useCallback, useEffect, useState } from "react";
import { AI_KAYIT_URL, kayitOku, type Kayit } from "./yorum";

export type AiDurum = { tur: "yukleniyor" } | { tur: "yok" } | { tur: "hata"; mesaj: string } | { tur: "tamam"; kayit: Kayit };

async function getir(): Promise<AiDurum> {
  try {
    const r = await fetch(AI_KAYIT_URL, { cache: "no-store" });
    if (r.status === 404) return { tur: "yok" };
    if (!r.ok) return { tur: "hata", mesaj: `HTTP ${r.status}` };
    const k = kayitOku(await r.json());
    return k ? { tur: "tamam", kayit: k } : { tur: "hata", mesaj: "beklenmeyen kayıt biçimi" };
  } catch (e) {
    return { tur: "hata", mesaj: e instanceof Error ? e.message : String(e) };
  }
}

export function useAiKayit(): [AiDurum, () => void] {
  const [d, setD] = useState<AiDurum>({ tur: "yukleniyor" });
  const [n, setN] = useState(0);
  useEffect(() => {
    let iptal = false;
    void getir().then((x) => !iptal && setD(x));
    return () => {
      iptal = true;
    };
  }, [n]);
  const yenile = useCallback(() => setN((x) => x + 1), []);
  return [d, yenile];
}
