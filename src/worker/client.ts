/** Worker istemcisi: istek/yanıt eşleme, zaman aşımında worker yeniden başlatılır. */
import type { BarsData, RunResult } from "../pine/types";
import type { WorkerRequest, WorkerResponse } from "./pine.worker";

type Pending = { resolve: (r: RunResult) => void; timer: ReturnType<typeof setTimeout> };

export class PineWorker {
  private w: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  private worker(): Worker {
    if (!this.w) {
      this.w = new Worker(new URL("./pine.worker.ts", import.meta.url), { type: "module" });
      this.w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(ev.data.id);
        p.resolve(ev.data.result);
      };
    }
    return this.w;
  }

  run(code: string, bars: BarsData, inputs: Record<string, unknown>, extra: Record<string, BarsData>): Promise<RunResult> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.restart();
        resolve({ ok: false, error: { message: "Betik zaman aşımına uğradı (15 sn)", line: 0, col: 0, kind: "limit" } });
      }, 15_000);
      this.pending.set(id, { resolve, timer });
      this.worker().postMessage({ id, code, bars, inputs, extra } satisfies WorkerRequest);
    });
  }

  private restart(): void {
    this.w?.terminate();
    this.w = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: { message: "Yorumlayıcı yeniden başlatıldı", line: 0, col: 0, kind: "limit" } });
      this.pending.delete(id);
    }
  }
}
