/**
 * Son sınav: dondurulmuş ayar (frozen.json) hiç bakılmamış veride BİR KEZ koşulur.
 *   A) Son sınav dönemi × 6 coin (geliştirme coinleri + görülmemiş coinler)
 *   B) Görülmemiş coinler (XRP, BNB, DOGE) × tüm veri dönemi
 * Rapor: kabul ölçütleri (protocol.ts), Wilson ve gün-blok bootstrap aralıkları, %0,065 komisyon stresi, gerçek
 * fonlama oranlarıyla düzeltilmiş getiri, 1 dk mumlarla belirsiz çıkış denetimi; orijinal UT Bot ile yan yana.
 * Kullanım: npm run bt:final -- [--frozen tools/backtest/frozen.json] [--window final|back] [--coins A,B]
 * Her çalıştırma .cache/results/looks.log'a yazılır (bakış hakkı: protocol.ts LOOKS).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { BARS_DIR, bootstrapAvgRet, loadBars, lowerBound, ROOT, stats, wilson, type Stats, type Trade } from "./lib";
import { Pool } from "./pool";
import { COMMISSION, CRITERIA, DEV_COINS, H_STUDY, HOLDOUT_COINS, L_STUDY, RESERVE_COINS, STRESS_COMMISSION, T_CHECK, WINDOWS, type Criteria, type Window } from "./protocol";

interface Frozen {
  script: string;
  inputs: Record<string, unknown>;
  /** Grafik zaman dilimi, saniye (varsayılan 300). */
  tf?: number;
  /** Test başından önce yüklenen gün (günlük trend göstergeleri için). */
  warmupDays?: number;
  /** Taban veri (lib.ts Job.data; uzun geçmiş çalışması "15m"). */
  data?: "5m" | "15m";
  note?: string;
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

// ------------------------------------------------------------------ fonlama

const FUND = new Map<string, [number, number][]>();
function funding(symbol: string): [number, number][] {
  let a = FUND.get(symbol);
  if (!a) {
    const p = `${BARS_DIR}/${symbol}_funding.json`;
    FUND.set(symbol, (a = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as [number, number][]) : []));
  }
  return a;
}

/** İşlem süresince ödenen/alınan fonlama (% , pozisyon değerine göre; long pozitif oranda öder). Veri bitince son 30 günün ortalaması. */
function fundingCost(symbol: string, t: Trade): { cost: number; estimated: boolean } {
  const fr = funding(symbol);
  if (!fr.length) return { cost: 0, estimated: true };
  const last = fr[fr.length - 1]![0];
  const recent = fr.filter(([ts]) => ts > last - 30 * 86_400_000);
  const avg = recent.reduce((s, [, r]) => s + r, 0) / recent.length;
  let sum = 0;
  let estimated = false;
  // fonlama 00:00, 08:00, 16:00 UTC; pozisyon o anda açıksa uygulanır
  const step = 8 * 3_600_000;
  for (let ts = Math.ceil((t.entryTime + 1) / step) * step; ts <= t.exitTime; ts += step) {
    if (ts > last) {
      sum += avg;
      estimated = true;
      continue;
    }
    let lo = 0;
    let hi = fr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (fr[m]![0] < ts) lo = m + 1;
      else hi = m;
    }
    const hit = fr[lo];
    if (hit && Math.abs(hit[0] - ts) < 60_000) sum += hit[1];
  }
  return { cost: t.dir * sum * 100, estimated };
}

// ------------------------------------------------------------------ belirsiz çıkışlar (1 dk ile)

const M1 = new Map<string, ReturnType<typeof loadBars>>();
/** TP ve SL aynı grafik mumundaysa 1 dk mumlarla hangisinin önce geldiğine bakar: "doğru" | "yanlış" | "çözülemez". */
function resolveAmb(symbol: string, t: Trade, tf: number): "doğru" | "yanlış" | "çözülemez" {
  let b = M1.get(symbol);
  if (!b) M1.set(symbol, (b = loadBars(symbol, "1m")));
  if (t.exitTime < b.time[0]!) return "çözülemez"; // 1 dk veri 2024-09'dan başlar
  const i0 = lowerBound(b.time, t.exitTime);
  for (let i = i0; i < i0 + tf / 60 && i < b.time.length; i++) {
    const hi = b.high[i]!;
    const lo = b.low[i]!;
    const tpHit = t.dir > 0 ? hi >= t.tp : lo <= t.tp;
    const slHit = t.dir > 0 ? lo <= t.sl : hi >= t.sl;
    if (tpHit && slHit) return "çözülemez";
    if (tpHit) return t.exit === "TP" ? "doğru" : "yanlış";
    if (slHit) return t.exit === "TP" ? "yanlış" : "doğru";
  }
  return "çözülemez";
}

