// Garelier dispatch (W-053) — declared touches / depends_on conflict metadata.
//
// CCPM's depends_on / parallel / conflicts_with concept, Garelier-shaped. The
// measured motivation is PM hand-work: an attended PM fanning out parallel
// producer subagents judges file collisions by eye every time (live: W-073/W-074
// manually serialized because both edit stage_transition.rs; the garelier repo
// itself hit a PM commit clashing with an uncommitted worker change, 253643b).
//
// dispatch_prepare.sh forwards `--touches`/`--depends-on` into the container's
// context.json (task.touches / task.depends_on). This module (a) detects when a
// NEW dispatch's declared touches overlap an ALREADY-active dispatch's, and (b)
// flags depends_on entries whose referenced dispatch has not finished. It NEVER
// blocks — the attended PM keeps the serialize/split/parallel decision; the tool
// only surfaces the overlap so the PM reads it instead of re-deriving it.
//
// The glob overlap test is deliberately a simple heuristic (static-prefix
// containment + concrete-basename match), not full glob algebra: false positives
// are cheaper than false negatives here — a spurious "these might collide" wastes
// a moment of PM attention; a missed collision costs a mid-integration clash.
//
// CLI (called by dispatch_prepare.sh; also importable by contract_check.ts):
//   bun conflict_check.ts check --pm-root <__garelier/<pm>> --touches "a,b"
//       [--depends-on "slug,#3"] [--self <id>]
//     -> one JSON line {touches, depends_on, conflicts, unmet_deps, warning}
//   bun conflict_check.ts map --pm-root <__garelier/<pm>>
//     -> one JSON line {touch_map:[...]} across every active dispatch
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { arg, printHelpAndExitIfRequested } from "../cli_args.ts";

// ── declared-metadata parsing ────────────────────────────────────────────────

// Split a CSV declaration into trimmed, non-empty tokens. Tolerates surrounding
// whitespace and empty segments ("a,,b" -> ["a","b"]).
export function parseCsvList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── glob overlap heuristic ───────────────────────────────────────────────────

