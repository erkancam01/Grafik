/** Doğrulama (bakış 1/2): o anda dondurulmuş UT Bot Pro kuralı, 2026-04 → 2026-06, geliştirme coinleri. Sonuç: tutmadı. */
import { DEV_COINS } from "../protocol";
import type { Spec } from "../sweep";

export default {
  name: "p2_val",
  script: "tools/backtest/pine/ut_bot_pro_strategy.pine",
  coins: DEV_COINS,
  window: "val",
  tf: 900,
  configs: [{}],
} satisfies Spec;
