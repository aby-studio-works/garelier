// Garelier dispatch (W-191 b/d/e) — serial WARM reuse of a role seat.
//
// The full dispatch preamble (standing constraints, commit/kill/terminate
// contract, long-job policy, …) is a fixed cost the PM pays on EVERY dispatch.
// W-190 shrank the per-message cost; W-191 shrinks the per-DISPATCH cost when the
// SAME live role picks up the NEXT row: the contract was already delivered at
// its first spawn, so a serial continuation needs only a DELTA — the next row
// pointer, the seat's existing warm checkout, and the base — not the whole
// preamble a second time (user 2026-07-20: "初回の新規サブエージェント起動時だけで
// 済むのでは"; validated 2026-07-20 drain-2 lane, one contract → 6 rows).
//
// This module is the PURE core dispatch_prepare's `--reuse <agent>` branch calls:
//   - findReusableRecord: locate the prior seat's dispatch record by agent name.
//   - checkReuseIdentity: the (d)/(e) guards — reuse is a SAME-role, SAME-repo,
//     SAME-pm continuation ONLY; a gate seat never reuses (DEC-090 independence).
// Both are fail-closed: a mismatch is a hard error the caller surfaces BEFORE any
// branch/worktree mutation (a reuse does none, so the guards run before it emits).
//
// The reuse target is the dispatch fact-pack (`context.json`, context_pack.ts),
// keyed by `guard.agent_name`. The identity triple the guards need is already
// carried by the pack: pm_id (`project.pm_id`), role (`guard.role`/`task.role`),
// and the cross-repo axis (`project.project_root` = the dispatch's git root). The
// scan is SCOPED to the current dispatch's crew dir, so control_root + pm_id match
// by construction; the guards re-check pm_id defensively and check role + repo
// scope explicitly. `additional_roots` is honored if a record carries it (attended
// records do, W-183) but the dispatch-native path declares none.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Gate seats never reuse a role's (or another gate's) context: the whole
 * point of Guardian/Observer is an INDEPENDENT read (DEC-090). Reusing a warm
 * context would turn the gate into self-review / correlated second opinion. */

/** The identity + warm-handoff facts read from a prior dispatch's context.json. */
export interface ContextIdentity {
  agentName: string;
  role: string;
  pmId: string;
  projectRoot: string;        // project.project_root — the dispatch's git root (cross-repo axis, e)
  additionalRoots: string[];  // guard.additional_roots — [] in the dispatch-native path (W-183 interop)
  checkout: string;           // guard.worktree — the warm worktree the reused seat keeps working in
  branch: string;             // task.branch
  baseBranch: string;         // task.base_branch
  baseSha: string;            // task.base_sha
  touches: string[];          // task.touches (declared prediction) — (f) overlap basis
  touchedPackages: string[];  // task.touched_packages — (f) preferred overlap basis
  specVersions: Record<string, string>; // top-level spec_versions (W-191 c) — {} when unstamped
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.length > 0) : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Parse a context.json text into the reuse identity, or null when it is not a
 * usable dispatch fact-pack (unparseable / no agent_name). Fail-safe: any missing
 * field degrades to an empty default, never throws. */
export function readContextIdentity(jsonText: string): ContextIdentity | null {
  let pack: any;
  try { pack = JSON.parse(jsonText); } catch { return null; }
  if (!pack || typeof pack !== "object") return null;
  const guard = (pack.guard && typeof pack.guard === "object") ? pack.guard : {};
  const task = (pack.task && typeof pack.task === "object") ? pack.task : {};
  const project = (pack.project && typeof pack.project === "object") ? pack.project : {};
  const agentName = str(guard.agent_name);
  if (!agentName) return null; // not an agent-keyed dispatch record
  const specVersions: Record<string, string> = {};
  if (pack.spec_versions && typeof pack.spec_versions === "object") {
    for (const [k, v] of Object.entries(pack.spec_versions)) if (typeof v === "string") specVersions[k] = v;
  }
  return {
    agentName,
    role: str(guard.role) || str(task.role),
    pmId: str(project.pm_id),
    projectRoot: str(project.project_root),
    additionalRoots: strArr(guard.additional_roots),
    checkout: str(guard.worktree),
    branch: str(task.branch),
    baseBranch: str(task.base_branch),
    baseSha: str(task.base_sha),
    touches: strArr(task.touches),
    touchedPackages: strArr(task.touched_packages),
    specVersions,
  };
}

/** A located prior dispatch, newest-first by numeric dispatch id. */
export interface ReusableRecord {
  dispatchId: number;
  contextPath: string;
  identity: ContextIdentity;
}

/** Scan `<dispatchRoot>/<prefix><N>/context.json` for the NEWEST (highest id N)
 * record whose `guard.agent_name` equals `agent`. Returns null when none matches
 * (the caller then hard-fails: nothing to reuse → spawn fresh). Fail-open on a
 * missing dir / unreadable pack (that container is simply skipped). */
