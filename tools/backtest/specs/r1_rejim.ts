/** Rejim Strateji (günlük) — güncel seçim, 2021-01 → 2026-09 × 15 coin, motorla (laboratuvarla eşleşme denetimi). */
import { L_STUDY } from "../protocol";
import type { Spec } from "../sweep";

export default {
  name: "r1_rejim",
  script: "src/pine/library/rejim_strategy.pine",
  coins: L_STUDY.coins,
  window: "rall",
  tf: 86400,
  data: "15m",
  warmupDays: 365,
  grid: {},
} satisfies Spec;
