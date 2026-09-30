/**
 * Ayar taraması: bir "spec" dosyasındaki ızgarayı coinler üzerinde paralel koşar, coin/çeyrek ölçütlerini yazar.
 * Kullanım: npm run bt:sweep -- tools/backtest/specs/<ad>.ts [--look val]
 * Yalnız geliştirme dönemi serbesttir; doğrulama `--look val` ister ve bakış kaydına yazılır (protocol.ts: LOOKS).
 * Son sınav bu araçla açılmaz (final.ts).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { quarterOf, ROOT, stats, type JobResult, type Stats, type Trade } from "./lib";
import { Pool } from "./pool";
import { CRITERIA, WINDOWS } from "./protocol";

export interface Spec {
  name: string;
  /** Kök dizine göre .pine yolu. */
  script: string;
  coins: string[];
  window: "dev" | "val";
  base?: Record<string, unknown>;
  /** Kartezyen çarpım; anahtarlar girdi başlıkları. */
  grid?: Record<string, unknown[]>;
  /** Izgara yerine açık ayar listesi (ör. doğrulamaya giden adaylar). */
  configs?: Record<string, unknown>[];
  where?: (cfg: Record<string, unknown>) => boolean;
  comm?: number;
  warmupDays?: number;
  /** Grafik zaman dilimi, saniye (varsayılan 300). */
  tf?: number;
}

export interface Row {
  cfg: Record<string, unknown>;
  pooled: Stats;
  coins: Record<string, Stats>;
  quarters: Record<string, Stats>;
  worstAvgRet: number;
  minCoinWinRate: number;
  minCoinTrades: number;
  feasible: boolean;
}

function expand(grid: Record<string, unknown[]>): Record<string, unknown>[] {
  let out: Record<string, unknown>[] = [{}];
  for (const [k, vals] of Object.entries(grid)) out = out.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  return out;
}

