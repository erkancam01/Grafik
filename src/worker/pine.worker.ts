/// <reference lib="webworker" />
/** Pine yorumlayıcısı ayrı iş parçacığında: arayüz donmaz. Derlenmiş betikler önbellekte tutulur. */
import { compile, type Compiled } from "../pine/compiler";
import { run } from "../pine";
import { PineError } from "../pine/errors";
import type { BarsData, RunResult } from "../pine/types";

export interface WorkerRequest {
  id: number;
  code: string;
  bars: BarsData;
  inputs: Record<string, unknown>;
  extra: Record<string, BarsData>;
}

export interface WorkerResponse {
  id: number;
  result: RunResult;
}

const cache = new Map<string, Compiled>();

function compiled(code: string): Compiled {
  let c = cache.get(code);
  if (!c) {
    c = compile(code);
    if (cache.size > 30) cache.delete(cache.keys().next().value!);
    cache.set(code, c);
  }
  return c;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { id, code, bars, inputs, extra } = ev.data;
  let result: RunResult;
  try {
    result = run(compiled(code), bars, { inputs, extra, timeLimitMs: 8000 });
  } catch (e) {
    const pe = e instanceof PineError ? e : null;
    result = {
      ok: false,
      error: {
        message: pe ? pe.message : e instanceof Error ? e.message : String(e),
        line: pe?.line ?? 0,
        col: pe?.col ?? 0,
        kind: pe?.kind ?? "runtime",
      },
    };
  }
  (self as unknown as Worker).postMessage({ id, result } satisfies WorkerResponse);
};
