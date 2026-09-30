/**
 * Derleyici: sözdizim ağacını kapanış (closure) fonksiyonlarına çevirir — `eval` yok, hızlı ve güvenli.
 *
 * Kapsam: her fonksiyonun (ve genel betiğin) kendi slot tablosu vardır; bloklar iç kapsam açar. Fonksiyonlar genel
 * değişkenleri okuyabilir. `request.security` ifadesi ayrı bir çerçevede, istenen zaman diliminin mumları üzerinde
 * çalışır; ifadede geçen genel değişkenler tanımlarıyla yerine konur (Pine'daki gibi o zaman diliminde hesaplanır).
 */
import type { Expr, Named, Program, Stmt } from "./ast";
import { Frame, LimitError, type Runtime, type SeriesCtx } from "./engine";
import { PineError, syntaxError, unsupported, type Pos } from "./errors";
import { parse } from "./parser";
import {
  CONSTS,
  FUNCS,
  PRELUDE,
  SERIES_NAMES,
  VARS,
  aliasOf,
  drawingNs,
  seriesArray,
} from "./builtins/index";
import type { BuiltinDef } from "./builtins/registry";
import { tfToSec } from "./builtins/core";
import type { DataRequest, InputMeta, InputType } from "./types";
import { PineArray, PineDrawing, PineTuple, isNa, num, truthy } from "./values";

export type Ev = (rt: Runtime, f: Frame) => unknown;

const BREAK = { brk: true };
const CONTINUE = { cont: true };
const MAX_LOOP = 100_000;

interface FnCtx {
  nslots: number;
  varSlots: Set<number>;
  isGlobal: boolean;
}

