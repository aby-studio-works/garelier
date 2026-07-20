// Garelier dispatch (W-021) — record a dispatch's ACTUAL touched paths.
//
// A dispatch's `context.json` carries `task.touches` — the file scope the PM
// PREDICTED at dispatch time (drives the conflict check + scoped gate). By the
// time the branch is gated, that prediction has often gone stale: a P2a dispatch
// declared `factory` + `dispatch` but actually edited the canonical layer, so the
// Guardian's process note flagged a touches/diff mismatch. This records the
// MEASURED path set (`base_sha..HEAD`) back into context.json as
// `task.touches_actual`, so a gate / Guardian reads what the dispatch really
// touched instead of the prediction. It complements — never overwrites — the
// declared `touches` / `touches_unverified` (W-090); all three coexist.
//
// Advisory + best-effort, exactly like the rest of the fact-pack: it never blocks
// and a git/read failure leaves context.json unchanged (the gate still has the
// prediction). Called at REPORTING via `dispatch_cleanup.ts --record-touches`, or
// directly.
//
// CLI:
//   bun record_touches.ts --context <context.json> --checkout <worktree> [--base-sha <sha>]
//   Reads base_sha from context.json task.base_sha when --base-sha is omitted.
//   Exit 0 on a recorded (or no-op) pack, 2 on usage error, 3 when the diff could
//   not be measured (git failed / no base sha).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arg, printHelpAndExitIfRequested } from "../cli_args.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";

// git seam (mirrors contract_check.ts) — injectable so the pure logic is testable
// without a real repo; a spawn failure degrades to a non-zero result, never throws.
export type GitRunner = (args: string[], cwd: string) => { code: number; stdout: string };
const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    const r = Bun.spawnSync([requireRuntimeExecutable("git"), ...args], { windowsHide: true, cwd, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, stdout: r.stdout ? r.stdout.toString() : "" };
  } catch {
    return { code: 1, stdout: "" };
  }
};

// Parse `git diff --name-only` output into a sorted, deduped, non-empty path list.
export function parseDiffPaths(diff: string): string[] {
  const set = new Set<string>();
  for (const raw of diff.split(/\r?\n/)) {
    const p = raw.trim();
    if (p) set.add(p);
  }
  return [...set].sort();
}

// The measured path set of base_sha..HEAD in a checkout worktree. Returns null when
// the diff could not be read (git failed / bad base sha) so the caller leaves the
// pack untouched rather than recording an empty (wrong) measurement.
export function computeTouchesActual(
  checkout: string,
  baseSha: string,
  git: GitRunner = defaultGitRunner,
): string[] | null {
  if (!baseSha) return null;
  const r = git(["diff", "--name-only", baseSha, "HEAD"], checkout);
  if (r.code !== 0) return null;
  return parseDiffPaths(r.stdout);
}

// Set task.touches_actual on a context.json text, preserving every other field and
// context_pack.ts's 2-space-indent + trailing-newline shape. Throws on unparseable
// JSON (the caller treats that as "leave the file as-is").
export function patchContextTouchesActual(jsonText: string, actual: string[]): string {
  const pack = JSON.parse(jsonText) as { task?: Record<string, unknown> };
  if (!pack.task || typeof pack.task !== "object") pack.task = {};
  pack.task.touches_actual = actual;
  return JSON.stringify(pack, null, 2) + "\n";
}

// Read task.base_sha from a context.json (short or full sha). null when absent.
export function readBaseShaFromContext(contextPath: string): string | null {
  try {
    const pack = JSON.parse(readFileSync(contextPath, "utf8")) as { task?: { base_sha?: string | null } };
    return pack.task?.base_sha ? String(pack.task.base_sha) : null;
  } catch {
    return null;
  }
}

export interface RecordResult {
  ok: boolean;
  recorded: string[];
  reason?: string;
}

// Record actual touches into context.json. Best-effort: returns ok=false with a
// reason (and does NOT modify the file) when the context is missing/unparseable or
// the diff could not be measured. Injectable git for tests.
export function recordTouches(
  contextPath: string,
  checkout: string,
  baseShaOverride: string | null,
  git: GitRunner = defaultGitRunner,
): RecordResult {
  if (!existsSync(contextPath)) return { ok: false, recorded: [], reason: `context.json not found: ${contextPath}` };
  const baseSha = baseShaOverride ?? readBaseShaFromContext(contextPath);
  if (!baseSha) return { ok: false, recorded: [], reason: "no base_sha (pass --base-sha or ensure context.json task.base_sha)" };
  const actual = computeTouchesActual(checkout, baseSha, git);
  if (actual === null) return { ok: false, recorded: [], reason: `git diff --name-only ${baseSha}..HEAD failed in ${checkout}` };
  let jsonText: string;
  try {
    jsonText = readFileSync(contextPath, "utf8");
  } catch {
    return { ok: false, recorded: [], reason: `cannot read ${contextPath}` };
  }
  let patched: string;
  try {
    patched = patchContextTouchesActual(jsonText, actual);
  } catch {
    return { ok: false, recorded: [], reason: `context.json is not valid JSON: ${contextPath}` };
  }
  try {
    writeFileSync(contextPath, patched);
  } catch {
    return { ok: false, recorded: [], reason: `cannot write ${contextPath}` };
  }
  return { ok: true, recorded: actual };
}

// ---- CLI --------------------------------------------------------------------

function fail(msg: string): never {
  process.stderr.write(`record_touches: ${msg}\n`);
  process.exit(2);
}

function main(): void {
  printHelpAndExitIfRequested(
    "record_touches.ts --context <context.json> --checkout <worktree> [--base-sha <sha>]",
  );
  const contextPath = arg("context");
  const checkout = arg("checkout");
  if (!contextPath || !checkout) fail("usage: record_touches.ts --context <context.json> --checkout <worktree> [--base-sha <sha>]");
  const res = recordTouches(contextPath, checkout, arg("base-sha") ?? null);
  process.stdout.write(JSON.stringify(res) + "\n");
  process.exit(res.ok ? 0 : 3);
}

if (import.meta.main) {
  main();
}
