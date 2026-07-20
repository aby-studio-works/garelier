import { rmSync } from "./guard/path_guard.ts";
// pm/scratch retention (W-084(d)).
//
// `runtime/pm/scratch/` is where an attended PM (and agents it drives) drop
// manual verify logs, screenshots, and throwaway working files. It was the ONE
// monotonically-growing runtime path with no prune route and no retention.md
// entry (the 2026-07-05 token audit measured a live 32MB / ~25 files), i.e. the
// same "write forever, fill the disk" class the merge-gate log/results/archive
// prunes already close — but on a directory nobody owns a write-time hook for.
//
// Unlike the merge-gate prunes (write-time, automatic), this one is
// DRY-RUN-FIRST and MANUAL by design: a running PM may hold an in-use scratch
// file, so auto-deleting during a PM session risks eating live work. The helper
// therefore computes candidates without deleting unless `--apply` is passed, and
// is NOT wired into any driver hot-path hook — it is a PM/operator-invoked
// command (see retention.md "Driver / local-only archives").
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Logger } from "./log.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_SCRATCH_KEEP_DAYS = 14;

/** `runtime/pm/scratch` for a pm — the agent-owned ephemeral verify-log area. */
export function pmScratchDir(projectRoot: string, pmId: string): string {
  return join(projectRoot, "__garelier", pmId, "runtime", "pm", "scratch");
}

/**
 * Read `[retention] scratch_keep_days` from setup_config.toml; default 14,
 * fail-open. Lives in the advisory `[retention]` block (not `[merge_gate]`)
 * because — unlike results_keep / archive_keep_days — it drives NO automatic
 * prune; it is only read by this manual, dry-run-first helper. A configured
 * `<= 0` means "disabled" and is honored (returns 0), not overridden.
 */
export function readScratchKeepDaysConfig(projectRoot: string, pmId: string): number {
  const configPath = join(projectRoot, "__garelier", pmId, "_pm", "setup_config.toml");
  if (!existsSync(configPath)) return DEFAULT_SCRATCH_KEEP_DAYS;
  try {
    const raw = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const r = raw.retention as Record<string, unknown> | undefined;
    const n = r?.scratch_keep_days;
    if (typeof n === "number" && Number.isFinite(n)) return n > 0 ? n : 0;
    return DEFAULT_SCRATCH_KEEP_DAYS;
  } catch {
    return DEFAULT_SCRATCH_KEEP_DAYS;
  }
}

export interface ScratchEntry {
  name: string;
  ageDays: number;
  bytes: number;
}

export interface PruneScratchOutcome {
  scratchDir: string;
  keepDays: number;
  apply: boolean;
  totalBefore: number;
  /** entries older than the cutoff — what WOULD be pruned (dry-run) / WAS (apply). */
  candidates: ScratchEntry[];
  /** names actually removed (empty in dry-run). */
  pruned: string[];
  bytesCandidate: number;
  bytesFreed: number;
}

/** Recursive byte total for a file or directory (best-effort; missing = 0). */
function entryBytes(p: string): number {
  let st;
  try { st = statSync(p); } catch { return 0; }
  if (st.isFile()) return st.size;
  if (st.isDirectory()) {
    let total = 0;
    let names: string[];
    try { names = readdirSync(p); } catch { return 0; }
    for (const n of names) total += entryBytes(join(p, n));
    return total;
  }
  return 0;
}

/**
 * Prune top-level entries in `scratchDir` older than `keepDays` (by mtime).
 * DRY-RUN by default (`opts.apply` falsy): computes candidates and their byte
 * cost without deleting anything. `opts.apply === true` removes them
 * (recursively). No-op when `keepDays <= 0`, `scratchDir` is absent, or nothing
 * is older than the cutoff. `opts.nowMs` overrides the clock for tests.
 */
export function pruneScratch(
  scratchDir: string,
  keepDays: number,
  opts: { apply?: boolean; nowMs?: number } = {},
  log?: Logger,
): PruneScratchOutcome {
  const apply = opts.apply === true;
  const nowMs = opts.nowMs ?? Date.now();
  const out: PruneScratchOutcome = {
    scratchDir,
    keepDays,
    apply,
    totalBefore: 0,
    candidates: [],
    pruned: [],
    bytesCandidate: 0,
    bytesFreed: 0,
  };
  if (!Number.isFinite(keepDays) || keepDays <= 0) return out;
  if (!existsSync(scratchDir)) return out;

  let names: string[];
  try { names = readdirSync(scratchDir); } catch { return out; }
  out.totalBefore = names.length;
  const cutoffMs = nowMs - keepDays * MS_PER_DAY;

  for (const name of names.sort()) {
    const path = join(scratchDir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.mtimeMs >= cutoffMs) continue;
    const bytes = entryBytes(path);
    out.candidates.push({ name, ageDays: Math.floor((nowMs - st.mtimeMs) / MS_PER_DAY), bytes });
    out.bytesCandidate += bytes;
    if (apply) {
      try {
        rmSync(path, { recursive: true, force: true });
        out.pruned.push(name);
        out.bytesFreed += bytes;
      } catch { /* locked / already gone — leave it, never crash the prune */ }
    }
  }
  if (log && (out.candidates.length || out.pruned.length)) {
    log.info("pm_scratch_pruned", {
      apply,
      keep_days: keepDays,
      candidates: out.candidates.length,
      pruned: out.pruned.length,
      bytes_freed: out.bytesFreed,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI: `bun scratch_retention.ts --project <root> --pm-id <id> [--keep-days <n>]
// [--apply]`. DRY-RUN unless --apply is given (prints the candidates + byte
// cost so a PM decides before deleting). --keep-days overrides the config /
// default (14). Emits one JSON object.
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cliArg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const projectArg = cliArg("project");
  const pmIdArg = cliArg("pm-id");
  if (!projectArg || !pmIdArg) {
    console.error("usage: bun scratch_retention.ts --project <root> --pm-id <id> [--keep-days <n>] [--apply]");
    process.exit(2);
  }
  const projectRoot = resolve(projectArg);
  const keepDaysArg = cliArg("keep-days");
  const keepDays = keepDaysArg ? Number(keepDaysArg) : readScratchKeepDaysConfig(projectRoot, pmIdArg);
  const apply = argv.includes("--apply");
  const out = pruneScratch(pmScratchDir(projectRoot, pmIdArg), keepDays, { apply });
  console.log(JSON.stringify(out, null, 2));
}