// ------------------------------------------------------------------ koşu

let WARMUP: number | undefined;
let DATA: "5m" | "15m" | undefined;

async function runSet(pool: Pool, script: string, inputs: Record<string, unknown>, coins: string[], w: Window, comm: number, tf: number) {
  const res = await Promise.all(
    coins.map((symbol) => pool.run({ script: `${ROOT}${script}`, symbol, from: w.from, to: w.to, inputs, comm, tf, warmupDays: WARMUP, data: DATA })),
  );
  return Object.fromEntries(coins.map((c, k) => [c, res[k]!.trades])) as Record<string, Trade[]>;
}

function table(title: string, per: Record<string, Trade[]>, withFunding = false): { md: string; pooled: Stats; coins: Record<string, Stats> } {
  const rows: string[] = [`### ${title}`, "", "| Coin | İşlem | Kazanma % (Wilson %95) | Ort. işlem % | PF | Maks. ardışık kayıp | Belirsiz |", "|---|---|---|---|---|---|---|"];
  const coins: Record<string, Stats> = {};
  for (const [sym, ts] of Object.entries(per)) {
    const s = stats(ts);
    coins[sym] = s;
    const [lo, hi] = wilson(s.wins, s.n);
    rows.push(`| ${sym} | ${s.n} | ${f(s.winRate, 1)} (${f(lo, 1)}–${f(hi, 1)}) | ${f(s.avgRet, 3)} | ${f(s.pf)} | ${s.maxConsecLoss} | ${s.amb} |`);
  }
  const all = Object.values(per).flat();
  const p = stats(all);
  const [lo, hi] = wilson(p.wins, p.n);
  const [blo, bhi] = bootstrapAvgRet(all);
  rows.push(`| **Toplam** | ${p.n} | **${f(p.winRate, 1)}** (${f(lo, 1)}–${f(hi, 1)}) | ${f(p.avgRet, 3)} (${f(blo, 3)}…${f(bhi, 3)}) | ${f(p.pf)} | ${p.maxConsecLoss} | ${p.amb} |`);
  if (withFunding) {
    let est = 0;
    const adj = Object.entries(per).flatMap(([sym, ts]) =>
      ts.map((t) => {
        const fc = fundingCost(sym, t);
        if (fc.estimated) est++;
        return { ...t, ret: t.ret - fc.cost };
      }),
    );
    const q = stats(adj);
    rows.push("", `Fonlama dahil (gerçek oranlar${est ? `; ${est} işlemde son 30 günün ortalamasıyla tahmin` : ""}): kazanma ${f(q.winRate, 1)}%, ort. işlem ${f(q.avgRet, 3)}%, PF ${f(q.pf)}`);
  }
  return { md: rows.join("\n"), pooled: p, coins };
}

function verdict(pooled: Stats, coins: Record<string, Stats>, holdout: boolean, crit?: Criteria): string[] {
  const C = crit ?? (holdout ? CRITERIA.holdout : CRITERIA.final);
  const cs = Object.values(coins);
  const checks: [string, boolean][] = [];
  if (C.pooledWinRate !== undefined) checks.push([`Toplam kazanma ≥ %${C.pooledWinRate} (${f(pooled.winRate, 1)})`, pooled.winRate >= C.pooledWinRate]);
  checks.push(
    [`Toplam ort. işlem > %${C.pooledAvgRet} (${f(pooled.avgRet, 3)})`, pooled.avgRet > C.pooledAvgRet],
    [`Toplam PF > ${C.pooledPf} (${f(pooled.pf)})`, pooled.pf > C.pooledPf],
  );
  if (C.perCoinWinRate !== undefined)
    checks.push([`Her coinde kazanma ≥ %${C.perCoinWinRate} (en düşük ${f(Math.min(...cs.map((s) => s.winRate)), 1)})`, cs.every((s) => s.winRate >= C.perCoinWinRate!)]);
  if (C.pfCoins !== undefined)
    checks.push([`PF > 1 en az ${C.pfCoins}/${cs.length} coinde (${cs.filter((s) => s.pf > 1).length})`, cs.filter((s) => s.pf > 1).length >= C.pfCoins]);
  checks.push([`Bilgi: toplam kazanma oranı %${f(pooled.winRate, 1)}`, true]);
  return checks.map(([t, ok]) => `- ${ok ? "✅" : "❌"} ${t}`);
}

