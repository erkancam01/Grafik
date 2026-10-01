/** Deneme işçisi: mumları ve derlenmiş betikleri önbelleğe alır, gelen işleri sırayla koşar. */
import { parentPort } from "node:worker_threads";
import { Runner, type Job } from "./lib";

const runner = new Runner();

parentPort!.on("message", (job: Job) => {
  try {
    parentPort!.postMessage({ ok: true, r: runner.run(job) });
  } catch (e) {
    parentPort!.postMessage({ ok: false, e: e instanceof Error ? e.message : String(e) });
  }
});
