/** Günlük Momentum — long_study.py'nin seçtiği kural, uzun geçmiş geliştirme dönemi (2020-2022), 15 coin, motorla doğrulama. */
import { L_STUDY } from "../protocol";
import type { Spec } from "../sweep";

export default {
  name: "g1_ldev",
  script: "tools/backtest/pine/gunluk_momentum_strategy.pine",
  coins: L_STUDY.coins,
  window: "ldev",
  tf: 86400,
  data: "15m",
  warmupDays: 120,
  grid: {},
} satisfies Spec;