/** 1 saat / 4 saat çalışması (protocol.ts H_STUDY): asıl sınavlar hiç dokunulmamış verilerde, bir kez. */
async function studyH(frozen: Frozen, frozenPath: string, outDir: string): Promise<void> {
  const tf = frozen.tf ?? 3600;
  WARMUP = frozen.warmupDays;
  appendFileSync(`${outDir}/looks.log`, `${new Date().toISOString()} final.ts H_STUDY ${frozenPath}\n`);
  const pool = new Pool();
  const md: string[] = [
    `# 1s/4s çalışması — asıl sınavlar (hiç dokunulmamış veri), grafik ${tf / 3600} saat`,
    "",
    `Betik: \`${frozen.script}\``,
    "",
    "Ayar: `" + JSON.stringify(frozen.inputs) + "`" + (frozen.note ? ` — ${frozen.note}` : ""),
    "",
  ];
  const day = (w: Window) => `${new Date(w.from).toISOString().slice(0, 10)} → ${new Date(w.to).toISOString().slice(0, 10)}`;
  const tests: [string, string[], Window][] = [
    [`Asıl sınav 1: yedek coinler × ${day(H_STUDY.all)}`, RESERVE_COINS, H_STUDY.all],
    [`Asıl sınav 2: analiz coinleri × ${day(H_STUDY.back)}`, H_STUDY.analysisCoins, H_STUDY.back],
  ];
  for (const [title, coins, w] of tests) {
    const res = await runSet(pool, frozen.script, frozen.inputs, coins, w, COMMISSION, tf);
    const T = table(`${title}, komisyon %${COMMISSION}/taraf`, res, true);
    md.push(T.md, "", "**Kabul:**", ...verdict(T.pooled, T.coins, false, H_STUDY.criteria), "");
    const amb = { doğru: 0, yanlış: 0, çözülemez: 0 };
    for (const [sym, ts] of Object.entries(res)) for (const t of ts) if (t.amb) amb[resolveAmb(sym, t, tf)]++;
    md.push(`Belirsiz çıkışlar (1 dk ile): motor doğru ${amb.doğru}, yanlış ${amb.yanlış}, çözülemez ${amb.çözülemez}.`, "");
    const st = await runSet(pool, frozen.script, frozen.inputs, coins, w, STRESS_COMMISSION, tf);
    md.push(table(`Stres (%${STRESS_COMMISSION}/taraf): ${title}`, st).md, "");
  }
  md.push("## İkincil (daha önce Trend Avcısı için bir kez görülmüş veriler)", "");
  const fin = await runSet(pool, frozen.script, frozen.inputs, [...DEV_COINS, ...HOLDOUT_COINS], WINDOWS.final, COMMISSION, tf);
  md.push(table(`Son sınav dönemi × 6 coin (${day(WINDOWS.final)})`, fin, true).md, "");
  const hold = await runSet(pool, frozen.script, frozen.inputs, HOLDOUT_COINS, H_STUDY.all, COMMISSION, tf);
  md.push(table(`XRP/BNB/DOGE × ${day(H_STUDY.all)}`, hold, true).md, "");
  await pool.close();
  const text = md.join("\n");
  const file = `${outDir}/final-hstudy-${Date.now()}.md`;
  writeFileSync(file, text + "\n");
  console.log(text);
  console.log(`\nrapor: ${file}`);
}

/** Bileşik özsermaye (her işlemde %100): coin başına son çarpan ve en büyük düşüş (%), çıkış sırasıyla. */
function equityLine(per: Record<string, Trade[]>): string {
  const rows = Object.entries(per).map(([sym, ts]) => {
    let eq = 1;
    let peak = 1;
    let dd = 0;
    for (const t of [...ts].sort((a, b) => a.exitTime - b.exitTime)) {
      eq *= 1 + t.ret / 100;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, 1 - eq / peak);
    }
    return { sym, eq, dd };
  });
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const worst = rows.reduce((a, b) => (b.dd > a.dd ? b : a));
  return (
    `Bileşik özsermaye (her işlemde %100, coin başına): son değer medyanı ×${f(med(rows.map((r) => r.eq)))}, ` +
    `en büyük düşüş medyanı %${f(med(rows.map((r) => r.dd * 100)), 1)}, en kötü %${f(worst.dd * 100, 1)} (${worst.sym}).`
  );
}

