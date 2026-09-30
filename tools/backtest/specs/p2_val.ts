/** Doğrulama (bakış 1/2): dondurulmuş ayar (frozen.json), 2026-04 → 2026-06, geliştirme coinleri. */
import frozen from "../frozen.json";
import { DEV_COINS } from "../protocol";
import type { Spec } from "../sweep";

export default {
  name: "p2_val",
  script: frozen.script,
  coins: DEV_COINS,
  window: "val",
  tf: frozen.tf,
  configs: [frozen.inputs],
} satisfies Spec;
