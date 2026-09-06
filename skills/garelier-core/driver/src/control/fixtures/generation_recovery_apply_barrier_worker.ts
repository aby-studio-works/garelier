import { existsSync, writeFileSync } from "node:fs";
import { applyGenerationRecovery, planGenerationRecovery } from "../generation_recovery.ts";

const [root, ready, release] = process.argv.slice(2);
if (!root || !ready || !release) throw new Error("root, ready, and release paths are required");
const plan = planGenerationRecovery({ targetRoot: root, pmId: "pm1" });
applyGenerationRecovery({
  targetRoot: root, pmId: "pm1", expectedPlanDigest: plan.plan_digest, expectedGeneration: plan.generation, sessionId: "cs_apply_crash",
  hooks: { beforeRecoveryMutexRelease: () => {
    writeFileSync(ready, "ready\n", "utf8");
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(release)) Atomics.wait(cell, 0, 0, 10);
  } },
});
