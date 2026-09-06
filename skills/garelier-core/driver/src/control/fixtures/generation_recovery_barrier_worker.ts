import { existsSync, writeFileSync } from "node:fs";
import { planGenerationRecovery } from "../generation_recovery.ts";

const [root, ready, release, phase = "namespace"] = process.argv.slice(2);
if (!root || !ready || !release) throw new Error("root, ready, and release paths are required");

const plan = planGenerationRecovery({
  targetRoot: root,
  pmId: "pm1",
  hooks: {
    ...(phase === "epoch" ? { afterRecoveryEpochAcquire: barrier } : {}),
    ...(phase === "release-open" ? { afterRecoveryReleaseTempOpen: barrier } : {}),
    ...(phase === "release-write" ? { afterRecoveryReleaseTempWrite: barrier } : {}),
    ...(phase === "release-rename" ? { afterRecoveryReleaseRename: barrier } : {}),
    ...(phase === "prune-rename" ? { afterRecoveryEpochPruneRename: barrier, recoveryEpochEntryCap: 4 } : {}),
    ...(phase === "namespace" ? { beforeRecoveryMutexRelease: barrier } : {}),
  },
});
process.stdout.write(`${JSON.stringify(plan)}\n`);

function barrier(): void {
      writeFileSync(ready, "ready\n", "utf8");
      const cell = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(release)) Atomics.wait(cell, 0, 0, 10);
}