export function findReusableRecord(dispatchRoot: string, dispatchPrefix: string, agent: string): ReusableRecord | null {
  let names: string[];
  try { names = readdirSync(dispatchRoot); } catch { return null; }
  const escaped = dispatchPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idRe = new RegExp(`^${escaped}(\\d+)$`);
  let best: ReusableRecord | null = null;
  for (const name of names) {
    const m = name.match(idRe);
    if (!m) continue;
    const dispatchId = Number(m[1]);
    const contextPath = join(dispatchRoot, name, "context.json");
    if (!existsSync(contextPath)) continue;
    let identity: ContextIdentity | null;
    try { identity = readContextIdentity(readFileSync(contextPath, "utf8")); } catch { continue; }
    if (!identity || identity.agentName !== agent) continue;
    if (!best || dispatchId > best.dispatchId) best = { dispatchId, contextPath, identity };
  }
  return best;
}

/** The requested new dispatch's identity, for the (d)/(e) reuse guards. */
export interface ReuseRequest {
  role: string;
  pmId: string;
  projectRoot: string;        // the new dispatch's git root (gitRoot)
  additionalRoots?: string[]; // dispatch-native: none
}

export interface IdentityCheck {
  ok: boolean;
  error?: string;
}

// Normalize a repo root for identity comparison: absolute + forward slashes.
// (Windows drive-letter case can vary between an operator's cwd and a stored
// record; lower-case the whole path so the comparison is not defeated by `C:` vs
// `c:` — path comparison on Windows is case-insensitive anyway.)
function normRoot(p: string): string {
  return resolve(p).replace(/\\/g, "/").toLowerCase();
}

/** The full repo scope of a lane: its primary root plus any authorized extra
 * roots (W-183), normalized + sorted + deduped, for an order-independent compare. */
export function repoScope(projectRoot: string, additionalRoots: string[]): string[] {
  return [...new Set([projectRoot, ...additionalRoots].filter(Boolean).map(normRoot))].sort();
}

function scopeEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The (d)/(e) reuse guards — fail-closed. A reuse is a SAME-role, SAME-pm,
 * SAME-repo-scope continuation of a warm seat; anything else must spawn fresh.
 *   (d) gate seat  → never reuses (DEC-090 independence).
 *   (d) role       → prior record's role must equal the requested role.
 *   (e) pm_id      → must match (defensive; the crew-dir scan already scopes it).
 *   (e) repo scope → prior (root + additional_roots) must equal the requested one.
 * Returns { ok:false, error } with an actionable "spawn fresh" message on any
 * mismatch; the caller surfaces it and exits BEFORE any mutation. */
export function checkReuseIdentity(prior: ContextIdentity, req: ReuseRequest): IdentityCheck {
  if (req.role === "guardian" || req.role === "observer") {
    return { ok: false, error: `reuse: role '${req.role}' is a GATE seat — gate seats never reuse a warm context (DEC-090: a Guardian/Observer read must be INDEPENDENT; reusing a role's or another gate's context is self-review / a correlated second opinion). Spawn a FRESH gate seat.` };
  }
  if (prior.role !== req.role) {
    return { ok: false, error: `reuse: role mismatch — the prior record for this agent is role '${prior.role}', but this dispatch requests role '${req.role}'. Cross-role reuse is forbidden (W-191d: reuse is a same-role serial continuation only). Spawn a fresh '${req.role}' seat.` };
  }
  if (prior.pmId !== req.pmId) {
    return { ok: false, error: `reuse: pm_id mismatch — the prior record is pm '${prior.pmId}', this dispatch is pm '${req.pmId}'. Cross-pm reuse is forbidden (W-191e). Spawn fresh.` };
  }
  const priorScope = repoScope(prior.projectRoot, prior.additionalRoots);
  const reqScope = repoScope(req.projectRoot, req.additionalRoots ?? []);
  if (!scopeEqual(priorScope, reqScope)) {
    return { ok: false, error: `reuse: repo scope mismatch — the prior record's scope is [${priorScope.join(", ")}], this dispatch's scope is [${reqScope.join(", ")}]. Cross-repo reuse is forbidden (W-191e: cross-repo context contamination is a measured harm). A legitimate two-repo lane declares its extra roots ONCE as a single lane; spawn fresh here.` };
  }
  return { ok: true };
}

// ---- W-191 (c): spec-version stamping + machine spec-diff delivery ------------
//
// The project's governance files ([prompt] spec_files in setup_config) are git-
// tracked, so "did a rule change since this seat last read it?" is a pure blob-SHA
// comparison — no PM summarization. A NORMAL dispatch STAMPS the current blob SHA of
// each spec file into context.json (patchContextSpecVersions, the record_touches
// post-patch pattern). A `--reuse` continuation compares the stamped SHAs against the
// current ones (diffSpecVersions); dispatch_prepare then attaches `git diff` for the
// CHANGED files only. Governance stable ⇒ zero SHAs differ ⇒ nothing sent.