/** Uzun geçmiş çalışması (protocol.ts L_STUDY): iki sınav, tek bakış. */
async function studyL(frozen: Frozen, frozenPath: string, outDir: string): Promise<void> {
  const tf = frozen.tf ?? 86400;
  WARMUP = frozen.warmupDays;
  DATA = frozen.data ?? "15m";
  appendFileSync(`${outDir}/looks.log`, `${new Date().toISOString()} final.ts L_STUDY ${frozenPath}\n`);
  const pool = new Pool();
  const md: string[] = [
    `# Uzun geçmiş çalışması — sınavlar, grafik ${tf >= 86400 ? `${tf / 86400} gün` : `${tf / 3600} saat`}`,
    "",
    `Betik: \`${frozen.script}\``,
    "",
    "Ayar: `" + JSON.stringify(frozen.inputs) + "`" + (frozen.note ? ` — ${frozen.note}` : ""),
    "",
  ];
  const day = (w: Window) => `${new Date(w.from + 3 * 3_600_000).toISOString().slice(0, 10)} → ${new Date(w.to + 3 * 3_600_000).toISOString().slice(0, 10)}`;
  const tests: [string, Window][] = [
    [`Sınav 1 (hiç görülmemiş): 15 coin × ${day(L_STUDY.exam1)}`, L_STUDY.exam1],
    [`Sınav 2: 15 coin × ${day(L_STUDY.exam2)}`, L_STUDY.exam2],
  ];
  for (const [title, w] of tests) {
    const res = await runSet(pool, frozen.script, frozen.inputs, L_STUDY.coins, w, COMMISSION, tf);
    const T = table(`${title}, komisyon %${COMMISSION}/taraf`, res, true);
    md.push(T.md, "", equityLine(res), "", "**Kabul:**", ...verdict(T.pooled, T.coins, false, L_STUDY.criteria), "");
    const amb = { doğru: 0, yanlış: 0, çözülemez: 0 };
    for (const [sym, ts] of Object.entries(res)) for (const t of ts) if (t.amb) amb[resolveAmb(sym, t, tf)]++;
    md.push(`Belirsiz çıkışlar (1 dk ile; 1 dk veri 2024-09'dan): motor doğru ${amb.doğru}, yanlış ${amb.yanlış}, çözülemez ${amb.çözülemez}.`, "");
    const st = await runSet(pool, frozen.script, frozen.inputs, L_STUDY.coins, w, STRESS_COMMISSION, tf);
    md.push(table(`Stres (%${STRESS_COMMISSION}/taraf): ${title}`, st).md, "");
  }
  await pool.close();
  const text = md.join("\n");
  const file = `${outDir}/final-lstudy-${Date.now()}.md`;
  writeFileSync(file, text + "\n");
  console.log(text);
  console.log(`\nrapor: ${file}`);
}

/** Trend Avcısı ek denetimi (protocol.ts T_CHECK): hiç görmediği 2020-01 → 2024-08, 15 coin, tek bakış. */
async function studyT(frozen: Frozen, frozenPath: string, outDir: string): Promise<void> {
  const tf = frozen.tf ?? 900;
  WARMUP = frozen.warmupDays;
  DATA = "15m";
  appendFileSync(`${outDir}/looks.log`, `${new Date().toISOString()} final.ts T_CHECK ${frozenPath}\n`);
  const pool = new Pool();
  const w = T_CHECK.window;
  const res = await runSet(pool, frozen.script, frozen.inputs, L_STUDY.coins, w, COMMISSION, tf);
  const T = table(`Trend Avcısı × 15 coin × 2020-01-01 → 2024-08-31 (hiç görülmemiş), komisyon %${COMMISSION}/taraf`, res, true);
  const md: string[] = [`# Trend Avcısı ek denetimi`, "", `Betik: \`${frozen.script}\`, ayar: \`${JSON.stringify(frozen.inputs)}\``, "", T.md, ""];
  md.push(equityLine(res), "", "**Kabul:**", ...verdict(T.pooled, T.coins, false, T_CHECK.criteria), "");
  const years: Record<string, Trade[]> = {};
  for (const ts of Object.values(res)) for (const t of ts) (years[new Date(t.entryTime + 3 * 3_600_000).getUTCFullYear()] ||= []).push(t);
  md.push("| Yıl | İşlem | Kazanma % | Ort. işlem % | PF |", "|---|---|---|---|---|");
  for (const [y, ts] of Object.entries(years).sort()) {
    const st = stats(ts);
    md.push(`| ${y} | ${st.n} | ${f(st.winRate, 1)} | ${f(st.avgRet, 3)} | ${f(st.pf)} |`);
  }
  md.push("");
  const st = await runSet(pool, frozen.script, frozen.inputs, L_STUDY.coins, w, STRESS_COMMISSION, tf);
  md.push(table(`Stres (%${STRESS_COMMISSION}/taraf)`, st).md, "");
  await pool.close();
  const text = md.join("\n");
  const file = `${outDir}/final-tcheck-${Date.now()}.md`;
  writeFileSync(file, text + "\n");
  console.log(text);
  console.log(`\nrapor: ${file}`);
}