const WILD = /[*?[{]/;

function norm(g: string): string {
  return g.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

// A "matches everything" declaration (`*`, `**`, `**/*`, `*/*`) — overlaps any
// other non-empty declaration. Without this it would (via the empty static
// head) match nothing, a false negative for the broadest possible claim.
function isMatchAll(g: string): boolean {
  return /^\*+(\/\*+)*$/.test(g);
}

// The leading static path (up to the first wildcard char). `src/**` -> `src`,
// `src/a.rs` -> `src/a.rs`, `**/x.rs` -> "" (starts with a wildcard).
function staticHead(g: string): string {
  const m = WILD.exec(g);
  return (m ? g.slice(0, m.index) : g).replace(/\/+$/, "");
}

// The final path segment. `**/x.rs` -> `x.rs`, `src/**` -> `**`.
function basenameOf(g: string): string {
  const i = g.lastIndexOf("/");
  return i >= 0 ? g.slice(i + 1) : g;
}

function isConcrete(seg: string): boolean {
  return seg.length > 0 && !WILD.test(seg);
}

// Path-segment-aware prefix: "src" is a prefix of "src/a" but NOT of "srcfoo".
function isPathPrefix(prefix: string, path: string): boolean {
  if (!prefix) return false;
  return path === prefix || path.startsWith(prefix + "/");
}

// Two path globs overlap iff (heuristic, false-positive-leaning):
//   - either is a match-all pattern, or
//   - they are byte-identical after normalization, or
//   - one's static head contains the other's (directory / prefix containment), or
//   - they share the same CONCRETE basename (covers `**/x.rs` vs `dir/sub/x.rs`).
// A wildcard basename (`*.rs`) does NOT trigger the basename rule on its own —
// that would make every rust file "overlap"; those rely on the prefix rule.
export function globOverlap(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (isMatchAll(na) || isMatchAll(nb)) return true;
  if (na === nb) return true;
  const ha = staticHead(na);
  const hb = staticHead(nb);
  if (isPathPrefix(ha, hb) || isPathPrefix(hb, ha)) return true;
  const ba = basenameOf(na);
  const bb = basenameOf(nb);
  if (isConcrete(ba) && isConcrete(bb) && ba === bb) return true;
  return false;
}

// The specific overlapping (declared, other) pairs between two touch lists —
// deduped display strings "own <-> other" so the PM sees WHICH paths collide.
export function overlappingPairs(mine: string[], theirs: string[]): string[] {
  const out: string[] = [];
  for (const m of mine) {
    for (const t of theirs) {
      if (globOverlap(m, t)) {
        const label = m === t ? m : `${m} ~ ${t}`;
        if (!out.includes(label)) out.push(label);
      }
    }
  }
  return out;
}

// ── active-dispatch scan ─────────────────────────────────────────────────────

export interface ActiveDispatch {
  dispatch: string; // the <N> in _dispatch<N>
  slug: string | null;
  state: string | null; // STATE.md Status (WORKING / REPORTING / BLOCKED / ...)
  touches: string[];
  depends_on: string[];
}

// First non-blank line under STATE.md's '## Status' heading (mirrors
// contract_check.readStateStatus; duplicated locally to avoid an import cycle).
function readStateStatus(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^##\s*Status\b/i.test(l));
  if (i < 0) return null;
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t.length > 0) return t;
  }
  return null;
}

function readContextArrays(contextPath: string): { slug: string | null; touches: string[]; depends_on: string[] } {
  if (!existsSync(contextPath)) return { slug: null, touches: [], depends_on: [] };
  try {
    const pack = JSON.parse(readFileSync(contextPath, "utf8")) as {
      task?: { slug?: string | null; touches?: unknown; depends_on?: unknown };
    };
    const t = pack.task ?? {};
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
    return { slug: t.slug ?? null, touches: arr(t.touches), depends_on: arr(t.depends_on) };
  } catch {
    return { slug: null, touches: [], depends_on: [] };
  }
}

// Every `_dispatch<N>/` container directly under `<pmRoot>` (the layout
// dispatch_prepare.sh creates). Reads task.slug/touches/depends_on from
// context.json and Status from STATE.md. Best-effort: a missing/corrupt file
// yields empty arrays for that dispatch, never a throw.
export function scanActiveDispatches(pmRoot: string): ActiveDispatch[] {
  const out: ActiveDispatch[] = [];
  if (!existsSync(pmRoot)) return out;
  const dirs = readdirSync(pmRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^_dispatch\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => parseInt(a.slice("_dispatch".length), 10) - parseInt(b.slice("_dispatch".length), 10));
  for (const name of dirs) {
    const dispatch = name.slice("_dispatch".length);
    const container = join(pmRoot, name);
    const statePath = join(container, "STATE.md");
    const state = existsSync(statePath) ? readStateStatus(readFileSync(statePath, "utf8")) : null;
    const { slug, touches, depends_on } = readContextArrays(join(container, "context.json"));
    out.push({ dispatch, slug, state, touches, depends_on });
  }
  return out;
}

// ── conflict + dependency computation ────────────────────────────────────────

export interface Conflict {
  dispatch: string;
  slug: string | null;
  state: string | null;
  overlapping: string[];
}

// New declared touches vs every active dispatch (excluding `selfId`, the
// just-created container). Only dispatches with a real overlap are returned.
export function computeConflicts(newTouches: string[], active: ActiveDispatch[], selfId?: string | null): Conflict[] {
  const conflicts: Conflict[] = [];
  if (newTouches.length === 0) return conflicts;
  for (const d of active) {
    if (selfId != null && d.dispatch === String(selfId)) continue;
    if (d.touches.length === 0) continue;
    const overlapping = overlappingPairs(newTouches, d.touches);
    if (overlapping.length > 0) {
      conflicts.push({ dispatch: d.dispatch, slug: d.slug, state: d.state, overlapping });
    }
  }
  return conflicts;
}

export interface UnmetDep {
  dep: string; // the raw depends_on token (slug or #id)
  dispatch: string;
  slug: string | null;
  state: string | null;
}

// A dispatch is "done" once its container is cleaned up (gone) — so a present
// container means the dependency is not yet finished. A depends_on token matches
// an active dispatch by id (`#3` or `3`) or by slug; matches are reported as
// unmet with their current state so the PM judges (WORKING/BLOCKED clearly
// pending; REPORTING = produced but not yet merged/cleaned).
export function computeUnmetDeps(dependsOn: string[], active: ActiveDispatch[]): UnmetDep[] {
  const unmet: UnmetDep[] = [];
  for (const dep of dependsOn) {
    const key = dep.replace(/^#/, "");
    const hit = active.find((d) => d.dispatch === key || d.slug === dep || d.slug === key);
    if (hit) {
      unmet.push({ dep, dispatch: hit.dispatch, slug: hit.slug, state: hit.state });
    }
  }
  return unmet;
}

// ── touch map (contract_check --stall-scan visualization) ────────────────────

export interface TouchMapEntry {
  dispatch: string;
  slug: string | null;
  state: string | null;
  touches: string[];
  depends_on: string[];
  conflicts_with: string[]; // other dispatch ids whose touches overlap this one
}

// Pairwise overlap across every active dispatch — the landscape the PM sees in
// --stall-scan output. O(n^2) over touches, but n is the handful of in-flight
// dispatches.
export function buildTouchMap(active: ActiveDispatch[]): TouchMapEntry[] {
  return active.map((d) => {
    const conflicts_with: string[] = [];
    if (d.touches.length > 0) {
      for (const other of active) {
        if (other.dispatch === d.dispatch || other.touches.length === 0) continue;
        if (overlappingPairs(d.touches, other.touches).length > 0) conflicts_with.push(other.dispatch);
      }
    }
    return { dispatch: d.dispatch, slug: d.slug, state: d.state, touches: d.touches, depends_on: d.depends_on, conflicts_with };
  });
}

// ── the check result assembled for dispatch_prepare ──────────────────────────

export interface CheckResult {
  touches: string[];
  depends_on: string[];
  conflicts: Conflict[];
  unmet_deps: UnmetDep[];
  warning: string; // single-line, quote-free (dispatch_prepare seds it out)
}

export function runCheck(
  pmRoot: string,
  newTouches: string[],
  dependsOn: string[],
  selfId?: string | null,
): CheckResult {
  const active = scanActiveDispatches(pmRoot);
  const conflicts = computeConflicts(newTouches, active, selfId);
  const unmet_deps = computeUnmetDeps(dependsOn, active);
  return { touches: newTouches, depends_on: dependsOn, conflicts, unmet_deps, warning: buildWarning(conflicts, unmet_deps) };
}

// A single-line, double-quote-free advisory (dispatch_prepare extracts it via
// sed and echoes it to stderr unless --allow-conflict). Empty when clean.
export function buildWarning(conflicts: Conflict[], unmet: UnmetDep[]): string {
  const parts: string[] = [];
  for (const c of conflicts) {
    parts.push(
      `touches overlap with in-flight dispatch #${c.dispatch}${c.slug ? ` (${c.slug})` : ""}: ${c.overlapping.join("; ")}`,
    );
  }
  for (const u of unmet) {
    parts.push(`depends_on '${u.dep}' is still in-flight (dispatch #${u.dispatch}, state ${u.state ?? "?"})`);
  }
  if (parts.length === 0) return "";
  return (
    parts.join(" | ") +
    " -- serialize (wait), split the touched files, or confirm the parallel is intentional and re-run with --allow-conflict to silence this."
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(): void {
  printHelpAndExitIfRequested(
    "conflict_check — advisory touch-map / conflict check across active dispatches.\n" +
    "usage: conflict_check map --pm-root <__garelier/<pm_id>>\n" +
    "       conflict_check check --pm-root <path> --touches <csv> [--depends-on <csv>] [--self <id>]",
  );
  const sub = process.argv[2];
  const pmRoot = arg("pm-root");
  if (!pmRoot) {
    process.stderr.write("conflict_check: --pm-root <__garelier/<pm_id>> required\n");
    process.exit(2);
    return;
  }
  if (sub === "map") {
    const touch_map = buildTouchMap(scanActiveDispatches(pmRoot));
    process.stdout.write(JSON.stringify({ touch_map }) + "\n");
    process.exit(0);
    return;
  }
  if (sub === "check") {
    const result = runCheck(
      pmRoot,
      parseCsvList(arg("touches")),
      parseCsvList(arg("depends-on")),
      arg("self") ?? null,
    );
    process.stdout.write(JSON.stringify(result) + "\n");
    // Exit 0 even on conflicts — this is advisory, never a gate (the PM decides).
    process.exit(0);
    return;
  }
  process.stderr.write("conflict_check: first arg must be 'check' or 'map'\n");
  process.exit(2);
}

if (import.meta.main) main();
