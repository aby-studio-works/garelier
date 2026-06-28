// Garelier dispatch (DEC-052) — Dock-bay-owned merge gate.
//
// In dispatch mode there is no external driver, so the DOCK BAY drives the merge
// gate. It reuses the existing merge_gate machinery: `pollMergeGate` takes the
// single active.lock and spawns `merge-gate.sh` in the BACKGROUND (the
// subprocess does git merge --no-ff + the quality gate with ZERO LLM tokens and
// writes results/<seq>.json atomically). The Dock bay then Monitors results/ and
// resolves (merged.md / review.md). On Dock-bay restart, `poll` re-detects and
// advances any in-flight merge — background tasks are not restored on resume.
//
// usage:
//   bun run dock_merge.ts poll   --pm-id <id> [--project <root>]
//   bun run dock_merge.ts status --pm-id <id> [--project <root>]
//   bun run dock_merge.ts await  --pm-id <id> --request-id <id> [--project <root>] [--poll-ms <n>] [--ceiling-ms <n>]
//     ^ DEC-082 fix-1: block until the merge gate writes a TERMINAL result
//       (success|failed|conflict|aborted) for <request-id>, re-running the
//       idempotent poll advancer each iteration, so a tick that calls this
//       completes only when the merge is DONE (no out-of-band PM polling). The
//       loop is bounded by --ceiling-ms and exits 0 with status:"timeout" rather
//       than hanging; pollMergeGate self-heals a dead gate pid into a synthetic
//       "aborted" result, so the await terminates even if the gate crashes.
//       SINGLE-POLLER invariant: only the serial jig INTEGRATE stage may call it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pollMergeGate, mergeGatePaths, ensureMergeGateDirs, type MergeGatePaths } from "../merge_gate.ts";
import { loadConfig } from "../config.ts";
import { Logger } from "../log.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Resolve the project root (where __garelier/ lives). The Dock bay runs in a
// worktree, so prefer an explicit --project / GARELIER_PROJECT; else derive it
// from GARELIER_DISPATCH_ROOT (<project>/__garelier/<pm>/runtime/dispatch).
function resolveProject(): string {
  const p = arg("project") ?? process.env.GARELIER_PROJECT;
  if (p) return resolve(p);
  const dr = process.env.GARELIER_DISPATCH_ROOT;
  if (dr) return resolve(dr, "..", "..", "..", "..");
  return process.cwd();
}

function readActive(p: MergeGatePaths): unknown {
  if (!existsSync(p.activeLock)) return null;
  try { return JSON.parse(readFileSync(p.activeLock, "utf8")); } catch { return { unparsed: true }; }
}
function listJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
}

const cmd = process.argv[2];
const project = resolveProject();
const pmId = arg("pm-id") ?? process.env.GARELIER_PM_ID;
if (!pmId || (cmd !== "poll" && cmd !== "status" && cmd !== "await")) {
  console.error("usage: dock_merge.ts poll|status|await --pm-id <id> [--project <root>] (await: --request-id <id>)");
  process.exit(2);
}
const paths = mergeGatePaths(project, pmId);
ensureMergeGateDirs(paths);

if (cmd === "poll") {
  let config;
  try {
    config = loadConfig(project, pmId);
  } catch (e) {
    console.error(`dock_merge poll: cannot load config for pm "${pmId}" at ${project}: ${(e as Error).message}`);
    process.exit(1);
  }
  const log = new Logger("dock-merge");
  const r = await pollMergeGate(project, config, log, {});
  console.log(JSON.stringify({
    spawned: r.spawnedRequestId ?? null,
    active: readActive(paths),
    pending: listJson(paths.requestsDir),
    results: listJson(paths.resultsDir),
  }));
} else if (cmd === "await") {
  // DEC-082 fix-1: block until a TERMINAL merge result exists for --request-id,
  // re-running the idempotent poll advancer each iteration. Bounded by ceiling.
  const reqId = arg("request-id");
  if (!reqId) { console.error("await: --request-id <id> is required"); process.exit(2); }
  let config;
  try {
    config = loadConfig(project, pmId);
  } catch (e) {
    console.error(`dock_merge await: cannot load config for pm "${pmId}" at ${project}: ${(e as Error).message}`);
    process.exit(1);
  }
  const log = new Logger("dock-merge");
  const pollMs = Math.max(250, Number(arg("poll-ms") ?? 3000));
  const ceilingMs = Math.max(60_000, Number(arg("ceiling-ms") ?? 1_800_000));
  const sumFile = resolve(paths.resultsDir, `${reqId}.summary.json`);
  const fullFile = resolve(paths.resultsDir, `${reqId}.json`);
  const TERMINAL = ["success", "failed", "conflict", "aborted"];
  const startedAt = Date.now();
  for (;;) {
    const f = existsSync(sumFile) ? sumFile : existsSync(fullFile) ? fullFile : null;
    if (f) {
      try {
        const status = (JSON.parse(readFileSync(f, "utf8")) as { status?: string }).status;
        if (status && TERMINAL.includes(status)) {
          console.log(JSON.stringify({ request_id: reqId, status, result_file: f }));
          process.exit(0);
        }
      } catch { /* result mid-write (atomic .tmp+rename in flight) — retry next loop */ }
    }
    if (Date.now() - startedAt >= ceilingMs) {
      console.log(JSON.stringify({ request_id: reqId, status: "timeout" }));
      process.exit(0);
    }
    // idempotent advancer: spawns the next queued request OR converts a dead gate
    // pid into a synthetic "aborted" result (merge_gate.ts) — never blocks/deadlocks.
    await pollMergeGate(project, config, log, {});
    await new Promise((r) => setTimeout(r, pollMs));
  }
} else {
  console.log(JSON.stringify({
    active: readActive(paths),
    pending: listJson(paths.requestsDir),
    results: listJson(paths.resultsDir),
  }));
}