async function main(): Promise<void> {
  const frozenPath = arg("frozen") ?? "tools/backtest/frozen.json";
  const frozen = JSON.parse(readFileSync(`${ROOT}${frozenPath}`, "utf8")) as Frozen;
  if (process.argv.includes("--study-t")) {
    const outDirT = `${ROOT}.cache/results`;
    mkdirSync(outDirT, { recursive: true });
    return studyT(frozen, frozenPath, outDirT);
  }
  if (process.argv.includes("--study-l")) {
    const outDirL = `${ROOT}.cache/results`;
    mkdirSync(outDirL, { recursive: true });
    return studyL(frozen, frozenPath, outDirL);
  }
  if (process.argv.includes("--study-h")) {
    const outDirH = `${ROOT}.cache/results`;
    mkdirSync(outDirH, { recursive: true });
    return studyH(frozen, frozenPath, outDirH);
  }
  const w = WINDOWS[(arg("window") ?? "final") as keyof typeof WINDOWS];
  const coins = arg("coins")?.split(",") ?? [...DEV_COINS, ...HOLDOUT_COINS];
  const outDir = `${ROOT}.cache/results`;
  mkdirSync(outDir, { recursive: true });
  appendFileSync(`${outDir}/looks.log`, `${new Date().toISOString()} final.ts ${w.key} ${coins.join(",")} ${frozenPath}\n`);
  const pool = new Pool();
  const tf = frozen.tf ?? 300;
  WARMUP = frozen.warmupDays;
  const md: string[] = [
    `# ${w.name}: ${new Date(w.from).toISOString()} → ${new Date(w.to).toISOString()}`,
    "",
    `Betik: \`${frozen.script}\` · grafik ${tf / 60} dk`,
    "",
    "Ayar: `" + JSON.stringify(frozen.inputs) + "`" + (frozen.note ? ` — ${frozen.note}` : ""),
    "",
  ];

  const main = await runSet(pool, frozen.script, frozen.inputs, coins, w, COMMISSION, tf);
  const A = table(`UT Bot Pro — ${w.name}, komisyon %${COMMISSION}/taraf`, main, true);
  md.push(A.md, "", "**Kabul:**", ...verdict(A.pooled, A.coins, false), "");

  const amb = { doğru: 0, yanlış: 0, çözülemez: 0 };
  for (const [sym, ts] of Object.entries(main)) for (const t of ts) if (t.amb) amb[resolveAmb(sym, t, tf)]++;
  md.push(`Belirsiz çıkışlar (1 dk ile): motor doğru ${amb.doğru}, yanlış ${amb.yanlış}, çözülemez ${amb.çözülemez}.`, "");

  const stress = await runSet(pool, frozen.script, frozen.inputs, coins, w, STRESS_COMMISSION, tf);
  md.push(table(`Stres: komisyon %${STRESS_COMMISSION}/taraf`, stress).md, "");

  const orig = await runSet(pool, "src/pine/library/ut_bot_strategy.pine", {}, coins, w, COMMISSION, tf);
  md.push(table("Karşılaştırma: orijinal UT Bot Strateji (varsayılan)", orig).md, "");

  if (w.key === "final") {
    const full: Window = { key: "all", name: "Tüm dönem", from: WINDOWS.back.from, to: WINDOWS.final.to };
    const hold = await runSet(pool, frozen.script, frozen.inputs, HOLDOUT_COINS, full, COMMISSION, tf);
    const H = table(`Görülmemiş coinler — tüm dönem (${new Date(full.from).toISOString().slice(0, 10)} → ${new Date(full.to).toISOString().slice(0, 10)})`, hold, true);
    md.push(H.md, "", "**Kabul (görülmemiş coinler):**", ...verdict(H.pooled, H.coins, true), "");
  }
  await pool.close();
  const text = md.join("\n");
  const file = `${outDir}/final-${w.key}-${Date.now()}.md`;
  writeFileSync(file, text + "\n");
  console.log(text);
  console.log(`\nrapor: ${file}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