class Scope {
  vars = new Map<string, number>();
  constructor(
    public parent: Scope | null,
    public fn: FnCtx,
  ) {}
  lookup(name: string): number | undefined {
    for (let s: Scope | null = this; s; s = s.parent) {
      const v = s.vars.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }
}

interface UserFn {
  name: string;
  params: string[];
  paramSlots: number[];
  defaults: (Ev | null)[];
  body: Ev;
  ctx: FnCtx;
  decl: Extract<Stmt, { k: "fn" }>;
  compiled: boolean;
}

export interface Compiled {
  main: Ev;
  nslots: number;
  version: number;
}

const DIRECT_SERIES: Record<string, (S: SeriesCtx) => Float64Array> = {
  open: (S) => S.open,
  high: (S) => S.high,
  low: (S) => S.low,
  close: (S) => S.close,
  volume: (S) => S.volume,
  time: (S) => S.time,
};

export const SOURCE_NAMES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4", "volume"];

const INPUT_PARAMS: Record<string, string[]> = {
  input: ["defval", "title", "type", "minval", "maxval", "confirm", "step", "options", "tooltip", "inline", "group", "display"],
  "input.int": ["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "options"],
  "input.float": ["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "options"],
  "input.bool": ["defval", "title", "tooltip", "inline", "group", "confirm", "display"],
  "input.string": ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display"],
  "input.color": ["defval", "title", "tooltip", "inline", "group", "confirm", "display"],
  "input.source": ["defval", "title", "tooltip", "inline", "group", "display"],
  "input.timeframe": ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display"],
  "input.symbol": ["defval", "title", "tooltip", "inline", "group", "confirm", "display"],
  "input.session": ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display"],
  "input.time": ["defval", "title", "tooltip", "inline", "group", "confirm", "display"],
  "input.price": ["defval", "title", "tooltip", "inline", "group", "confirm", "display"],
  "input.text_area": ["defval", "title", "tooltip", "group", "confirm", "display"],
  "input.enum": ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display"],
};

const SECURITY_PARAMS = ["symbol", "timeframe", "expression", "gaps", "lookahead", "ignore_invalid_symbol", "currency", "calc_bars_count"];

function posOf(e: Pos): Pos {
  return { line: e.line, col: e.col };
}

function eq(a: unknown, b: unknown): boolean {
  if (isNa(a) || isNa(b)) return false;
  return a === b;
}

function toInt(v: unknown): number {
  const x = num(v);
  return Number.isNaN(x) ? Number.NaN : Math.floor(x);
}

/** Sıralı + adlı argümanları parametre sırasına dizer. */
function orderArgs(params: string[], args: Expr[], named: Named[], callee: string, p: Pos): (Expr | undefined)[] {
  const out: (Expr | undefined)[] = [...args];
  for (const nm of named) {
    const i = params.indexOf(nm.name);
    if (i < 0) {
      if (params.length === 0) continue;
      continue; // bilinmeyen adlı argüman (editable, display…) yok sayılır
    }
    if (out[i] !== undefined) throw syntaxError(`${callee}: '${nm.name}' iki kez verildi`, p);
    out[i] = nm.value;
  }
  return out;
}

export class Compiler {
  private readonly fns = new Map<string, UserFn>();
  private readonly globalCtx: FnCtx = { nslots: 0, varSlots: new Set(), isGlobal: true };
  private readonly globalScope = new Scope(null, this.globalCtx);
  private topDecls = new Map<string, Extract<Stmt, { k: "decl" }>>();
  private reassigned = new Set<string>();
  private siteCounter: number;
  readonly version: number;

  constructor(private readonly prog: Program) {
    this.version = prog.version;
    this.siteCounter = prog.sites + 100_000;
  }

  // ---------------------------------------------------------------- giriş
  compile(): Compiled {
    // önek (Pine ile yazılmış yerleşikler) + betik fonksiyonları
    const prelude = preludeProgram();
    for (const s of prelude.body) if (s.k === "fn") this.registerFn(s, 1_000_000);
    for (const s of this.prog.body) if (s.k === "fn") this.registerFn(s, 0);
    // := hedefleri ve genel tanımlar (request.security satır içi yerleştirmesi için)
    this.scanAssigns(this.prog.body);
    for (const s of this.prog.body) {
      if (s.k === "decl" && !s.tuple && s.mode === null && s.names.length === 1) this.topDecls.set(s.names[0]!, s);
    }
    const main = this.compileBlock(this.prog.body, this.globalScope, true);
    for (const fn of this.fns.values()) this.compileFnBody(fn);
    return { main, nslots: this.globalCtx.nslots, version: this.version };
  }

  private registerFn(s: Extract<Stmt, { k: "fn" }>, _origin: number): void {
    this.fns.set(s.name, {
      name: s.name,
      params: s.params.map((p) => p.name),
      paramSlots: [],
      defaults: [],
      body: () => Number.NaN,
      ctx: { nslots: 0, varSlots: new Set(), isGlobal: false },
      decl: s,
      compiled: false,
    });
  }

  private compileFnBody(fn: UserFn): void {
    if (fn.compiled) return;
    fn.compiled = true;
    const scope = new Scope(null, fn.ctx);
    fn.paramSlots = fn.decl.params.map((p) => {
      const slot = fn.ctx.nslots++;
      scope.vars.set(p.name, slot);
      return slot;
    });
    fn.defaults = fn.decl.params.map((p) => (p.def ? this.expr(p.def, scope) : null));
    fn.body = this.compileBlock(fn.decl.body, scope, false);
  }

  private scanAssigns(body: Stmt[]): void {
    const visitE = (e: Expr): void => {
      switch (e.k) {
        case "if":
          for (const b of e.branches) visitS(b.body);
          break;
        case "switch":
          for (const c of e.cases) visitS(c.body);
          break;
        case "for":
        case "forin":
        case "while":
          visitS(e.body);
          break;
        default:
          break;
      }
    };
    const visitS = (ss: Stmt[]): void => {
      for (const s of ss) {
        if (s.k === "assign") this.reassigned.add(s.name);
        else if (s.k === "expr") visitE(s.e);
        else if (s.k === "decl") visitE(s.e);
        else if (s.k === "fn") visitS(s.body);
      }
    };
    visitS(body);
  }

  // ---------------------------------------------------------------- bloklar ve deyimler
  private compileBlock(stmts: Stmt[], scope: Scope, top: boolean): Ev {
    const evs: Ev[] = [];
    for (const s of stmts) {
      if (s.k === "fn") {
        if (!top) throw syntaxError("Fonksiyonlar yalnız en üst düzeyde tanımlanabilir", s);
        continue;
      }
      const ev = this.stmt(s, scope);
      const line = s.line;
      evs.push((rt, f) => {
        rt.line = line;
        rt.tick();
        return ev(rt, f);
      });
    }
    if (evs.length === 1) return evs[0]!;
    return (rt, f) => {
      let v: unknown = Number.NaN;
      for (let i = 0; i < evs.length; i++) v = evs[i]!(rt, f);
      return v;
    };
  }

  private stmt(s: Stmt, scope: Scope): Ev {
    switch (s.k) {
      case "expr":
        return this.expr(s.e, scope);
      case "break":
        return () => {
          throw BREAK;
        };
      case "continue":
        return () => {
          throw CONTINUE;
        };
      case "decl":
        return this.decl(s, scope);
      case "assign":
        return this.assign(s, scope);
      case "fn":
        return () => Number.NaN;
    }
  }

  private decl(s: Extract<Stmt, { k: "decl" }>, scope: Scope): Ev {
    const ev = this.expr(s.e, scope);
    const isVar = s.mode !== null;
    const slots = s.names.map((nm) => {
      const slot = scope.fn.nslots++;
      scope.vars.set(nm, slot);
      if (isVar) scope.fn.varSlots.add(slot);
      return slot;
    });
    if (!s.tuple) {
      const slot = slots[0]!;
      if (isVar) {
        return (rt, f) => {
          if (!f.inited[slot]) {
            f.inited[slot] = true;
            const v = ev(rt, f);
            rt.assign(f, slot, v);
            return v;
          }
          const v = f.vals[slot];
          f.wbar[slot] = rt.bar;
          f.hist[slot]![rt.bar] = v;
          return v;
        };
      }
      return (rt, f) => {
        const v = ev(rt, f);
        rt.assign(f, slot, v);
        return v;
      };
    }
    return (rt, f) => {
      if (isVar && f.inited[slots[0]!]) {
        for (const sl of slots) rt.assign(f, sl, f.vals[sl]);
        return Number.NaN;
      }
      const v = ev(rt, f);
      const items = v instanceof PineTuple ? v.items : [];
      slots.forEach((sl, i) => {
        rt.assign(f, sl, i < items.length ? items[i] : Number.NaN);
        if (isVar) f.inited[sl] = true;
      });
      return Number.NaN;
    };
  }

  private assign(s: Extract<Stmt, { k: "assign" }>, scope: Scope): Ev {
    const slot = scope.lookup(s.name);
    if (slot === undefined) {
      if (!scope.fn.isGlobal && this.globalScope.vars.has(s.name)) {
        throw syntaxError(`Fonksiyon içinden genel değişken '${s.name}' değiştirilemez`, s);
      }
      throw syntaxError(`Tanımsız değişken '${s.name}' (önce '${s.name} = …' ile tanımlayın)`, s);
    }
    const isVar = scope.fn.varSlots.has(slot);
    const ev = this.expr(s.e, scope);
    const op = s.op;
    if (op === ":=") {
      return (rt, f) => {
        const v = ev(rt, f);
        rt.assign(f, slot, v);
        return v;
      };
    }
    return (rt, f) => {
      const cur = rt.read(f, slot, isVar);
      const r = ev(rt, f);
      let v: unknown;
      switch (op) {
        case "+=":
          v = typeof cur === "string" || typeof r === "string" ? `${String(cur)}${String(r)}` : num(cur) + num(r);
          break;
        case "-=":
          v = num(cur) - num(r);
          break;
        case "*=":
          v = num(cur) * num(r);
          break;
        case "/=":
          v = num(r) === 0 ? Number.NaN : num(cur) / num(r);
          break;
        default:
          v = num(r) === 0 ? Number.NaN : num(cur) % num(r);
      }
      rt.assign(f, slot, v);
      return v;
    };
  }

  // ---------------------------------------------------------------- ifadeler
  expr(e: Expr, scope: Scope): Ev {
    switch (e.k) {
      case "num": {
        const v = e.v;
        return () => v;
      }
      case "str": {
        const v = e.v;
        return () => v;
      }
      case "bool": {
        const v = e.v;
        return () => v;
      }
      case "color": {
        const v = e.v.length === 7 ? `${e.v}FF` : e.v;
        return () => v;
      }
      case "na":
        return () => Number.NaN;
      case "id":
        return this.ident(e.name, e, scope);
      case "tuple": {
        const items = e.items.map((x) => this.expr(x, scope));
        return (rt, f) => new PineTuple(items.map((x) => x(rt, f)));
      }
      case "un": {
        const a = this.expr(e.e, scope);
        if (e.op === "not") return (rt, f) => !truthy(a(rt, f));
        if (e.op === "-") return (rt, f) => -num(a(rt, f));
        return (rt, f) => num(a(rt, f));
      }
      case "bin":
        return this.binary(e, scope);
      case "tern": {
        const c = this.expr(e.c, scope);
        const a = this.expr(e.a, scope);
        const b = this.expr(e.b, scope);
        return (rt, f) => (truthy(c(rt, f)) ? a(rt, f) : b(rt, f));
      }
      case "index":
        return this.index(e, scope);
      case "call":
        return this.call(e, scope);
      case "if": {
        const bs = e.branches.map((b) => ({
          cond: b.cond ? this.expr(b.cond, scope) : null,
          body: this.compileBlock(b.body, new Scope(scope, scope.fn), false),
        }));
        return (rt, f) => {
          for (const b of bs) if (b.cond === null || truthy(b.cond(rt, f))) return b.body(rt, f);
          return Number.NaN;
        };
      }
      case "switch": {
        const subj = e.subject ? this.expr(e.subject, scope) : null;
        const cs = e.cases.map((c) => ({
          match: c.match ? this.expr(c.match, scope) : null,
          body: this.compileBlock(c.body, new Scope(scope, scope.fn), false),
        }));
        return (rt, f) => {
          const sv = subj ? subj(rt, f) : undefined;
          for (const c of cs) {
            if (c.match === null) return c.body(rt, f);
            const m = c.match(rt, f);
            if (subj ? eq(sv, m) : truthy(m)) return c.body(rt, f);
          }
          return Number.NaN;
        };
      }
      case "for":
        return this.forLoop(e, scope);
      case "forin":
        return this.forIn(e, scope);
      case "while": {
        const c = this.expr(e.cond, scope);
        const body = this.compileBlock(e.body, new Scope(scope, scope.fn), false);
        return (rt, f) => {
          let last: unknown = Number.NaN;
          let it = 0;
          while (truthy(c(rt, f))) {
            if (++it > MAX_LOOP) throw new LimitError("Döngü sınırı aşıldı (while)");
            rt.tick();
            try {
              last = body(rt, f);
            } catch (x) {
              if (x === BREAK) break;
              if (x === CONTINUE) continue;
              throw x;
            }
          }
          return last;
        };
      }
    }
  }

  private binary(e: Extract<Expr, { k: "bin" }>, scope: Scope): Ev {
    const l = this.expr(e.l, scope);
    const r = this.expr(e.r, scope);
    const lazy = this.version >= 6;
    switch (e.op) {
      case "+":
        return (rt, f) => {
          const a = l(rt, f);
          const b = r(rt, f);
          if (typeof a === "string" || typeof b === "string") {
            if (isNa(a) || isNa(b)) return Number.NaN;
            return `${String(a)}${String(b)}`;
          }
          return num(a) + num(b);
        };
      case "-":
        return (rt, f) => num(l(rt, f)) - num(r(rt, f));
      case "*":
        return (rt, f) => num(l(rt, f)) * num(r(rt, f));
      case "/":
        return (rt, f) => {
          const a = num(l(rt, f));
          const b = num(r(rt, f));
          return b === 0 ? Number.NaN : a / b;
        };
      case "%":
        return (rt, f) => {
          const a = num(l(rt, f));
          const b = num(r(rt, f));
          return b === 0 ? Number.NaN : a % b;
        };
      case "<":
        return (rt, f) => num(l(rt, f)) < num(r(rt, f));
      case ">":
        return (rt, f) => num(l(rt, f)) > num(r(rt, f));
      case "<=":
        return (rt, f) => num(l(rt, f)) <= num(r(rt, f));
      case ">=":
        return (rt, f) => num(l(rt, f)) >= num(r(rt, f));
      case "==":
        return (rt, f) => eq(l(rt, f), r(rt, f));
      case "!=":
        return (rt, f) => {
          const a = l(rt, f);
          const b = r(rt, f);
          return isNa(a) || isNa(b) ? false : a !== b;
        };
      case "and":
        if (lazy) return (rt, f) => truthy(l(rt, f)) && truthy(r(rt, f));
        return (rt, f) => {
          const a = truthy(l(rt, f));
          const b = truthy(r(rt, f));
          return a && b;
        };
      case "or":
        if (lazy) return (rt, f) => truthy(l(rt, f)) || truthy(r(rt, f));
        return (rt, f) => {
          const a = truthy(l(rt, f));
          const b = truthy(r(rt, f));
          return a || b;
        };
      default:
        throw syntaxError(`Bilinmeyen işleç '${e.op}'`, e);
    }
  }

  private ident(name: string, p: Pos, scope: Scope): Ev {
    const slot = scope.lookup(name);
    if (slot !== undefined) {
      const isVar = scope.fn.varSlots.has(slot);
      return (rt, f) => rt.read(f, slot, isVar);
    }
    if (!scope.fn.isGlobal) {
      const g = this.globalScope.vars.get(name);
      if (g !== undefined) {
        const isVar = this.globalCtx.varSlots.has(g);
        return (rt) => rt.read(rt.gframe, g, isVar);
      }
    }
    const direct = DIRECT_SERIES[name];
    if (direct) return (rt) => direct(rt.S)[rt.bar];
    if (SERIES_NAMES.has(name)) {
      return (rt) => seriesArray(rt.S, name)![rt.bar];
    }
    const vf = VARS[name];
    if (vf) return (rt) => vf(rt);
    if (name in CONSTS) {
      const v = CONSTS[name];
      return () => v;
    }
    if (name.startsWith("strategy.")) throw unsupported("Strateji betikleri desteklenmiyor (yalnız indicator/study)", p);
    if (drawingNs(name)) {
      const v = name.slice(name.lastIndexOf(".") + 1);
      return () => v;
    }
    if (this.fns.has(name) || name in FUNCS) throw syntaxError(`'${name}' bir fonksiyon; parantezle çağırın`, p);
    throw syntaxError(`Tanımsız ad: '${name}'`, p);
  }

  private index(e: Extract<Expr, { k: "index" }>, scope: Scope): Ev {
    const k = this.expr(e.idx, scope);
    const o = e.obj;
    if (o.k === "id") {
      const slot = scope.lookup(o.name);
      if (slot !== undefined) {
        const isVar = scope.fn.varSlots.has(slot);
        return (rt, f) => rt.readHist(f, slot, toInt(k(rt, f)), isVar);
      }
      if (!scope.fn.isGlobal && this.globalScope.vars.has(o.name)) {
        const g = this.globalScope.vars.get(o.name)!;
        const isVar = this.globalCtx.varSlots.has(g);
        return (rt, f) => rt.readHist(rt.gframe, g, toInt(k(rt, f)), isVar);
      }
      if (SERIES_NAMES.has(o.name)) {
        const direct = DIRECT_SERIES[o.name];
        const nm = o.name;
        return (rt, f) => {
          const kk = toInt(k(rt, f));
          const i = rt.bar - kk;
          if (!(kk >= 0) || i < 0) return Number.NaN;
          return (direct ? direct(rt.S) : seriesArray(rt.S, nm)!)[i];
        };
      }
    }
    // genel durum: ifadenin kendi gizli geçmişi
    const ev = this.expr(o, scope);
    const slot = scope.fn.nslots++;
    return (rt, f) => {
      rt.assign(f, slot, ev(rt, f));
      return rt.readHist(f, slot, toInt(k(rt, f)), false);
    };
  }

  private forLoop(e: Extract<Expr, { k: "for" }>, scope: Scope): Ev {
    const from = this.expr(e.from, scope);
    const to = this.expr(e.to, scope);
    const by = e.by ? this.expr(e.by, scope) : null;
    const inner = new Scope(scope, scope.fn);
    const slot = scope.fn.nslots++;
    inner.vars.set(e.v, slot);
    const body = this.compileBlock(e.body, inner, false);
    return (rt, f) => {
      const a = num(from(rt, f));
      const b = num(to(rt, f));
      if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
      let step = by ? Math.abs(num(by(rt, f))) : 1;
      if (!(step > 0)) step = 1;
      const dir = a <= b ? 1 : -1;
      let last: unknown = Number.NaN;
      let it = 0;
      for (let i = a; dir > 0 ? i <= b : i >= b; i += dir * step) {
        if (++it > MAX_LOOP) throw new LimitError("Döngü sınırı aşıldı (for)");
        rt.tick();
        rt.assign(f, slot, i);
        try {
          last = body(rt, f);
        } catch (x) {
          if (x === BREAK) break;
          if (x === CONTINUE) continue;
          throw x;
        }
      }
      return last;
    };
  }

  private forIn(e: Extract<Expr, { k: "forin" }>, scope: Scope): Ev {
    const arrEv = this.expr(e.arr, scope);
    const inner = new Scope(scope, scope.fn);
    const slots = e.vars.map((v) => {
      const s = scope.fn.nslots++;
      inner.vars.set(v, s);
      return s;
    });
    const body = this.compileBlock(e.body, inner, false);
    return (rt, f) => {
      const a = arrEv(rt, f);
      const items = a instanceof PineArray ? a.items : a instanceof PineTuple ? a.items : [];
      let last: unknown = Number.NaN;
      for (let i = 0; i < items.length; i++) {
        rt.tick();
        if (slots.length === 2) {
          rt.assign(f, slots[0]!, i);
          rt.assign(f, slots[1]!, items[i]);
        } else rt.assign(f, slots[0]!, items[i]);
        try {
          last = body(rt, f);
        } catch (x) {
          if (x === BREAK) break;
          if (x === CONTINUE) continue;
          throw x;
        }
      }
      return last;
    };
  }

  // ---------------------------------------------------------------- çağrılar
  private call(e: Extract<Expr, { k: "call" }>, scope: Scope): Ev {
    let name = e.callee;
    if (name === "request.security" || name === "security") return this.security(e, scope);
    if (name.startsWith("request.")) throw unsupported(`${name} desteklenmiyor (yalnız request.security)`, e);
    if (name === "input" || name.startsWith("input.")) return this.input(e, scope);
    if (name === "strategy" || name.startsWith("strategy.")) {
      throw unsupported("Strateji betikleri desteklenmiyor (yalnız indicator/study)", e);
    }
    if (name === "study") name = "indicator";

    // yöntem çağrısı: arr.push(x), s.length()
    const dot = name.indexOf(".");
    if (dot > 0) {
      const recv = name.slice(0, dot);
      if (scope.lookup(recv) !== undefined || (!scope.fn.isGlobal && this.globalScope.vars.has(recv))) {
        return this.methodCall(e, recv, name.slice(dot + 1), scope);
      }
    }
    const user = this.fns.get(name) ?? (aliasOf(name) ? this.fns.get(aliasOf(name)!) : undefined);
    if (user) return this.userCall(e, user, scope);
    const bdef = FUNCS[name] ?? (aliasOf(name) ? FUNCS[aliasOf(name)!] : undefined);
    if (bdef) return this.builtinCall(e, bdef, name, scope);
    const ns = drawingNs(name);
    if (ns) {
      const args = e.args.map((a) => this.expr(a, scope));
      const kind = ns;
      return (rt, f) => {
        for (const a of args) a(rt, f);
        rt.warn("Çizim nesneleri (label/line/box/table) henüz desteklenmiyor; yok sayıldı");
        return name.endsWith(".new") ? new PineDrawing(kind) : Number.NaN;
      };
    }
    throw syntaxError(`Bilinmeyen fonksiyon: '${e.callee}'`, e);
  }

  private builtinCall(e: Extract<Expr, { k: "call" }>, d: BuiltinDef, name: string, scope: Scope): Ev {
    const ordered = orderArgs(d.params, e.args, e.named, name, e);
    const evs = ordered.map((a) => (a ? this.expr(a, scope) : null));
    const site = e.site;
    const fn = d.fn;
    const nArgs = evs.length;
    const pos = posOf(e);
    return (rt, f) => {
      const a = new Array<unknown>(nArgs);
      for (let i = 0; i < nArgs; i++) {
        const ev = evs[i];
        a[i] = ev ? ev(rt, f) : undefined;
      }
      try {
        return fn(rt, f, site, a);
      } catch (x) {
        if (x instanceof PineError && x.line === 0 && x.kind !== "limit") {
          x.line = pos.line;
          x.col = pos.col;
        }
        throw x;
      }
    };
  }

  private userCall(e: Extract<Expr, { k: "call" }>, fn: UserFn, scope: Scope): Ev {
    const ordered = orderArgs(fn.params, e.args, e.named, fn.name, e);
    if (ordered.length > fn.params.length) {
      throw syntaxError(`${fn.name}: en çok ${fn.params.length} argüman alır`, e);
    }
    const evs = ordered.map((a) => (a ? this.expr(a, scope) : null));
    const site = e.site;
    const np = fn.params.length;
    return (rt, f) => {
      const argv = new Array<unknown>(np);
      for (let i = 0; i < np; i++) {
        const ev = evs[i];
        argv[i] = ev ? ev(rt, f) : undefined;
      }
      let child = f.kids.get(site);
      if (!child) {
        child = new Frame(fn.ctx.nslots);
        f.kids.set(site, child);
      }
      for (let i = 0; i < np; i++) {
        let v = argv[i];
        if (v === undefined) {
          const d = fn.defaults[i];
          if (!d) throw syntaxError(`${fn.name}: '${fn.params[i]}' argümanı eksik`, e);
          v = d(rt, child);
        }
        rt.assign(child, fn.paramSlots[i]!, v);
      }
      if (++rt.callDepth > 100) throw new PineError("Fonksiyon çağrı derinliği aşıldı", e.line, e.col, "limit");
      try {
        return fn.body(rt, child);
      } finally {
        rt.callDepth--;
      }
    };
  }

  private methodCall(e: Extract<Expr, { k: "call" }>, recv: string, method: string, scope: Scope): Ev {
    const recvEv = this.ident(recv, e, scope);
    const args = e.args.map((a) => this.expr(a, scope));
    const named = e.named;
    const site = e.site;
    return (rt, f) => {
      const r = recvEv(rt, f);
      const av = args.map((a) => a(rt, f));
      let fname: string | null = null;
      if (r instanceof PineArray) fname = `array.${method}`;
      else if (typeof r === "string" && `str.${method}` in FUNCS) fname = `str.${method}`;
      else if (r instanceof PineDrawing || isNa(r)) return Number.NaN;
      const d = fname ? FUNCS[fname] : undefined;
      if (!d) throw new PineError(`'${recv}.${method}' çağrılamıyor`, e.line, e.col, "runtime");
      const a = [r, ...av];
      for (const nm of named) {
        const i = d.params.indexOf(nm.name);
        if (i >= 0) a[i] = this.constOrNaN(nm.value);
      }
      return d.fn(rt, f, site, a);
    };
  }

  private constOrNaN(e: Expr): unknown {
    if (e.k === "num" || e.k === "str" || e.k === "bool") return e.v;
    return Number.NaN;
  }

  // ---------------------------------------------------------------- girdiler
  private input(e: Extract<Expr, { k: "call" }>, scope: Scope): Ev {
    const name = e.callee;
    const params = INPUT_PARAMS[name];
    if (!params) throw syntaxError(`Bilinmeyen girdi fonksiyonu: ${name}`, e);
    const ordered = orderArgs(params, e.args, e.named, name, e);
    const get = (key: string): Ev | null => {
      const i = params.indexOf(key);
      const a = i >= 0 ? ordered[i] : undefined;
      return a ? this.expr(a, scope) : null;
    };
    const defAst = ordered[0];
    const srcDefault = defAst && defAst.k === "id" && SOURCE_NAMES.includes(defAst.name) ? defAst.name : null;
    let fixedType: InputType | null = null;
    if (name !== "input") fixedType = (name === "input.enum" ? "string" : name.slice(6)) as InputType;
    const evDef = get("defval");
    const evTitle = get("title");
    const evType = get("type");
    const evMin = get("minval");
    const evMax = get("maxval");
    const evStep = get("step");
    const evOptions = get("options");
    const evTooltip = get("tooltip");
    const evGroup = get("group");
    const evInline = get("inline");
    const site = e.site;
    const intLiteral = defAst?.k === "num" && defAst.int;
    return (rt, f) => {
      let meta = rt.inputBySite.get(site);
      if (!meta) {
        const defval = srcDefault ? srcDefault : evDef ? evDef(rt, f) : Number.NaN;
        let type: InputType;
        if (fixedType) type = fixedType;
        else {
          const t = evType ? evType(rt, f) : undefined;
          if (typeof t === "string" && t) type = t as InputType;
          else if (srcDefault) type = "source";
          else if (typeof defval === "boolean") type = "bool";
          else if (typeof defval === "number") type = intLiteral ? "int" : "float";
          else if (typeof defval === "string" && defval.startsWith("#")) type = "color";
          else type = "string";
        }
        const title = evTitle ? String(evTitle(rt, f) ?? "") : "";
        let key = title || `Girdi ${rt.inputs.length + 1}`;
        while (rt.inputs.some((m) => m.key === key)) key = `${key}*`;
        const opt = evOptions ? evOptions(rt, f) : undefined;
        meta = {
          key,
          title: title || key,
          type: type === "source" && !srcDefault ? "float" : type,
          defval: type === "source" ? (srcDefault ?? "close") : defval,
          minval: evMin ? num(evMin(rt, f)) : undefined,
          maxval: evMax ? num(evMax(rt, f)) : undefined,
          step: evStep ? num(evStep(rt, f)) : undefined,
          options: opt instanceof PineTuple ? opt.items : opt instanceof PineArray ? opt.items : undefined,
          tooltip: evTooltip ? String(evTooltip(rt, f) ?? "") : undefined,
          group: evGroup ? String(evGroup(rt, f) ?? "") : undefined,
          inline: evInline ? String(evInline(rt, f) ?? "") : undefined,
        } satisfies InputMeta;
        rt.inputBySite.set(site, meta);
        if (rt.isMain) rt.inputs.push(meta);
        (meta as InputMeta & { value?: unknown }).value = resolveInput(meta, rt.inputValues[meta.key]);
      }
      const value = (meta as InputMeta & { value?: unknown }).value;
      if (meta.type === "source") {
        const arr = seriesArray(rt.S, String(value));
        return arr ? arr[rt.bar] : Number.NaN;
      }
      return value;
    };
  }

  // ---------------------------------------------------------------- request.security
  private security(e: Extract<Expr, { k: "call" }>, scope: Scope): Ev {
    const ordered = orderArgs(SECURITY_PARAMS, e.args, e.named, "request.security", e);
    const [symA, tfA, exprA, gapsA, laA] = ordered;
    if (!symA || !tfA || !exprA) throw syntaxError("request.security(symbol, timeframe, expression) eksik argüman", e);
    const symEv = this.expr(symA, scope);
    const tfEv = this.expr(tfA, scope);
    const gapsEv = gapsA ? this.expr(gapsA, scope) : null;
    const laEv = laA ? this.expr(laA, scope) : null;
    const inlined = this.inlineForSecurity(exprA, scope, new Set());
    const secCtx: FnCtx = { nslots: 0, varSlots: new Set(), isGlobal: true };
    const secScope = new Scope(null, secCtx);
    const exprEv = this.expr(inlined, secScope);
    const tupleLen = exprA.k === "tuple" ? exprA.items.length : 0;
    const site = e.site;
    const naVal = () => (tupleLen ? new PineTuple(new Array(tupleLen).fill(Number.NaN)) : Number.NaN);
    type SecState = {
      ctx: { S: SeriesCtx; frame: Frame; done: number; vals: unknown[]; map: Int32Array; lastJ: number } | null;
    };
    return (rt, f) => {
      const st = rt.st<SecState>(f, site, () => ({ ctx: null }));
      if (!st.ctx) {
        const req = resolveRequest(rt, symEv(rt, f), tfEv(rt, f), e);
        const same = req.symbol === rt.main.symbol && req.tfSec === rt.main.tfSec && !req.heikinAshi;
        const key = `${req.symbol}|${req.tfSec}|${req.heikinAshi ? "HA" : ""}`;
        const S2 = same ? rt.main : rt.extra.get(key);
        if (!S2) {
          if (!rt.missing.some((m) => m.symbol === req.symbol && m.tfSec === req.tfSec && m.heikinAshi === req.heikinAshi)) {
            rt.missing.push(req);
          }
          return naVal();
        }
        const la = laEv ? laEv(rt, f) : undefined;
        const lookahead = la === "lookahead_on" || la === true;
        st.ctx = { S: S2, frame: new Frame(secCtx.nslots), done: -1, vals: [], map: mapBars(rt.main, S2, lookahead), lastJ: -2 };
      }
      const c = st.ctx;
      if (rt.S !== rt.main) throw unsupported("İç içe request.security desteklenmiyor", e);
      const j = c.map[rt.bar]!;
      if (j < 0) return naVal();
      while (c.done < j) {
        c.done++;
        const saveS = rt.S;
        const saveBar = rt.bar;
        rt.S = c.S;
        rt.bar = c.done;
        rt.secDepth++;
        try {
          c.vals[c.done] = exprEv(rt, c.frame);
        } finally {
          rt.S = saveS;
          rt.bar = saveBar;
          rt.secDepth--;
        }
      }
      let v = c.vals[j];
      const g = gapsEv ? gapsEv(rt, f) : undefined;
      if ((g === "gaps_on" || g === true) && j === c.lastJ) v = naVal();
      c.lastJ = j;
      return v;
    };
  }

  /** Güvenlik ifadesindeki genel değişkenleri tanımlarıyla değiştirir; çağrı yerlerini yeniden numaralar. */
  private inlineForSecurity(e: Expr, scope: Scope, seen: Set<string>): Expr {
    const walk = (x: Expr): Expr => {
      switch (x.k) {
        case "id": {
          const local = scope.fn.isGlobal ? undefined : scope.lookup(x.name);
          if (local !== undefined) {
            throw unsupported(`request.security içinde yerel değişken '${x.name}' kullanılamıyor`, x);
          }
          const isGlobalVar = scope.fn.isGlobal ? scope.lookup(x.name) !== undefined : this.globalScope.vars.has(x.name);
          if (!isGlobalVar) return x;
          const d = this.topDecls.get(x.name);
          if (!d || this.reassigned.has(x.name)) {
            throw unsupported(
              `request.security içindeki '${x.name}' değişkeni := ile değiştiriliyor ya da var/demet; bu kullanım henüz desteklenmiyor. İfadeyi doğrudan request.security içine yazın.`,
              x,
            );
          }
          if (seen.has(x.name)) throw unsupported(`Döngüsel tanım: ${x.name}`, x);
          const next = new Set(seen);
          next.add(x.name);
          return this.inlineForSecurity(d.e, scope, next);
        }
        case "call": {
          const keepSite = x.callee === "input" || x.callee.startsWith("input.");
          return {
            ...x,
            site: keepSite ? x.site : this.siteCounter++,
            args: x.args.map(walk),
            named: x.named.map((nm) => ({ name: nm.name, value: walk(nm.value) })),
          };
        }
        case "index":
          return { ...x, site: this.siteCounter++, obj: walk(x.obj), idx: walk(x.idx) };
        case "un":
          return { ...x, e: walk(x.e) };
        case "bin":
          return { ...x, l: walk(x.l), r: walk(x.r) };
        case "tern":
          return { ...x, c: walk(x.c), a: walk(x.a), b: walk(x.b) };
        case "tuple":
          return { ...x, items: x.items.map(walk) };
        case "if":
        case "switch":
        case "for":
        case "forin":
        case "while":
          throw unsupported("request.security ifadesinde blok (if/for/switch) desteklenmiyor; bir fonksiyona taşıyın", x);
        default:
          return x;
      }
    };
    return walk(e);
  }
}

// ---------------------------------------------------------------- yardımcılar
function resolveInput(meta: InputMeta, provided: unknown): unknown {
  const v = provided === undefined ? meta.defval : provided;
  const clamp = (x: number) => {
    let y = x;
    if (meta.minval !== undefined && !Number.isNaN(meta.minval)) y = Math.max(meta.minval, y);
    if (meta.maxval !== undefined && !Number.isNaN(meta.maxval)) y = Math.min(meta.maxval, y);
    return y;
  };
  const inOptions = (x: unknown) => !meta.options || meta.options.includes(x);
  switch (meta.type) {
    case "int": {
      const x = Math.round(Number(v));
      return Number.isFinite(x) && inOptions(x) ? clamp(x) : meta.defval;
    }
    case "float":
    case "price": {
      const x = Number(v);
      return Number.isFinite(x) && inOptions(x) ? clamp(x) : meta.defval;
    }
    case "bool":
      return typeof v === "boolean" ? v : meta.defval;
    case "source":
      return typeof v === "string" && SOURCE_NAMES.includes(v) ? v : meta.defval;
    case "color":
      return typeof v === "string" && v.startsWith("#") ? (v.length === 7 ? `${v}FF` : v) : meta.defval;
    case "time":
      return typeof v === "number" ? v : meta.defval;
    default:
      return typeof v === "string" && inOptions(v) ? v : meta.defval;
  }
}

/** Pine sembol dizgisi → Binance sembolü ("BINANCE:ETHUSDT.P" → ETHUSDT, "HA:…" → Heikin Ashi). */
export function resolveRequest(rt: Runtime, sym: unknown, tf: unknown, p: Pos): DataRequest {
  let s = typeof sym === "string" ? sym.trim() : "";
  let ha = false;
  if (s.startsWith("HA:")) {
    ha = true;
    s = s.slice(3);
  }
  if (s.includes(":")) s = s.slice(s.indexOf(":") + 1);
  s = s.replace(/\.P$/i, "").replace(/PERP$/i, "").toUpperCase();
  if (!s) s = rt.main.symbol;
  const tfSec = tf === undefined || tf === "" || isNa(tf) ? rt.main.tfSec : tfToSec(tf);
  if (Number.isNaN(tfSec)) throw new PineError(`Geçersiz zaman dilimi: '${String(tf)}'`, p.line, p.col, "runtime");
  return { symbol: s, tfSec, heikinAshi: ha };
}

/**
 * Grafik mumu i için diğer zaman diliminin mum dizini (Pine anlamı):
 *  - lookahead_on: i'nin açılışını içeren (en son açılmış) mum;
 *  - lookahead_off: i'nin kapanışında kapanmış en son mum; canlı son mumda oluşan mum.
 */
export function mapBars(main: SeriesCtx, other: SeriesCtx, lookahead: boolean): Int32Array {
  const m = new Int32Array(main.n).fill(-1);
  let jOpen = -1;
  let jClose = -1;
  for (let i = 0; i < main.n; i++) {
    const t = main.time[i]!;
    const tc = t + main.tfSec * 1000;
    while (jOpen + 1 < other.n && other.time[jOpen + 1]! <= t) jOpen++;
    while (jClose + 1 < other.n && other.time[jClose + 1]! + other.tfSec * 1000 <= tc) jClose++;
    const realtimeLast = i === main.n - 1 && main.lastRealtime;
    m[i] = lookahead || realtimeLast ? jOpen : jClose;
  }
  return m;
}

let preludeCache: Program | null = null;
function preludeProgram(): Program {
  preludeCache ??= parse(PRELUDE);
  return preludeCache;
}

export function compile(source: string): Compiled {
  if (source.length > 64 * 1024) throw new PineError("Betik çok uzun (en çok 64 KB)", 0, 0, "limit");
  const prog = parse(source);
  return new Compiler(prog).compile();
}

export { BREAK, CONTINUE };
