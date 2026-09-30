import { STRATEGY_CONSTS, STRATEGY_FUNCS, STRATEGY_VARS } from "../strategy";
import { CORE, CORE_V4_ALIASES, TIME_PARTS } from "./core";
import { OUTPUT } from "./output";
import { def, n, type BuiltinDef } from "./registry";
import { TA, TA_V4_ALIASES } from "./ta";
import { CONSTS as BASE_CONSTS, VARS as BASE_VARS } from "./vars";

const TIME_FNS: Record<string, BuiltinDef> = Object.fromEntries(
  Object.entries(TIME_PARTS).map(([name, fn]) => [
    name,
    def(["time", "timezone"], (_rt, _f, _s, a) => {
      const t = n(a[0]);
      return Number.isNaN(t) ? Number.NaN : fn(new Date(t));
    }),
  ]),
);

export const FUNCS: Record<string, BuiltinDef> = { ...TA, ...CORE, ...OUTPUT, ...TIME_FNS, ...STRATEGY_FUNCS };
export const VARS: Record<string, (rt: import("../engine").Runtime) => unknown> = { ...BASE_VARS, ...STRATEGY_VARS };
export const CONSTS: Record<string, unknown> = { ...BASE_CONSTS, ...STRATEGY_CONSTS };

/** v4 (öneksiz) ad → v5 adı. */
export function aliasOf(name: string): string | null {
  if (name in CORE_V4_ALIASES) return CORE_V4_ALIASES[name]!;
  if (TA_V4_ALIASES.includes(name)) return `ta.${name}`;
  return null;
}

export { PRELUDE } from "./prelude";
export { SERIES_NAMES, seriesArray, drawingNs } from "./vars";
