/** Satır numaralı basit kod editörü (telefonda otomatik düzeltme kapalı; Tab = 4 boşluk; hata satırı işaretli). */
import { useMemo, useRef } from "react";

export function CodeEditor({
  value,
  onChange,
  errorLine,
}: {
  value: string;
  onChange: (v: string) => void;
  errorLine: number | null;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n").length, [value]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const el = e.currentTarget;
    const s = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${value.slice(0, s)}    ${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 4;
    });
  };

  return (
    <div className="code relative flex h-[46dvh] min-h-[220px] overflow-hidden rounded-md border border-line bg-bg sm:h-[52dvh]">
      <div ref={gutter} className="select-none overflow-hidden border-r border-line px-2 py-2 text-right text-subtle" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={i + 1 === errorLine ? "rounded bg-down/30 text-down" : undefined}>
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={ta}
        data-testid="code-editor"
        className="code min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-fg outline-none"
        value={value}
        wrap="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        aria-label="Pine Script kodu"
      />
    </div>
  );
}
