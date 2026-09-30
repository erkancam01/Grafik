/** Pine sözdizim ağacı. Her düğüm konum taşır; çağrı/geçmiş/bildirim düğümleri benzersiz `site` numarası alır. */
import type { Pos } from "./errors";

export interface Named {
  name: string;
  value: Expr;
}

export type Expr =
  | ({ k: "num"; v: number; int: boolean } & Pos)
  | ({ k: "str"; v: string } & Pos)
  | ({ k: "bool"; v: boolean } & Pos)
  | ({ k: "na" } & Pos)
  | ({ k: "color"; v: string } & Pos)
  | ({ k: "id"; name: string } & Pos)
  | ({ k: "call"; callee: string; args: Expr[]; named: Named[]; site: number; generic: string | null } & Pos)
  | ({ k: "index"; obj: Expr; idx: Expr; site: number } & Pos)
  | ({ k: "un"; op: "-" | "+" | "not"; e: Expr } & Pos)
  | ({ k: "bin"; op: string; l: Expr; r: Expr } & Pos)
  | ({ k: "tern"; c: Expr; a: Expr; b: Expr } & Pos)
  | ({ k: "if"; branches: { cond: Expr | null; body: Stmt[] }[] } & Pos)
  | ({ k: "switch"; subject: Expr | null; cases: { match: Expr | null; body: Stmt[] }[] } & Pos)
  | ({ k: "for"; v: string; from: Expr; to: Expr; by: Expr | null; body: Stmt[]; site: number } & Pos)
  | ({ k: "forin"; vars: string[]; arr: Expr; body: Stmt[]; site: number } & Pos)
  | ({ k: "while"; cond: Expr; body: Stmt[] } & Pos)
  | ({ k: "tuple"; items: Expr[] } & Pos);

export interface Param {
  name: string;
  def: Expr | null;
}

export type Stmt =
  | ({ k: "decl"; names: string[]; tuple: boolean; mode: "var" | "varip" | null; type: string | null; e: Expr; site: number } & Pos)
  | ({ k: "assign"; name: string; op: string; e: Expr } & Pos)
  | ({ k: "expr"; e: Expr } & Pos)
  | ({ k: "fn"; name: string; params: Param[]; body: Stmt[] } & Pos)
  | ({ k: "break" } & Pos)
  | ({ k: "continue" } & Pos);

export interface Program {
  body: Stmt[];
  version: number;
  /** Tüm çağrı/geçmiş/bildirim yerlerinin sayısı. */
  sites: number;
}
