/** İndikatör ayarları: betikteki input.* tanımlarından otomatik form. */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { INTERVALS } from "../data/intervals";
import type { InputMeta } from "../pine/types";
import { Sheet } from "./Sheet";

const SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4", "volume"];

function tfValue(sec: number): string {
  if (sec % 604800 === 0) return sec === 604800 ? "W" : `${sec / 604800}W`;
  if (sec % 86400 === 0) return sec === 86400 ? "D" : `${sec / 86400}D`;
  return String(sec / 60);
}

function toHex6(c: unknown): string {
  return typeof c === "string" && /^#[0-9A-Fa-f]{6}/.test(c) ? c.slice(0, 7) : "#2962ff";
}

export function InputsDialog({
  open,
  title,
  inputs,
  values,
  onApply,
  onClose,
}: {
  open: boolean;
  title: string;
  inputs: InputMeta[];
  values: Record<string, unknown>;
  onApply: (v: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(values);
  useEffect(() => {
    if (open) setDraft(values);
  }, [open, values]);
  const val = (m: InputMeta) => (m.key in draft ? draft[m.key] : m.defval);
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <Sheet open={open} title={`${title} · Ayarlar`} onClose={onClose} testId="inputs-dialog">
      <div className="space-y-3 p-3">
        {inputs.length === 0 && <p className="text-sm text-muted">Bu indikatörün ayarı yok.</p>}
        {inputs.map((m, idx) => {
          const head =
            m.group && m.group !== inputs[idx - 1]?.group ? (
              <div className="border-t border-line pt-3 text-[12px] font-semibold uppercase tracking-wide text-subtle first:border-0 first:pt-0">{m.group}</div>
            ) : null;
          return (
            <Fragment key={m.key}>
              {head}
              {field(m)}
            </Fragment>
          );
        })}
      </div>
      <div className="sticky bottom-0 flex gap-2 border-t border-line bg-panel p-3">
        <button type="button" className="btn btn-outline" onClick={() => setDraft({})}>
          Varsayılanlar
        </button>
        <span className="flex-1" />
        <button type="button" className="btn" onClick={onClose}>
          Vazgeç
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="inputs-apply"
          onClick={() => {
            onApply(draft);
            onClose();
          }}
        >
          Uygula
        </button>
      </div>
    </Sheet>
  );

  function field(m: InputMeta): ReactNode {
    const v = val(m);
    const id = `in-${m.key}`;
    const label = (
      <label htmlFor={id} className="mb-1 block text-[13px] text-muted" title={m.tooltip}>
        {m.title}
        {m.tooltip ? <span className="ml-1 text-subtle" aria-hidden="true">ⓘ</span> : null}
      </label>
    );
    if (m.type === "bool") {
      return (
        <label key={m.key} className="flex items-center gap-2 text-[14px]">
          <input id={id} type="checkbox" checked={v === true} onChange={(e) => set(m.key, e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          {m.title}
        </label>
      );
    }
    if (m.options && m.options.length) {
      return (
        <div key={m.key}>
          {label}
          <select id={id} className="input" value={String(v)} onChange={(e) => set(m.key, m.type === "int" || m.type === "float" ? Number(e.target.value) : e.target.value)}>
            {m.options.map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
        </div>
      );
    }
    if (m.type === "int" || m.type === "float" || m.type === "price") {
      return (
        <div key={m.key}>
          {label}
          <input
            id={id}
            className="input"
            type="number"
            inputMode="decimal"
            value={Number.isFinite(Number(v)) ? String(v) : ""}
            min={m.minval}
            max={m.maxval}
            step={m.step ?? (m.type === "int" ? 1 : "any")}
            onChange={(e) => set(m.key, e.target.value === "" ? m.defval : Number(e.target.value))}
          />
        </div>
      );
    }
    if (m.type === "source") {
      return (
        <div key={m.key}>
          {label}
          <select id={id} className="input" value={String(v)} onChange={(e) => set(m.key, e.target.value)}>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      );
    }
    if (m.type === "timeframe") {
      return (
        <div key={m.key}>
          {label}
          <select id={id} className="input" value={String(v)} onChange={(e) => set(m.key, e.target.value)}>
            <option value="">Grafik ile aynı</option>
            {INTERVALS.map((iv) => (
              <option key={iv.id} value={tfValue(iv.sec)}>
                {iv.label}
              </option>
            ))}
          </select>
        </div>
      );
    }
    if (m.type === "color") {
      return (
        <div key={m.key}>
          {label}
          <input id={id} type="color" className="h-9 w-16 rounded border border-line bg-bg" value={toHex6(v)} onChange={(e) => set(m.key, `${e.target.value.toUpperCase()}FF`)} />
        </div>
      );
    }
    return (
      <div key={m.key}>
        {label}
        <input id={id} className="input" value={String(v ?? "")} onChange={(e) => set(m.key, e.target.value)} />
      </div>
    );
  }
}
