/** Momentum 4s — htf_momentum.py'den seçilen kural, dev2 (15 ay), 8 analiz coini, motorla doğrulama. */
import { H_STUDY } from "../protocol";
import type { Spec } from "../sweep";

export default {
  name: "m1_dev2",
  script: "tools/backtest/pine/momentum_4s_strategy.pine",
  coins: H_STUDY.analysisCoins,
  window: "dev2",
  tf: 14400,
  warmupDays: 60,
  grid: {},
} satisfies Spec;
