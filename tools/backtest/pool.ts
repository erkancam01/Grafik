/** İşçi havuzu: işleri çekirdek sayısı kadar iş parçacığına dağıtır (çalıştırma: node --import jiti/register). */
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { Job, JobResult } from "./lib";

interface Pending {
  job: Job;
  res: (r: JobResult) => void;
  rej: (e: Error) => void;
}

type Reply = { ok: true; r: JobResult } | { ok: false; e: string };

export class Pool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Pending[] = [];
  private readonly busy = new Map<Worker, Pending>();

  constructor(n = availableParallelism()) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url));
      w.on("message", (m: Reply) => {
        const p = this.busy.get(w);
        this.busy.delete(w);
        if (p) {
          if (m.ok) p.res(m.r);
          else p.rej(new Error(m.e));
        }
        this.next(w);
      });
      w.on("error", (e) => {
        const p = this.busy.get(w);
        this.busy.delete(w);
        p?.rej(e instanceof Error ? e : new Error(String(e)));
      });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  run(job: Job): Promise<JobResult> {
    return new Promise((res, rej) => {
      this.queue.push({ job, res, rej });
      while (this.idle.length && this.queue.length) this.dispatch(this.idle.pop()!, this.queue.shift()!);
    });
  }

  private next(w: Worker): void {
    const p = this.queue.shift();
    if (p) this.dispatch(w, p);
    else this.idle.push(w);
  }

  private dispatch(w: Worker, p: Pending): void {
    this.busy.set(w, p);
    w.postMessage(p.job);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
