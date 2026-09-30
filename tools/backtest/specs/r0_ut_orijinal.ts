/** T0: kütüphanedeki orijinal UT Bot Strateji (her sinyalde ters yöne geçer) 5 dk'da — referans. */
import { DEV_COINS } from "../protocol";
import type { Spec } from "../sweep";

export default {
  name: "r0_ut_orijinal",
  script: "src/pine/library/ut_bot_strategy.pine",
  coins: DEV_COINS,
  window: "dev",
  grid: { "Hassasiyet (anahtar değer)": [1, 2, 3] },
} satisfies Spec;
