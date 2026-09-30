/** Alt çekmece / pencere: telefonda alttan açılır, geniş ekranda ortada. Esc ve arka plan tıklamasıyla kapanır. */
import { useEffect, type ReactNode } from "react";
import { IconX } from "./icons";

export function Sheet({
  open,
  title,
  onClose,
  children,
  wide = false,
  testId,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        data-testid={testId}
        className={`flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl border border-line bg-panel shadow-2xl sm:rounded-xl ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h2>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Kapat">
            <IconX />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
