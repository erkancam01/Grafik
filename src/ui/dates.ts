/** Tarih girişleri (yerel saat): <input type="date"> / "datetime-local" değeri ↔ ms. */
const pad = (n: number) => String(n).padStart(2, "0");

export function toDateInput(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Seçilen günün başı (ya da `endOfDay` ise sonu), yerel saatle. */
export function fromDateInput(s: string, endOfDay = false): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return Number.NaN;
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return endOfDay ? start + 86_400_000 - 1 : start;
}

export function toDateTimeInput(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${toDateInput(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDateTimeInput(s: string): number {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : Number.NaN;
}

/** Bugünden `days` gün önceki günün başı (yerel). */
export function daysAgo(days: number, now = Date.now()): number {
  const d = new Date(now - days * 86_400_000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function startOfYear(now = Date.now()): number {
  return new Date(new Date(now).getFullYear(), 0, 1).getTime();
}