export function summarize(cfg: Record<string, unknown>, perCoin: Record<string, Trade[]>): Row {
  const all = Object.values(perCoin).flat();
  const coins = Object.fromEntries(Object.entries(perCoin).map(([s, ts]) => [s, stats(ts)]));
  const byQ = new Map<string, Trade[]>();
  for (const t of all) {
    const q = quarterOf(t.entryTime);
    let a = byQ.get(q);
    if (!a) byQ.set(q, (a = []));
    a.push(t);
  }
  const quarters = Object.fromEntries([...byQ.entries()].sort().map(([q, ts]) => [q, stats(ts)]));
  const cs = Object.values(coins);
  const pooled = stats(all);
  const minCoinWinRate = Math.min(...cs.map((s) => s.winRate));
  const minCoinTrades = Math.min(...cs.map((s) => s.n));
  const D = CRITERIA.dev;
  return {
    cfg,
    pooled,
    coins,
    quarters,
    worstAvgRet: Math.min(...cs.map((s) => s.avgRet)),
    minCoinWinRate,
    minCoinTrades,
    feasible: pooled.winRate >= D.pooledWinRate && minCoinWinRate >= D.perCoinWinRate && minCoinTrades >= D.minTradesPerCoin,
  };
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

export function cfgText(cfg: Record<string, unknown>): string {
  return Object.entries(cfg)
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
}

export function printRows(rows: Row[], title: string, limit = 15): void {
  console.log(`\n== ${title}`);
  console.log("kazanma%  ort.işlem%  PF    işlem  en kötü coin ort%  coin kazanma% (min)  belirsiz  ayar");
  for (const r of rows.slice(0, limit)) {
    const p = r.pooled;
    console.log(
      `${f(p.winRate, 1).padStart(7)}  ${f(p.avgRet, 3).padStart(10)}  ${f(p.pf).padStart(4)}  ${String(p.n).padStart(6)}  ${f(r.worstAvgRet, 3).padStart(17)}  ${f(r.minCoinWinRate, 1).padStart(19)}  ${String(p.amb).padStart(8)}  ${cfgText(r.cfg)}`,
    );
  }
}

/** Kazanma oranı eşiklerinde en iyi ortalama işlem getirisi (kazanma ↔ kâr dengesi). */
export function printFrontier(rows: Row[], minTrades: number): void {
  console.log("\n== Sınır tablosu (her eşikte en iyi toplam ortalama işlem %, coin başına işlem ≥ " + minTrades + ")");
  for (const th of [55, 60, 65, 70, 75, 80]) {
    const best = rows
      .filter((r) => r.pooled.winRate >= th && r.minCoinTrades >= minTrades)
      .sort((a, b) => b.pooled.avgRet - a.pooled.avgRet)[0];
    console.log(
      best
        ? `kazanma ≥ %${th}: ort ${f(best.pooled.avgRet, 3)}% · PF ${f(best.pooled.pf)} · kazanma ${f(best.pooled.winRate, 1)}% · ${best.pooled.n} işlem · ${cfgText(best.cfg)}`
        : `kazanma ≥ %${th}: yok`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("kullanım: sweep.ts <spec.ts> [--look val]");
  const spec = ((await import(resolve(file))) as { default: Spec }).default;
  const win = WINDOWS[spec.window];
  if (spec.window !== "dev" && !args.includes(`--look`)) throw new Error(`${win.name} dönemi yalnız --look ${spec.window} ile açılır (bakış hakkı sınırlı)`);
  const cfgs = (spec.configs ?? expand(spec.grid ?? {})).filter((c) => !spec.where || spec.where({ ...spec.base, ...c }));
  const pool = new Pool();
  const outDir = `${ROOT}.cache/results`;
  mkdirSync(outDir, { recursive: true });
  if (spec.window !== "dev") appendFileSync(`${outDir}/looks.log`, `${new Date().toISOString()} ${spec.name} ${spec.window} ${cfgs.length} ayar\n`);
  console.log(`${spec.name}: ${cfgs.length} ayar × ${spec.coins.length} coin, ${win.name}, ${pool.size} işçi`);
  const t0 = Date.now();
  let done = 0;
  const total = cfgs.length * spec.coins.length;
  const warns = new Set<string>();
  const rows = await Promise.all(
    cfgs.map(async (cfg) => {
      const perCoin: Record<string, Trade[]> = {};
      await Promise.all(
        spec.coins.map(async (symbol) => {
          const r: JobResult = await pool.run({
            script: `${ROOT}${spec.script}`,
            symbol,
            from: win.from,
            to: win.to,
            inputs: { ...spec.base, ...cfg },
            comm: spec.comm,
            warmupDays: spec.warmupDays,
            tf: spec.tf,
          });
          for (const w of r.warnings) warns.add(w);
          perCoin[symbol] = r.trades;
          done++;
          if (done % Math.max(1, Math.floor(total / 20)) === 0 || done === total) {
            const el = (Date.now() - t0) / 1000;
            process.stdout.write(`  ${done}/${total} koşu, ${el.toFixed(0)} sn, kalan ~${((el / done) * (total - done)).toFixed(0)} sn\n`);
          }
        }),
      );
      return summarize(cfg, perCoin);
    }),
  );
  await pool.close();
  writeFileSync(`${outDir}/${spec.name}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (warns.size) console.log("uyarılar:", [...warns]);
  const byRet = [...rows].sort((a, b) => b.pooled.avgRet - a.pooled.avgRet);
  printRows(byRet, "Toplam ortalama işlem getirisine göre");
  printRows(
    rows.filter((r) => r.feasible).sort((a, b) => b.worstAvgRet - a.worstAvgRet),
    `Geliştirme ölçütünü geçenler (kazanma ≥ %${CRITERIA.dev.pooledWinRate}, coin ≥ %${CRITERIA.dev.perCoinWinRate}, ≥ ${CRITERIA.dev.minTradesPerCoin} işlem/coin) — en kötü coine göre`,
  );
  printFrontier(rows, 30);
  console.log(`\nsonuçlar: .cache/results/${spec.name}.jsonl`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
