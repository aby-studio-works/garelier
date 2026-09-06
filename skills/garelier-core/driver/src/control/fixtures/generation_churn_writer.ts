import { existsSync, writeFileSync } from "node:fs";
import { writeControlGenerationFile } from "../generation.ts";

const [runtimeRoot, readyPath, startPath, donePath, countSource = "3000"] = process.argv.slice(2);
if (!runtimeRoot || !readyPath || !startPath || !donePath) throw new Error("runtime, ready, start, and done paths are required");
const count = Number(countSource);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("count must be a positive safe integer");

writeFileSync(readyPath, "ready\n", "utf8");
const cell = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(startPath)) Atomics.wait(cell, 0, 0, 5);
for (let index = 0; index < count; index++) {
  const generation = 4 + index * 2;
  writeControlGenerationFile(runtimeRoot, `${JSON.stringify({
    schema_version: 2,
    kind: "garelier_control_generation",
    control_schema_version: 3,
    storage: "plan_graph_markdown",
    incarnation: "00000000-0000-4000-8000-000000000001",
    generation,
    state: "stable",
    operation: "atomicity-churn",
    session_id: "cs_atomicity_churn",
    updated_at: new Date().toISOString(),
  })}\n`);
}
writeFileSync(donePath, "done\n", "utf8");