/** Set a top-level `spec_versions` map on a context.json text, preserving every
 * other field + the 2-space/trailing-newline shape (mirrors record_touches.ts's
 * patchContextTouchesActual). Throws on unparseable JSON (caller leaves as-is). */
export function patchContextSpecVersions(jsonText: string, specVersions: Record<string, string>): string {
  const pack = JSON.parse(jsonText) as Record<string, unknown>;
  pack.spec_versions = specVersions;
  return JSON.stringify(pack, null, 2) + "\n";
}

export interface SpecFileChange {
  file: string;
  status: "changed" | "added" | "removed";
  old_sha?: string;
  new_sha?: string;
}

/** Compare the SHAs a prior dispatch STAMPED against the CURRENT SHAs. Only files
 * that changed / were added / were removed appear — an unchanged governance set
 * yields an empty list (the whole point: zero delivery, zero tokens when the rules
 * are stable). Sorted by path for a deterministic delta block. */
export function diffSpecVersions(recorded: Record<string, string>, current: Record<string, string>): SpecFileChange[] {
  const changes: SpecFileChange[] = [];
  for (const file of [...new Set([...Object.keys(recorded), ...Object.keys(current)])].sort()) {
    const oldSha = recorded[file];
    const newSha = current[file];
    if (oldSha && newSha) {
      if (oldSha !== newSha) changes.push({ file, status: "changed", old_sha: oldSha, new_sha: newSha });
    } else if (newSha) {
      changes.push({ file, status: "added", new_sha: newSha });
    } else if (oldSha) {
      changes.push({ file, status: "removed", old_sha: oldSha });
    }
  }
  return changes;
}

// ---- W-191 (f): reuse routing hint -------------------------------------------
//
// The hard rules ((d) role, (e) repo/pm) are enforced by checkReuseIdentity. This
// is the SOFT signal for a reuse that PASSES those guards: how much does the next
// row's working set overlap the warm seat's? High overlap ⇒ reuse (spec re-read
// saved, implementation thread continued); ~0 overlap ⇒ a subsystem shift where a
// fresh seat avoids carrying stale context. The full criteria table is
// references/reuse_routing.md; this computes the mechanical overlap % the PM reads
// alongside it. See dispatch_prepare's --reuse delta block.

export const REUSE_OVERLAP_HIGH = 40; // >= this % ⇒ reuse recommended
export const REUSE_OVERLAP_LOW = 10;  // <= this % ⇒ fresh recommended (subsystem shift)

export interface ReuseHint {
  overlap_pct: number;                                   // Jaccard % on the chosen basis
  basis: "touched_packages" | "touches" | "none";        // which set the % was computed on
  recommendation: "reuse" | "fresh";
  reason: string;
}

/** Jaccard overlap (|∩|/|∪|) as a rounded percent; 0 when both sets are empty. */
export function jaccardPct(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : Math.round((inter / union) * 100);
}

/** The overlap-based reuse recommendation. Prefers touched_packages (semantic
 * working set) over raw touch globs; falls back to "none" when neither side carries
 * comparable metadata — then it still recommends reuse (a warm seat saves the
 * preamble) but flags that the PM must confirm same-family from the row itself. */
export function computeReuseHint(
  prior: { touches: string[]; touchedPackages: string[] },
  next: { touches: string[]; touchedPackages: string[] },
): ReuseHint {
  let basis: ReuseHint["basis"] = "none";
  let overlap = 0;
  if (prior.touchedPackages.length && next.touchedPackages.length) {
    basis = "touched_packages";
    overlap = jaccardPct(prior.touchedPackages, next.touchedPackages);
  } else if (prior.touches.length && next.touches.length) {
    basis = "touches";
    overlap = jaccardPct(prior.touches, next.touches);
  }
  if (basis === "none") {
    return {
      overlap_pct: 0, basis, recommendation: "reuse",
      reason: "no comparable touch metadata — a warm seat still saves the full preamble, but confirm the next row is same-family (references/reuse_routing.md) before continuing; spawn fresh on a subsystem shift.",
    };
  }
  if (overlap >= REUSE_OVERLAP_HIGH) {
    return { overlap_pct: overlap, basis, recommendation: "reuse", reason: `${overlap}% ${basis} overlap — same working set; warm context saves the spec re-read and continues the implementation thread.` };
  }
  if (overlap <= REUSE_OVERLAP_LOW) {
    return { overlap_pct: overlap, basis, recommendation: "fresh", reason: `${overlap}% ${basis} overlap — a subsystem shift; a fresh seat avoids carrying stale context. Reuse only for a deliberate small nibble in the same lane.` };
  }
  return { overlap_pct: overlap, basis, recommendation: "reuse", reason: `${overlap}% ${basis} overlap — partial; reuse is usually fine (cheap delta) but rotate to fresh on quality drift or context bloat.` };
}
