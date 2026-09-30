/** Pine Script ayrıştırıcı (özyinelemeli iniş). v4/v5/v6'nın göstergelerde kullanılan alt kümesi. */
import type { Expr, Named, Param, Program, Stmt } from "./ast";
import { syntaxError, unsupported, type Pos } from "./errors";
import { lex, type Token } from "./lexer";

const QUALIFIERS = new Set(["series", "simple", "const"]);
const TYPE_WORDS = new Set([
  "int", "float", "bool", "string", "color", "label", "line", "box", "table", "linefill", "polyline",
  "array", "matrix", "map", "chart.point",
]);
const KEYWORDS = new Set([
  "and", "or", "not", "if", "else", "for", "to", "by", "while", "switch", "var", "varip", "true", "false",
  "import", "export", "method", "type", "break", "continue", "in",
]);
const ASSIGN_OPS = new Set([":=", "+=", "-=", "*=", "/=", "%="]);

export class Parser {
  private i = 0;
  private site = 0;
  private readonly toks: Token[];
  readonly version: number;

  constructor(source: string) {
    const r = lex(source);
    this.toks = r.tokens;
    this.version = r.version;
  }

  // ---------------------------------------------------------------- yardımcılar
  private peek(o = 0): Token {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)]!;
  }
  private next(): Token {
    const t = this.toks[this.i]!;
    if (this.i < this.toks.length - 1) this.i++;
    return t;
  }
  private prev(): Token | undefined {
    return this.toks[this.i - 1];
  }
  private isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t.t === "op" && t.v === v;
  }
  private isWord(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t.t === "ident" && t.v === v;
  }
  private expectOp(v: string): Token {
    const t = this.peek();
    if (t.t !== "op" || t.v !== v) throw syntaxError(`'${v}' bekleniyordu, '${show(t)}' bulundu`, t);
    return this.next();
  }
  private expectWord(v: string): Token {
    const t = this.peek();
    if (t.t !== "ident" || t.v !== v) throw syntaxError(`'${v}' bekleniyordu, '${show(t)}' bulundu`, t);
    return this.next();
  }
  private expectIdent(): Token {
    const t = this.peek();
    if (t.t !== "ident" || KEYWORDS.has(t.v)) throw syntaxError(`Ad bekleniyordu, '${show(t)}' bulundu`, t);
    return this.next();
  }
  private skipNewlines(): void {
    while (this.peek().t === "newline") this.next();
  }
  private pos(t: Token): Pos {
    return { line: t.line, col: t.col };
  }
  private endStatement(): void {
    const t = this.peek();
    if (t.t === "newline") {
      this.next();
      return;
    }
    if (t.t === "dedent" || t.t === "eof") return;
    if (this.prev()?.t === "dedent") return; // blok ifadesi (if/for/switch) kendi satırını kapattı
    throw syntaxError(`Beklenmeyen '${show(t)}'`, t);
  }

  // ---------------------------------------------------------------- program
  parseProgram(): Program {
    const body: Stmt[] = [];
    this.skipNewlines();
    while (this.peek().t !== "eof") {
      if (this.peek().t === "indent") throw syntaxError("Beklenmeyen girinti", this.peek());
      if (this.peek().t === "dedent") {
        this.next();
        continue;
      }
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    return { body, version: this.version, sites: this.site };
  }

  private parseBlock(): Stmt[] {
    const t = this.peek();
    if (t.t !== "newline") throw syntaxError("Blok bekleniyordu: satır sonu ve 4 boşluk girintili satırlar", t);
    this.next();
    this.skipNewlines();
    if (this.peek().t !== "indent") throw syntaxError("Blok bekleniyordu: 4 boşluk girintili satırlar", this.peek());
    this.next();
    const body: Stmt[] = [];
    this.skipNewlines();
    while (this.peek().t !== "dedent" && this.peek().t !== "eof") {
      body.push(this.parseStatement());
      this.skipNewlines();
    }
    if (this.peek().t === "dedent") this.next();
    return body;
  }

  // ---------------------------------------------------------------- deyimler
  private parseStatement(): Stmt {
    const t = this.peek();
    if (t.t === "ident") {
      switch (t.v) {
        case "import":
          throw unsupported("import (kütüphane içe aktarma) desteklenmiyor", t);
        case "type":
          if (this.peek(1).t === "ident") throw unsupported("type (kullanıcı tanımlı tip) desteklenmiyor", t);
          break;
        case "method":
          if (this.peek(1).t === "ident") throw unsupported("method tanımı desteklenmiyor", t);
          break;
        case "export":
          this.next();
          return this.parseStatement();
        case "break":
        case "continue":
          this.next();
          this.endStatement();
          return { k: t.v, ...this.pos(t) };
        case "var":
        case "varip":
          this.next();
          return this.parseDecl(t.v, t);
      }
      if (this.isFnDef()) return this.parseFnDef();
      if (this.isTypedDecl()) return this.parseDecl(null, t);
      const n1 = this.peek(1);
      if (!KEYWORDS.has(t.v) && n1.t === "op" && ASSIGN_OPS.has(n1.v)) {
        this.next();
        this.next();
        const e = this.parseExpr();
        this.endStatement();
        return { k: "assign", name: t.v, op: n1.v, e, ...this.pos(t) };
      }
      if (!KEYWORDS.has(t.v) && n1.t === "op" && n1.v === "=") {
        return this.parseDecl(null, t);
      }
    }
    if (t.t === "op" && t.v === "[" && this.isTupleDecl()) return this.parseDecl(null, t);
    const e = this.parseExpr();
    this.endStatement();
    return { k: "expr", e, ...this.pos(t) };
  }

  /** `ad(…) =>` biçimi mi? */
  private isFnDef(): boolean {
    const t = this.peek();
    if (t.t !== "ident" || KEYWORDS.has(t.v) || !this.isOp("(", 1)) return false;
    let d = 0;
    for (let j = this.i + 1; j < this.toks.length; j++) {
      const x = this.toks[j]!;
      if (x.t === "newline" || x.t === "eof") return false;
      if (x.t !== "op") continue;
      if (x.v === "(") d++;
      else if (x.v === ")") {
        d--;
        if (d === 0) {
          const y = this.toks[j + 1];
          return !!y && y.t === "op" && y.v === "=>";
        }
      }
    }
    return false;
  }

  /** Tip önekini atlar; tip adını döner (yoksa null). `float x = …`, `array<float> a = …`, `series int n = …`. */
  private typePrefixLen(start: number): number {
    let j = start;
    let tk = this.toks[j];
    while (tk && tk.t === "ident" && QUALIFIERS.has(tk.v)) tk = this.toks[++j];
    if (!tk || tk.t !== "ident" || !TYPE_WORDS.has(tk.v)) return 0;
    j++;
    const lt = this.toks[j];
    if (lt && lt.t === "op" && lt.v === "<") {
      let d = 0;
      for (; j < this.toks.length; j++) {
        const x = this.toks[j]!;
        if (x.t === "newline") return 0;
        if (x.t === "op" && x.v === "<") d++;
        if (x.t === "op" && x.v === ">") {
          d--;
          if (d === 0) {
            j++;
            break;
          }
        }
      }
    }
    return j - start;
  }

  private isTypedDecl(): boolean {
    const n = this.typePrefixLen(this.i);
    if (n === 0) return false;
    const a = this.toks[this.i + n];
    const b = this.toks[this.i + n + 1];
    return !!a && a.t === "ident" && !!b && b.t === "op" && b.v === "=";
  }

  private isTupleDecl(): boolean {
    let d = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const x = this.toks[j]!;
      if (x.t === "newline" || x.t === "eof") return false;
      if (x.t !== "op") continue;
      if (x.v === "[") d++;
      else if (x.v === "]") {
        d--;
        if (d === 0) {
          const y = this.toks[j + 1];
          return !!y && y.t === "op" && y.v === "=";
        }
      }
    }
    return false;
  }

  private parseDecl(mode: "var" | "varip" | null, start: Token): Stmt {
    let type: string | null = null;
    const n = this.typePrefixLen(this.i);
    if (n > 0) {
      type = this.toks
        .slice(this.i, this.i + n)
        .map((x) => x.v)
        .join("");
      this.i += n;
    }
    let names: string[];
    let tuple = false;
    if (this.isOp("[")) {
      this.next();
      names = [];
      while (!this.isOp("]")) {
        names.push(this.expectIdent().v);
        if (this.isOp(",")) this.next();
        else break;
      }
      this.expectOp("]");
      tuple = true;
    } else {
      names = [this.expectIdent().v];
    }
    this.expectOp("=");
    const e = this.parseExpr();
    this.endStatement();
    return { k: "decl", names, tuple, mode, type, e, site: this.site++, ...this.pos(start) };
  }

  private parseFnDef(): Stmt {
    const nameTok = this.next();
    this.expectOp("(");
    const params: Param[] = [];
    while (!this.isOp(")")) {
      // [nitelik] [tip[<…>]] ad [= varsayılan]
      const n = this.typePrefixLen(this.i);
      this.i += n;
      const pn = this.expectIdent().v;
      let def: Expr | null = null;
      if (this.isOp("=")) {
        this.next();
        def = this.parseExpr();
      }
      params.push({ name: pn, def });
      if (this.isOp(",")) this.next();
      else break;
    }
    this.expectOp(")");
    this.expectOp("=>");
    let body: Stmt[];
    if (this.peek().t === "newline") {
      body = this.parseBlock();
    } else {
      const t = this.peek();
      const e = this.parseExpr();
      this.endStatement();
      body = [{ k: "expr", e, ...this.pos(t) }];
    }
    return { k: "fn", name: nameTok.v, params, body, ...this.pos(nameTok) };
  }

  // ---------------------------------------------------------------- ifadeler
  parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const c = this.parseOr();
    if (this.isOp("?")) {
      const q = this.next();
      const a = this.parseTernary();
      this.expectOp(":");
      const b = this.parseTernary();
      return { k: "tern", c, a, b, ...this.pos(q) };
    }
    return c;
  }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.isWord("or")) {
      const t = this.next();
      l = { k: "bin", op: "or", l, r: this.parseAnd(), ...this.pos(t) };
    }
    return l;
  }

  private parseAnd(): Expr {
    let l = this.parseEq();
    while (this.isWord("and")) {
      const t = this.next();
      l = { k: "bin", op: "and", l, r: this.parseEq(), ...this.pos(t) };
    }
    return l;
  }

  private parseEq(): Expr {
    let l = this.parseCmp();
    while (this.isOp("==") || this.isOp("!=")) {
      const t = this.next();
      l = { k: "bin", op: t.v, l, r: this.parseCmp(), ...this.pos(t) };
    }
    return l;
  }

  private parseCmp(): Expr {
    let l = this.parseAdd();
    while (this.isOp("<") || this.isOp(">") || this.isOp("<=") || this.isOp(">=")) {
      const t = this.next();
      l = { k: "bin", op: t.v, l, r: this.parseAdd(), ...this.pos(t) };
    }
    return l;
  }

  private parseAdd(): Expr {
    let l = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      const t = this.next();
      l = { k: "bin", op: t.v, l, r: this.parseMul(), ...this.pos(t) };
    }
    return l;
  }

  private parseMul(): Expr {
    let l = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const t = this.next();
      l = { k: "bin", op: t.v, l, r: this.parseUnary(), ...this.pos(t) };
    }
    return l;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if ((t.t === "op" && (t.v === "-" || t.v === "+")) || (t.t === "ident" && t.v === "not")) {
      this.next();
      const e = this.parseUnary();
      if (t.v === "-" && e.k === "num") return { ...e, v: -e.v };
      return { k: "un", op: t.v as "-" | "+" | "not", e, ...this.pos(t) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    while (this.isOp("[")) {
      const t = this.next();
      const idx = this.parseExpr();
      this.expectOp("]");
      e = { k: "index", obj: e, idx, site: this.site++, ...this.pos(t) };
    }
    return e;
  }

  /** `ad<tip>(` genel çağrı kalıbı mı? (array.new<float>(…)) */
  private genericLen(): number {
    if (!this.isOp("<", 1)) return 0;
    let d = 0;
    for (let j = this.i + 1; j < this.toks.length; j++) {
      const x = this.toks[j]!;
      if (x.t === "newline" || x.t === "eof") return 0;
      if (x.t === "op" && x.v === "<") d++;
      else if (x.t === "op" && x.v === ">") {
        d--;
        if (d === 0) {
          const y = this.toks[j + 1];
          return y && y.t === "op" && y.v === "(" ? j - this.i : 0;
        }
      } else if (x.t !== "ident" && !(x.t === "op" && x.v === ",")) return 0;
    }
    return 0;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    const p = this.pos(t);
    switch (t.t) {
      case "num":
        this.next();
        return { k: "num", v: Number(t.v), int: !/[.eE]/.test(t.v), ...p };
      case "str":
        this.next();
        return { k: "str", v: t.v, ...p };
      case "color":
        this.next();
        return { k: "color", v: t.v, ...p };
      case "op":
        if (t.v === "(") {
          this.next();
          const e = this.parseExpr();
          this.expectOp(")");
          return e;
        }
        if (t.v === "[") {
          this.next();
          const items: Expr[] = [];
          while (!this.isOp("]")) {
            items.push(this.parseExpr());
            if (this.isOp(",")) this.next();
            else break;
          }
          this.expectOp("]");
          return { k: "tuple", items, ...p };
        }
        break;
      case "ident": {
        switch (t.v) {
          case "true":
          case "false":
            this.next();
            return { k: "bool", v: t.v === "true", ...p };
          case "if":
            return this.parseIf();
          case "switch":
            return this.parseSwitch();
          case "for":
            return this.parseFor();
          case "while":
            return this.parseWhile();
        }
        if (t.v === "na" && !this.isOp("(", 1)) {
          this.next();
          return { k: "na", ...p };
        }
        if (KEYWORDS.has(t.v)) break;
        const g = this.genericLen();
        if (g > 0) {
          const generic = this.toks
            .slice(this.i + 2, this.i + g)
            .map((x) => x.v)
            .join("");
          this.i += g + 1; // ad + <…>
          return this.parseCallArgs(t.v, p, generic);
        }
        if (this.isOp("(", 1)) {
          this.next();
          return this.parseCallArgs(t.v, p, null);
        }
        this.next();
        return { k: "id", name: t.v, ...p };
      }
      default:
        break;
    }
    throw syntaxError(`Beklenmeyen '${show(t)}'`, t);
  }

  private parseCallArgs(callee: string, p: Pos, generic: string | null): Expr {
    this.expectOp("(");
    const args: Expr[] = [];
    const named: Named[] = [];
    while (!this.isOp(")")) {
      const t = this.peek();
      if (t.t === "ident" && this.isOp("=", 1)) {
        this.next();
        this.next();
        named.push({ name: t.v, value: this.parseExpr() });
      } else {
        if (named.length > 0) throw syntaxError("Adlı argümandan sonra sıralı argüman gelemez", t);
        args.push(this.parseExpr());
      }
      if (this.isOp(",")) this.next();
      else break;
    }
    this.expectOp(")");
    return { k: "call", callee, args, named, site: this.site++, generic, ...p };
  }

  private parseIf(): Expr {
    const t = this.next();
    const branches: { cond: Expr | null; body: Stmt[] }[] = [];
    const cond = this.parseExpr();
    branches.push({ cond, body: this.parseBlock() });
    while (this.isWord("else")) {
      this.next();
      if (this.isWord("if")) {
        this.next();
        const c = this.parseExpr();
        branches.push({ cond: c, body: this.parseBlock() });
        continue;
      }
      branches.push({ cond: null, body: this.parseBlock() });
      break;
    }
    return { k: "if", branches, ...this.pos(t) };
  }

  private parseSwitch(): Expr {
    const t = this.next();
    const subject = this.peek().t === "newline" ? null : this.parseExpr();
    if (this.peek().t !== "newline") throw syntaxError("switch sonrası yeni satır bekleniyordu", this.peek());
    this.next();
    this.skipNewlines();
    if (this.peek().t !== "indent") throw syntaxError("switch durumları 4 boşluk girintili olmalı", this.peek());
    this.next();
    const cases: { match: Expr | null; body: Stmt[] }[] = [];
    this.skipNewlines();
    while (this.peek().t !== "dedent" && this.peek().t !== "eof") {
      let match: Expr | null = null;
      if (this.isOp("=>")) {
        this.next();
      } else {
        match = this.parseExpr();
        this.expectOp("=>");
      }
      const body = this.peek().t === "newline" ? this.parseBlock() : [this.parseStatement()];
      cases.push({ match, body });
      this.skipNewlines();
    }
    if (this.peek().t === "dedent") this.next();
    return { k: "switch", subject, cases, ...this.pos(t) };
  }

  private parseFor(): Expr {
    const t = this.next();
    if (this.isOp("[")) {
      this.next();
      const vars: string[] = [];
      while (!this.isOp("]")) {
        vars.push(this.expectIdent().v);
        if (this.isOp(",")) this.next();
        else break;
      }
      this.expectOp("]");
      this.expectWord("in");
      const arr = this.parseExpr();
      return { k: "forin", vars, arr, body: this.parseBlock(), site: this.site++, ...this.pos(t) };
    }
    const v = this.expectIdent().v;
    if (this.isWord("in")) {
      this.next();
      const arr = this.parseExpr();
      return { k: "forin", vars: [v], arr, body: this.parseBlock(), site: this.site++, ...this.pos(t) };
    }
    this.expectOp("=");
    const from = this.parseExpr();
    this.expectWord("to");
    const to = this.parseExpr();
    let by: Expr | null = null;
    if (this.isWord("by")) {
      this.next();
      by = this.parseExpr();
    }
    return { k: "for", v, from, to, by, body: this.parseBlock(), site: this.site++, ...this.pos(t) };
  }

  private parseWhile(): Expr {
    const t = this.next();
    const cond = this.parseExpr();
    return { k: "while", cond, body: this.parseBlock(), ...this.pos(t) };
  }
}

function show(t: Token): string {
  switch (t.t) {
    case "newline":
      return "satır sonu";
    case "indent":
      return "girinti";
    case "dedent":
      return "girinti sonu";
    case "eof":
      return "dosya sonu";
    case "str":
      return `"${t.v}"`;
    default:
      return t.v;
  }
}

export function parse(source: string): Program {
  return new Parser(source).parseProgram();
}
