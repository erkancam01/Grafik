/** Pine hataları: konumlu (satır:sütun), Türkçe mesajlı. */
export type PineErrorKind = "syntax" | "runtime" | "unsupported" | "limit";

export class PineError extends Error {
  constructor(
    message: string,
    public line = 0,
    public col = 0,
    public kind: PineErrorKind = "syntax",
  ) {
    super(message);
    this.name = "PineError";
  }

  /** Arayüz için: "12:5 — mesaj". */
  toText(): string {
    return this.line > 0 ? `Satır ${this.line}:${this.col} — ${this.message}` : this.message;
  }
}

export interface Pos {
  line: number;
  col: number;
}

export function syntaxError(msg: string, p: Pos): PineError {
  return new PineError(msg, p.line, p.col, "syntax");
}

export function unsupported(msg: string, p?: Pos): PineError {
  return new PineError(msg, p?.line ?? 0, p?.col ?? 0, "unsupported");
}

export function runtimeError(msg: string, p?: Pos): PineError {
  return new PineError(msg, p?.line ?? 0, p?.col ?? 0, "runtime");
}
