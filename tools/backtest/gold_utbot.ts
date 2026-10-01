/**
 * Altında UT Bot (kütüphanedeki UT Bot Strateji, varsayılan ayarlar: anahtar 1, ATR 10): haftalık, günlük, 4 saat, 1 saat.
 * Uygulamanın Pine motoru (Runner, 15 dk taban veriden üst zaman dilimi; haftalık mumlar pazartesi başlar).
 * İki biçim: "Her ikisi" (Al'da long, Sat'ta short — kütüphane varsayılanı) ve "Yalnız long" (Sat yalnız kapatır).
 * Seriler: spot PAXGUSDT (2020-08 →, uzun geçmiş) ve vadeli XAUUSDT (2025-12 →). Al-ve-tut ile karşılaştırılır.
 * Kullanım: node --import jiti/register tools/backtest/gold_utbot.ts  →  .cache/results/gold_utbot.md
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadBars, lowerBound, ROOT, stats, type Trade } from "./lib";
import { Pool } from "./pool";
import { dayEnd, dayStart } from "./protocol";

const TFS: [string, number][] = [["1 hafta", 604_800], ["1 gün", 86_400], ["4 saat", 14_400], ["1 saat", 3_600]];
const SERIES: [string, string][] = [["SPOT-PAXGUSDT", "2021-01-01"], ["XAUUSDT", "2026-01-01"]];
const MODES: [string, Record<string, unknown>][] = [["Al→long, Sat→short", {}], ["yalnız long", { "İşlem yönü": "Yalnız long" }]];
const TO = "2026-09-29";
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d).replace(".", ",") : "—");

function equity(ts: Trade[]): { mult: number; dd: number } {
  let eq = 1;
  let peak = 1;
  let dd = 0;
  for (const t of [...ts].sort((a, b) => a.exitTime - b.exitTime)) {
    eq *= 1 + t.ret / 100;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, 1 - eq / peak);
  }
  return { mult: eq, dd };
}

function buyHold(sym: string, from: number, to: number): number {
  const b = loadBars(sym, "15m");
  const i0 = lowerBound(b.time, from);
  const i1 = lowerBound(b.time, to + 1) - 1;
  return (b.close[i1]! / b.open[i0]! - 1) * 100;
}

async function main(): Promise<void> {
  const pool = new Pool();
  const md: string[] = ["# Altında UT Bot (varsayılan ayarlar)", "", "Komisyon %0,05/taraf, işlem başına sermayenin %100'ü; net = bileşik getiri.", ""];
  for (const [sym, start] of SERIES) {
    const from = dayStart(start);
    const to = dayEnd(TO);
    const bh = buyHold(sym, from, to);
    md.push(`## ${sym}: ${start} → ${TO} (al-ve-tut %${f(bh, 1)})`, "");
    md.push("| grafik | biçim | işlem | kazanma % | ort. işlem % | PF | net % | maks. düşüş % | yıllar (işlem / ort. %) |", "|---|---|---|---|---|---|---|---|---|");
    const jobs = TFS.flatMap(([tfName, tf]) => MODES.map(([mName, inputs]) => ({ tfName, tf, mName, inputs })));
    const res = await Promise.all(
      jobs.map((j) => pool.run({ script: `${ROOT}src/pine/library/ut_bot_strategy.pine`, symbol: sym, from, to, inputs: j.inputs, tf: j.tf, data: "15m", warmupDays: 200 })),
    );
    jobs.forEach((j, k) => {
      const ts = res[k]!.trades;
      const st = stats(ts);
      const eq = equity(ts);
      const years: Record<string, Trade[]> = {};
      for (const t of ts) (years[new Date(t.entryTime).getUTCFullYear()] ||= []).push(t);
      const ys = Object.entries(years)
        .sort()
        .map(([y, v]) => `${y}: ${v.length} / ${f(stats(v).avgRet, 1)}`)
        .join("; ");
      md.push(`| ${j.tfName} | ${j.mName} | ${st.n} | ${f(st.winRate, 1)} | ${f(st.avgRet, 2)} | ${f(st.pf)} | ${f((eq.mult - 1) * 100, 1)} | ${f(eq.dd * 100, 1)} | ${ys} |`);
    });
    md.push("");
  }
  await pool.close();
  const text = md.join("\n");
  mkdirSync(`${ROOT}.cache/results`, { recursive: true });
  writeFileSync(`${ROOT}.cache/results/gold_utbot.md`, text + "\n");
  console.log(text);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
