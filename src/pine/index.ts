/** Pine yorumlayıcısının dış arayüzü: derle + mumlar üzerinde çalıştır → çizim verisi. */
import { compile, type Compiled } from "./compiler";
import { Frame, NeedData, Runtime, seriesFrom, type SeriesCtx } from "./engine";
import { PineError } from "./errors";
import type { BarsData, PineOutput, RunOptions, RunResult } from "./types";

export { compile } from "./compiler";
export { PineError } from "./errors";
export * from "./types";

function collect(rt: Runtime): PineOutput {
  if (!rt.metaSet && rt.main.n > 0) rt.warn("indicator(…) çağrısı bulunamadı; varsayılan ayarlar kullanıldı");
  return {
    meta: rt.meta,
    inputs: rt.inputs,
    plots: [...rt.plots.values()],
    shapes: [...rt.shapes.values()],
    barcolors: rt.barcolors,
    bgcolors: rt.bgcolors,
    hlines: [...rt.hlines.values()],
    alerts: [...rt.alerts.values()],
    logs: rt.logs,
    warnings: [...rt.warnings],
    stats: { bars: rt.main.n, ms: Date.now() - rt.started, ops: rt.ops },
  };
}

export function run(code: string | Compiled, bars: BarsData, opts: RunOptions = {}): RunResult {
  let rt: Runtime | null = null;
  try {
    const c = typeof code === "string" ? compile(code) : code;
    const main = seriesFrom(bars);
    const extra = new Map<string, SeriesCtx>();
    for (const [k, b] of Object.entries(opts.extra ?? {})) extra.set(k, seriesFrom(b, k.endsWith("|HA")));
    rt = new Runtime(main, c.version, {
      inputs: opts.inputs,
      extra,
      timeLimitMs: opts.timeLimitMs,
      maxOps: opts.maxOps,
    });
    rt.gframe = new Frame(c.nslots);
    for (let i = 0; i < main.n; i++) {
      rt.bar = i;
      c.main(rt, rt.gframe);
      if (rt.missing.length) throw new NeedData(rt.missing);
    }
    return { ok: true, output: collect(rt) };
  } catch (e) {
    if (e instanceof NeedData) return { ok: false, needData: e.requests };
    if (e instanceof PineError) {
      const line = e.line || rt?.line || 0;
      return { ok: false, error: { message: e.message, line, col: e.line ? e.col : 0, kind: e.kind } };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { message: `İç hata: ${msg}`, line: rt?.line ?? 0, col: 0, kind: "runtime" } };
  }
}

/** Yalnız sözdizimi denetimi (editör için hızlı). */
export function check(code: string): { ok: true } | { ok: false; error: { message: string; line: number; col: number } } {
  try {
    compile(code);
    return { ok: true };
  } catch (e) {
    if (e instanceof PineError) return { ok: false, error: { message: e.message, line: e.line, col: e.col } };
    return { ok: false, error: { message: String(e), line: 0, col: 0 } };
  }
}
