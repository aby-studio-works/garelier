import { existsSync, writeFileSync } from "node:fs";
import { writeControlGenerationFile } from "../generation.ts";

const [runtimeRoot, aReady, aRelease, bReady, bRelease] = process.argv.slice(2);
if (!runtimeRoot || !aReady || !aRelease || !bReady || !bRelease) throw new Error("runtime and A/B barrier paths are required");

publish(4, aReady, aRelease);
publish(6, bReady, bRelease);

function publish(generation: number, ready: string, release: string): void {
  writeControlGenerationFile(runtimeRoot, `${JSON.stringify({
    schema_version: 2,
    kind: "garelier_control_generation",
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    incarnation: "00000000-0000-4000-8000-000000000001",
    generation,
    state: "stable",
    operation: "deterministic-gap",
    session_id: "cs_deterministic_gap",
    updated_at: new Date().toISOString(),
  })}\n`, {
    afterMovePrevious: () => {
      writeFileSync(ready, "ready\n", "utf8");
      const cell = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(release)) Atomics.wait(cell, 0, 0, 5);
    },
  });
}
