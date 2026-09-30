/**
 * Pine Script sözcük ayırıcı.
 *
 * Satır tabanlıdır: her fiziksel satır ayrı ayrı parçalanır, sonra mantıksal satırlara birleştirilir.
 * Birleştirme (satır devamı) kuralları:
 *  - açık parantez/köşeli parantez varsa sonraki satır devamdır;
 *  - sonraki satırın girintisi 4'ün katı değilse ve öncekinden fazlaysa devamdır (Pine kuralı);
 *  - önceki satır bir işleçle (+, and, ?, :, virgül…) bitiyorsa ve sonraki daha girintiliyse devamdır.
 * Bloklar Python'daki gibi INDENT/DEDENT belirteçleriyle ifade edilir (sekme = 4 boşluk).
 */
import { syntaxError } from "./errors";

export type TokType = "num" | "str" | "ident" | "color" | "op" | "newline" | "indent" | "dedent" | "eof";

export interface Token {
  t: TokType;
  v: string;
  line: number;
  col: number;
}

const OPS = [
  "==", "!=", "<=", ">=", ":=", "=>", "+=", "-=", "*=", "/=", "%=",
  "+", "-", "*", "/", "%", "<", ">", "=", "?", ":", ",", "(", ")", "[", "]", ".",
];

/** Satır sonunda kalınca bir sonraki (daha girintili) satırın devam olduğunu gösteren belirteçler. */
const CONT_OPS = new Set([
  "+", "-", "*", "/", "%", "<", ">", "<=", ">=", "==", "!=", "?", ":", ",", "(", "[", "=", ":=",
  "+=", "-=", "*=", "/=", "%=",
]);
const CONT_WORDS = new Set(["and", "or", "not"]);

const NUM_RE = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/;

export interface LexResult {
  tokens: Token[];
  version: number;
}

/** Bir fiziksel satırı parçalar (yorum atılır). */
function tokenizeLine(src: string, line: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "﻿") {
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") break; // yorum
    const col = i + 1;
    const rest = src.slice(i);
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = "";
      let closed = false;
      while (j < n) {
        const c = src[j]!;
        if (c === "\\" && j + 1 < n) {
          const e = src[j + 1]!;
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          j++;
          break;
        }
        s += c;
        j++;
      }
      if (!closed) throw syntaxError("Kapanmamış metin (tırnak eksik)", { line, col });
      out.push({ t: "str", v: s, line, col });
      i = j;
      continue;
    }
    if (ch === "#") {
      const m = COLOR_RE.exec(rest);
      if (!m) throw syntaxError(`Geçersiz renk: ${rest.slice(0, 9)}`, { line, col });
      out.push({ t: "color", v: m[0].toUpperCase(), line, col });
      i += m[0].length;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = NUM_RE.exec(rest)!;
      out.push({ t: "num", v: m[0], line, col });
      i += m[0].length;
      continue;
    }
    const idm = IDENT_RE.exec(rest);
    if (idm) {
      // noktalı adlar tek belirteç: ta.ema, color.red, array.new_float, arr.push
      let name = idm[0];
      let j = i + name.length;
      while (src[j] === "." && IDENT_RE.test(src.slice(j + 1))) {
        const part = IDENT_RE.exec(src.slice(j + 1))![0];
        name += "." + part;
        j += 1 + part.length;
      }
      out.push({ t: "ident", v: name, line, col });
      i = j;
      continue;
    }
    const op = OPS.find((o) => rest.startsWith(o));
    if (op) {
      out.push({ t: "op", v: op, line, col });
      i += op.length;
      continue;
    }
    throw syntaxError(`Beklenmeyen karakter: '${ch}'`, { line, col });
  }
  return out;
}

function indentWidth(s: string): number {
  let w = 0;
  for (const c of s) {
    if (c === " ") w += 1;
    else if (c === "\t") w += 4;
    else break;
  }
  return w;
}

function depthDelta(toks: Token[]): number {
  let d = 0;
  for (const t of toks) {
    if (t.t !== "op") continue;
    if (t.v === "(" || t.v === "[") d++;
    else if (t.v === ")" || t.v === "]") d--;
  }
  return d;
}

function endsWithContinuation(toks: Token[]): boolean {
  const last = toks[toks.length - 1];
  if (!last) return false;
  if (last.t === "op") return CONT_OPS.has(last.v);
  return last.t === "ident" && CONT_WORDS.has(last.v);
}

interface Logical {
  indent: number;
  toks: Token[];
  line: number;
}

export function lex(source: string): LexResult {
  const vm = /^\s*\/\/\s*@version\s*=\s*(\d+)/m.exec(source);
  const version = vm ? Number(vm[1]) : 6;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const logical: Logical[] = [];
  let cur: Logical | null = null;
  let depth = 0;
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k]!;
    const toks = tokenizeLine(raw, k + 1);
    if (toks.length === 0) continue;
    const ind = indentWidth(raw);
    const cont =
      cur !== null &&
      (depth > 0 ||
        (ind > cur.indent && ind % 4 !== 0) ||
        (ind > cur.indent && endsWithContinuation(cur.toks)));
    if (cont && cur) {
      cur.toks.push(...toks);
    } else {
      cur = { indent: ind, toks: [...toks], line: k + 1 };
      logical.push(cur);
      depth = 0;
    }
    depth += depthDelta(toks);
    if (depth < 0) depth = 0;
  }
  const out: Token[] = [];
  const stack = [0];
  for (const lg of logical) {
    const first = lg.toks[0]!;
    const top = stack[stack.length - 1]!;
    if (lg.indent > top) {
      stack.push(lg.indent);
      out.push({ t: "indent", v: "", line: first.line, col: 1 });
    } else if (lg.indent < top) {
      while (stack.length > 1 && lg.indent < stack[stack.length - 1]!) {
        stack.pop();
        out.push({ t: "dedent", v: "", line: first.line, col: 1 });
      }
      if (lg.indent !== stack[stack.length - 1]) {
        throw syntaxError("Girinti hatalı: bloklar 4 boşluk (veya sekme) ile girintilenmeli", {
          line: first.line,
          col: 1,
        });
      }
    }
    out.push(...lg.toks);
    const last = lg.toks[lg.toks.length - 1]!;
    out.push({ t: "newline", v: "", line: last.line, col: last.col + last.v.length });
  }
  const endLine = lines.length;
  while (stack.length > 1) {
    stack.pop();
    out.push({ t: "dedent", v: "", line: endLine, col: 1 });
  }
  out.push({ t: "eof", v: "", line: endLine, col: 1 });
  return { tokens: out, version };
}
