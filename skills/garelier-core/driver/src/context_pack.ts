// Dispatch fact-pack builder (DEC-081 Piece 1) — forward-supply at dispatch.
//
// dispatch_prepare scaffolds a producer's cold worktree, then calls this to write
// `context.json` into the container. It FORWARD-SUPPLIES the project facts every
// producer otherwise re-derives in its cold worktree (the survey behind DEC-081
// found this is the biggest waste): the quality-gate command(s), target /
// target_slug, the studio (integration) and target branch names, the base sha,
// the effective bash-tool timeout budget (bash_timeout_budget_ms, W-077), and —
// when a blueprint is named — the blueprint's Context-pack anchors
// (entry_points / invariants / local_verify, DEC-071).
//
// This is also a GUARDRAIL, not only a token saving: the gate command and
// target_slug are computed ONCE from the canonical config, so a producer cannot
// run the wrong gate or mis-parse target_slug from a branch name.
//
// INVARIANTS (DEC-081):
//   - Forward-supply / advisory, never authority. Facts + anchors only, no verdict.
//   - Read-raw preserved: the producer may ignore context.json and read the raw
//     setup_config / blueprint / AGENTS.md exactly as today. The pack is a map.
//   - Fail-open: a missing / unparseable config yields a pack with `unknown`
//     fields + a note, never a crash — dispatch must not fail on the fact-pack.
//   - No code content / no leak surface — facts, names, and anchor pointers only.
//
// CLI:
//   bun context_pack.ts --config <setup_config.toml> --pm-id <id>
//       --project <abs> --integration <studio-branch>
//       [--task-id N --role R --slug S --branch B --base-sha SHA]
//       [--touches a,b --depends-on slug,#id] [--full-gate]  (W-068 scoped gate)
//       [--model M --effort E --model-source S]  (W-026 routing decision)
//       [--commit-mode self|proxy]  (W-042 guardian round-2 N1)
//       [--blueprint <path>] [--out <path>]
//   Writes the pack JSON to --out (default: stdout). Exit 0 on a produced pack,
//   2 on a usage error.

import { parse } from "smol-toml";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  normalizeResourceClass, normalizeRuntimeEffect,
  DEFAULT_RESOURCE_CLASS, DEFAULT_RUNTIME_EFFECT,
  type ResourceClass, type RuntimeEffect,
} from "./dispatch/engine_aware.ts";
import {
  join as pathJoin,
  dirname as pathDirname,
  basename as pathBasename,
  isAbsolute,
  resolve as pathResolve,
  relative as pathRelative,
} from "node:path";

export interface QualityGate {
  stack: string | null;
  full: string[];
  fast: string[];
  // scoped (W-068): the touched-crate `cargo -p <pkg>` commands, derived from the
  // resolved package names (task.touched_packages), NOT the whole-workspace build.
  // Empty when nothing could be scoped (no --touches, non-cargo, or a touch too
  // broad to scope) — then default_gate falls back to "full".
  scoped: string[];
  run_verify: string[];
  timeout_minutes_per_cmd: number | null;
  // default_gate (W-068): which set the worker runs by DEFAULT. "scoped" (the RAM-
  // cheap, foreground-fitting default per DEC-091) whenever scoped commands exist
  // and --full-gate was not requested; "full" only on explicit --full-gate opt-in
  // or when scoping was impossible. The authoritative whole-workspace compile is
  // the merge gate's job (DEC-091), never the worker's default self-gate.
  default_gate: "scoped" | "full";
}
export interface Anchors {
  entry_points: string | null;
  invariants: string | null;
  local_verify: string | null;
  source: string | null;
  filled: boolean; // false when any anchor is missing or still a {{placeholder}}
}
export interface FactPack {
  schema_version: 1;
  generated_by: "context_pack.ts";
  kind: "dispatch_fact_pack";
  advisory: true;
  task: {
    id: number | null;
    role: string | null;
    slug: string | null;
    branch: string | null;
    base_branch: string | null;
    base_sha: string | null;
    // W-053 declared conflict/dependency metadata, forward-supplied so a later
    // dispatch's conflict_check can read this container's declared file scope +
    // ordering intent. Empty arrays when the dispatch declared none.
    touches: string[];
    depends_on: string[];
    // touched_packages (W-068): the CARGO PACKAGE names resolved from `touches`
    // (nearest ancestor Cargo.toml `[package] name`), so a producer scopes its
    // gate with the real package id instead of hand-deriving it from a directory
    // name (the recurring `cooker_magic` -> `acme_cooker_magic` drift W-068
    // fixes). Empty when no touch resolved to a cargo crate.
    touched_packages: string[];
    // touches_unverified (W-090): declared touches that could NOT be resolved to a
    // real cargo package during verification (a stale/wrong path with no unambiguous
    // match). Kept here instead of being silently dropped so the producer still sees
    // the intent and can correct the path. Empty when every touch verified, or when
    // verification was skipped (non-cargo project / cargo unavailable).
    touches_unverified: string[];
    // touches_actual (W-021): the MEASURED path set (base_sha..HEAD) of what the
    // dispatch really edited, recorded at REPORTING by record_touches.ts so a gate /
    // Guardian reads the actual diff instead of the dispatch-time `touches`
    // PREDICTION (which goes stale — a P2a dispatch declared factory+dispatch but
    // actually touched canonical). Empty at dispatch time; populated post-hoc by
    // `dispatch_cleanup.sh --record-touches` / record_touches.ts.
    touches_actual: string[];
    // resource_class / runtime_effect (W-087): the machine-load class and the
    // observable runtime effect of this dispatch. resource_class=heavy routes
    // through the machine-wide heavy scheduler gate (heavy_dispatch_gate.ts) so two
    // full-workspace compiles never run at once on the RAM-bound box; runtime_effect
    // tells the close-contract check which RUN evidence to demand (a visual task
    // needs a screenshot / user-verdict pointer). An omitted field defaults to
    // light/none WITH a warning (back-compat) — normalized at the CLI boundary.
    resource_class: ResourceClass;
    runtime_effect: RuntimeEffect;
  };
  project: {
    pm_id: string;
    project_root: string;
    target: string | null;
    target_slug: string | null;
    integration_branch: string | null;
    target_branch: string | null;
  };
  quality_gate: QualityGate;
  anchors: Anchors;
  // Routing decision (W-026) forward-supplied so a producer/jig sees which model
  // it was dispatched at and why. null fields = inherit (no explicit routing).
  routing: {
    model: string | null;
    effort: string | null;
    source: string | null; // model_source: flag | blueprint | rule:<names> | seat-default | inherit
    // commit_mode (W-042 guardian round-2 N1): "self" | "proxy" | null (unresolved).
    // Forward-supplied so a downstream consumer (merge_land.sh) can tell WITHOUT
    // re-deriving from MODEL whether this dispatch's commits are expected to carry
    // a Garelier-Seat trailer — the seam --require-seat-trailer needed a caller.
    commit_mode: string | null;
  };
  // gate_agents (W-040): the Guardian/Observer Agent-tool `name` + verdict-marker
  // `report` path an attended PM would otherwise hand-build per session
  // (attended-gate-dispatch.md, workflow-naming.md §5) — same names/paths
  // dispatch_prepare.sh's own JSON `gate_agents` key emits, forward-supplied here
  // too so a producer/jig reading context.json sees them without re-deriving.
  // `report` is the SINGLE canonical verdict-marker path
  // (runtime/<role>/results/<slug>-<role>.md) that contract_check.ts --gate,
  // scanIdleNoRegister's gate-no-verdict, and merge_land.sh's verdict auto-read all
  // parse — so the PM copies ONE path into the gate request, never a hand-typed one
  // that drifts (W-020). `verdict_template` points at the marker's canonical starting
  // point (its `## Verdict` bare-token + fail-closed parser contract lives in the
  // template header) so the gate role writes a parseable marker, not free prose.
  // null when the task carries no slug (nothing to derive a name from).
  gate_agents: {
    guardian: { name: string; report: string; verdict_template: string };
    observer: { name: string; report: string; verdict_template: string };
  } | null;
  // commit_template (W-051): a ready-to-copy commit message skeleton whose
  // `Garelier:` marker trailer is fully filled (pm_id, `<role>#<id>` actor, and
  // the runtime task `#<id>` as the bound item id) so a producer copies the
  // trailer VERBATIM instead of re-deriving the convention (the recurring
  // per-role drift W-051 fixes). The `<type>(<scope>): <summary>` subject stays a
  // placeholder — only the producer knows the change type/scope/summary. Null
  // when the task carries no role/id. See commit_convention.md § Garelier marker.
  commit_template: string | null;
  // bug_fix_discipline (W-052): a one-line resident pointer to the 4-phase
  // debugging discipline (references/debugging_discipline.md) so a producer
  // fixing a bug applies observe→hypothesize→verify→root-cause-only + a
  // reproduction test RED→GREEN without the PM hand-writing it into every
  // bug-fix dispatch (the recurring PM hand-work this fixes). Constant, not
  // task-derived: the runtime task carries no type, so this ships on every
  // dispatch; it is a no-op pointer for non-bug work. Same forward-supply route
  // as commit_template.
  bug_fix_discipline: string;
  // bash_timeout_budget_ms (W-077): the effective bash-tool timeout ceiling (ms)
  // a foreground command may run before the harness KILLS the tool call (docs:
  // 2 min default / 10 min request ceiling, raisable via BASH_MAX_TIMEOUT_MS —
  // code.claude.com/docs/en/tools-reference.md). Forward-supplied so a producer
  // reads the ACTUAL limit instead of guessing: a job that would exceed this is
  // NOT run foreground-then-end-turn (it is killed at the ceiling and, observed
  // on Windows, orphans the child holding target/'s lock) — the producer asks
  // the operator to watch+wake instead (role_subagent_dispatch.md §6). Resolved
  // by resolveBashTimeoutBudgetMs; fail-open to DEFAULT_BASH_TIMEOUT_BUDGET_MS.
  bash_timeout_budget_ms: number;
  note: string;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

// target_slug is canonically the target branch with '/' → '-'. Computing it ONCE
// here removes the brittle per-producer re-derivation (the guardrail).
export function deriveTargetSlug(target: string | null, explicit?: string | null): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  if (!target) return null;
  return target.replace(/\//g, "-");
}

export function parseQualityGate(qgRaw: unknown): QualityGate {
  const qg = (qgRaw && typeof qgRaw === "object" ? qgRaw : {}) as Record<string, unknown>;
  const full = (qg.full && typeof qg.full === "object" ? (qg.full as Record<string, unknown>).commands : undefined);
  const fast = (qg.fast && typeof qg.fast === "object" ? (qg.fast as Record<string, unknown>).commands : undefined);
  // `[quality_gate] commands` is the legacy alias for `[quality_gate.full]`.
  const fullCmds = strArr(full).length ? strArr(full) : strArr(qg.commands);
  const fastCmds = strArr(fast).length ? strArr(fast) : fullCmds;
  return {
    stack: typeof qg.stack === "string" ? qg.stack : null,
    full: fullCmds,
    fast: fastCmds,
    // scoped / default_gate are derived from the resolved packages in
    // buildFactPack (they need task.touched_packages, not the config); default to
    // the "no scoping available -> run full" shape so parseQualityGate stays pure.
    scoped: [],
    run_verify: strArr(qg.run_verify_commands),
    timeout_minutes_per_cmd: typeof qg.timeout_minutes_per_cmd === "number" ? qg.timeout_minutes_per_cmd : null,
    default_gate: "full",
  };
}

// ---- W-068: touched-crate package resolution + scoped gate --------------------
//
// The worker's default self-gate must be scoped to the crates it touched (DEC-091:
// keep it under the foreground limit + RAM-cheap so producers run in parallel; the
// whole-workspace compile is the merge gate's authoritative job). DEC-091 left the
// worker to hand-derive the `-p <crate>` name, and it kept getting it wrong — a
// directory basename (`cooker_magic`) is NOT the cargo package name
// (`acme_cooker_magic`). W-068 resolves the real names here, ONCE, from the
// declared --touches, and forward-supplies the ready-to-run scoped command.

// A cargo package cap: if --touches resolves to MORE crates than this it is
// effectively a whole-workspace change, so scoping adds nothing — fall back to the
// full gate (the merge gate compiles the workspace anyway).
const SCOPED_PACKAGE_CAP = 12;

// Strip a glob down to its literal leading path (everything before the first
// wildcard); if the wildcard splits a path segment, drop that partial segment.
function globLiteralPrefix(glob: string): string {
  const wi = glob.search(/[*?[]/);
  let lit = wi === -1 ? glob : glob.slice(0, wi);
  if (wi !== -1 && !lit.endsWith("/")) {
    const slash = lit.lastIndexOf("/");
    lit = slash === -1 ? "" : lit.slice(0, slash);
  }
  return lit.replace(/[/\\]+$/, "");
}

// Read `[package] name` from a Cargo.toml. Returns null for a workspace-only
// manifest (no [package]) or on any read error (fail-open).
function cargoPackageName(cargoTomlPath: string): string | null {
  try {
    let inPkg = false;
    for (const raw of readFileSync(cargoTomlPath, "utf8").split("\n")) {
      const ln = raw.trim();
      if (/^\[package\]/.test(ln)) { inPkg = true; continue; }
      if (/^\[/.test(ln)) { inPkg = false; continue; }
      if (inPkg) {
        const g = /^name\s*=\s*"([^"]+)"/.exec(ln);
        if (g) return g[1];
      }
    }
  } catch { /* fail-open */ }
  return null;
}

// Walk UP from startDir to root looking for the innermost Cargo.toml that names a
// package (the crate the touched path belongs to).
function packageWalkingUp(startDir: string, root: string): string | null {
  let dir = startDir;
  for (;;) {
    const cargo = pathJoin(dir, "Cargo.toml");
    if (existsSync(cargo)) {
      const name = cargoPackageName(cargo);
      if (name) return name;
    }
    if (dir === root) break;
    const parent = pathDirname(dir);
    if (parent === dir || !parent.startsWith(root)) break;
    dir = parent;
  }
  return null;
}

// Walk DOWN from startDir (used when a touch prefix sits ABOVE any crate, e.g.
// `core/**`) collecting package names, capped. Stops descending at a crate
// boundary and skips build/vcs dirs.
function packagesWalkingDown(startDir: string, cap: number): string[] {
  const found = new Set<string>();
  const stack = [startDir];
  while (stack.length) {
    const dir = stack.pop() as string;
    const cargo = pathJoin(dir, "Cargo.toml");
    if (existsSync(cargo)) {
      const name = cargoPackageName(cargo);
      if (name) { found.add(name); continue; } // crate boundary — don't descend
    }
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      if (e === "target" || e === ".git" || e === "node_modules" || e.startsWith(".")) continue;
      const p = pathJoin(dir, e);
      try { if (statSync(p).isDirectory()) stack.push(p); } catch { /* ignore */ }
    }
    if (found.size > cap) break;
  }
  return [...found];
}

// Resolve the cargo package names a set of --touches globs refers to, relative to
// projectRoot. Fail-open: any error or a non-cargo project yields []. A resolution
// wider than SCOPED_PACKAGE_CAP is treated as "too broad to scope" -> [].
export function resolveTouchedPackages(projectRoot: string, touches: string[]): string[] {
  if (!projectRoot || !touches.length) return [];
  const found = new Set<string>();
  try {
    // Canonicalize the root ONCE (pathResolve normalizes separators) so every
    // derived path shares the root's separator style — otherwise a forward-slash
    // projectRoot (real dispatch) vs pathJoin's win32 backslashes makes the
    // walk-up `startsWith(root)` boundary check silently fail.
    const root = pathResolve(projectRoot);
    for (const glob of touches) {
      const prefix = globLiteralPrefix(glob);
      const abs = !prefix ? root : isAbsolute(prefix) ? pathResolve(prefix) : pathResolve(root, prefix);
      // A file prefix -> start from its directory; a directory -> start there.
      let startDir = abs;
      try { if (existsSync(abs) && !statSync(abs).isDirectory()) startDir = pathDirname(abs); } catch { /* ignore */ }
      if (!existsSync(startDir)) continue;
      const up = packageWalkingUp(startDir, root);
      if (up) { found.add(up); continue; }
      for (const p of packagesWalkingDown(startDir, SCOPED_PACKAGE_CAP)) found.add(p);
      if (found.size > SCOPED_PACKAGE_CAP) return [];
    }
  } catch { return []; }
  if (found.size > SCOPED_PACKAGE_CAP) return [];
  return [...found].sort();
}

// ---- W-090: verify declared --touches against the authoritative package list ----
//
// resolveTouchedPackages above trusts the declared --touches PATHS (which come from
// blueprint/CLAUDE.md wording) and walks the fs from them. When a declared path is
// stale or wrong, the fs walk finds no crate and the touch is SILENTLY DROPPED —
// three real dispatch harms (worker reports): #178 `core/driver/bootstrap` derived
// but the crate lives at `core/engine/bootstrap` (path wrong); #180 a 5-crate
// cross-crate task where only 2 crates landed in touched_packages (3 declared paths
// resolved to nothing); #179 an observability path dragged from an old CLAUDE.md
// entry that no longer matches reality. The fix is a verification layer: resolve
// each declared touch against the project's REAL package list (`cargo metadata`)
// and (a) correct a stale/wrong path to the crate's canonical directory, (b) keep
// an unresolvable touch in `touches_unverified` instead of dropping it silently.
//
// Rust-agnostic: this is an OPT-IN refinement. When `cargo metadata` is unavailable
// (not a cargo project, or cargo not installed), verification is SKIPPED and the
// pre-W-090 fs-walk resolution (resolveTouchedPackages) is used unchanged — a
// non-cargo project keeps exactly today's behavior.

export interface CargoPackage {
  name: string; // the cargo [package] name (the `-p <name>` scoped-gate id)
  dir: string;  // package directory, RELATIVE to the project root, posix-normalized ("" = repo root)
  // W-040: whether the package has a library target (lib/rlib/dylib/cdylib/
  // staticlib/proc-macro). Drives the scoped test command shape — `--lib` errors
  // outright on a bin-only crate ("no library targets found"). null = unknown
  // (metadata had no targets info / fs-walk path) -> plain `cargo test -p`.
  hasLib?: boolean | null;
}

// Normalize a declared/derived path to a root-relative posix comparison key: strip
// backslashes, a leading `./`, and any trailing slash.
function toPosixRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

// Parse `cargo metadata --format-version 1 --no-deps` JSON into the workspace's
// packages as {name, root-relative dir}. Returns null on any parse problem or when
// it yields no packages (treated as "no authoritative list" -> skip verification).
export function parseCargoMetadata(jsonText: string, projectRoot: string): CargoPackage[] | null {
  try {
    const meta = JSON.parse(jsonText) as {
      packages?: Array<{
        id?: string;
        name?: string;
        manifest_path?: string;
        targets?: Array<{ kind?: string[] }>;
      }>;
      workspace_members?: string[];
    };
    if (!meta || !Array.isArray(meta.packages)) return null;
    const root = pathResolve(projectRoot);
    // With --no-deps `packages` is already the workspace members; still filter by
    // workspace_members when present so a full-metadata file (deps included) does
    // not pull dependency crates into the match set.
    const members =
      Array.isArray(meta.workspace_members) && meta.workspace_members.length
        ? new Set(meta.workspace_members)
        : null;
    const out: CargoPackage[] = [];
    for (const p of meta.packages) {
      if (!p || !p.name || !p.manifest_path) continue;
      if (members && p.id && !members.has(p.id)) continue;
      const dir = toPosixRel(pathRelative(root, pathDirname(p.manifest_path)));
      // W-040: lib-target detection from metadata targets. Absent targets -> null.
      const LIB_KINDS = new Set(["lib", "rlib", "dylib", "cdylib", "staticlib", "proc-macro"]);
      const hasLib = Array.isArray(p.targets)
        ? p.targets.some((t) => Array.isArray(t?.kind) && t.kind.some((k) => LIB_KINDS.has(k)))
        : null;
      out.push({ name: p.name, dir, hasLib });
    }
    return out.length ? out : null;
  } catch {
    return null; // fail-open: unparseable metadata -> skip verification
  }
}

// Resolve the authoritative package list for a project, or null when unavailable
// (skip verification). Test/offline seam: GARELIER_CARGO_METADATA_FILE points at a
// pre-captured `cargo metadata` JSON, used instead of spawning cargo. Otherwise a
// project with no root Cargo.toml -> null (non-cargo -> skip), and any cargo
// failure -> null (fail-open).
export function cargoPackages(projectRoot: string): CargoPackage[] | null {
  if (!projectRoot) return null;
  const override = process.env.GARELIER_CARGO_METADATA_FILE;
  if (override) {
    try {
      return parseCargoMetadata(readFileSync(override, "utf8"), projectRoot);
    } catch {
      return null;
    }
  }
  const root = pathResolve(projectRoot);
  if (!existsSync(pathJoin(root, "Cargo.toml"))) return null; // not a cargo project -> skip
  try {
    const r = Bun.spawnSync(
      ["cargo", "metadata", "--format-version", "1", "--no-deps", "--manifest-path", pathJoin(root, "Cargo.toml")],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if ((r.exitCode ?? 1) !== 0 || !r.stdout) return null;
    return parseCargoMetadata(r.stdout.toString(), root);
  } catch {
    return null;
  }
}

// Classify one declared touch prefix against the real package list.
//   - "member": the touch sits ON or UNDER a package dir (already canonical) — keep it.
//   - "above":  the touch is an ANCESTOR of one or more package dirs (e.g. `core/**`) — keep it.
//   - "corrected": the touch matches no package position, but its basename (or the
//     literal string) UNAMBIGUOUSLY names one package (a stale/wrong path) — correct
//     it to that package's canonical dir (#178/#179).
//   - "unverified": nothing matched (0, or an ambiguous >1 basename match).
function classifyTouch(
  prefix: string,
  packages: CargoPackage[],
): { kind: "member" | "above" | "corrected" | "unverified"; canonical?: string; names: string[] } {
  // ON / UNDER a package (a root package, dir "", contains everything).
  const container = packages.find(
    (p) => prefix === p.dir || (p.dir === "" ? prefix !== "" : prefix.startsWith(p.dir + "/")),
  );
  if (container) return { kind: "member", names: [container.name] };

  // ABOVE one-or-more packages (the touch prefix is an ancestor directory).
  const below = packages.filter((p) => prefix === "" || p.dir === prefix || p.dir.startsWith(prefix + "/"));
  if (below.length) return { kind: "above", names: below.map((p) => p.name) };

  // CORRECTABLE: the basename (or the whole literal) names exactly one package.
  const base = pathBasename(prefix);
  if (base) {
    const byName = packages.filter((p) => pathBasename(p.dir) === base || p.name === base);
    if (byName.length === 1) return { kind: "corrected", canonical: byName[0].dir, names: [byName[0].name] };
  }
  return { kind: "unverified", names: [] };
}

export interface VerifiedTouches {
  touches: string[]; // declared touches, wrong paths corrected to the canonical package dir
  touched_packages: string[]; // resolved package names (sorted, deduped, cap-limited)
  touches_unverified: string[]; // declared touches that matched NO package — kept, never dropped
}

// The verification layer (W-090). When `packages` is null verification is skipped
// and the pre-W-090 fs-walk (resolveTouchedPackages) supplies touched_packages with
// touches passed through unchanged. Otherwise each declared touch is classified and
// corrected/kept/flagged as above.
export function verifyTouchedPackages(
  projectRoot: string,
  declaredTouches: string[],
  packages: CargoPackage[] | null,
): VerifiedTouches {
  if (!declaredTouches.length) return { touches: [], touched_packages: [], touches_unverified: [] };
  if (packages === null) {
    // Skip (non-cargo / cargo unavailable): current behavior, byte-for-byte.
    return {
      touches: [...declaredTouches],
      touched_packages: resolveTouchedPackages(projectRoot, declaredTouches),
      touches_unverified: [],
    };
  }
  const touches: string[] = [];
  const names = new Set<string>();
  const unverified: string[] = [];
  const pushUnique = (arr: string[], v: string) => {
    if (v && !arr.includes(v)) arr.push(v);
  };
  for (const glob of declaredTouches) {
    const prefix = toPosixRel(globLiteralPrefix(glob));
    const cls = classifyTouch(prefix, packages);
    if (cls.kind === "unverified") {
      pushUnique(unverified, glob);
      continue;
    }
    // member/above keep the declared touch verbatim; corrected records the crate dir.
    pushUnique(touches, cls.kind === "corrected" ? (cls.canonical as string) : glob);
    for (const n of cls.names) names.add(n);
  }
  // A resolution wider than the cap is effectively a whole-workspace change — drop
  // the scoping (parity with resolveTouchedPackages) but keep touches/unverified.
  let touched_packages = [...names].sort();
  if (touched_packages.length > SCOPED_PACKAGE_CAP) touched_packages = [];
  return { touches, touched_packages, touches_unverified: unverified };
}

// The scoped default gate per crate: a `cargo check` (fast compile signal) + the
// crate's lib unit tests. Skips workspace integration/doc tests (the merge gate's
// job). Cargo-specific by construction — the packages come from Cargo.toml.
// W-040: `--lib` on a bin-only crate fails outright ("no library targets found" —
// hit in the field on a bin tool crate), so the test command shape follows the
// package's real targets: lib -> `--lib` (skip integration/doc = merge gate's job),
// bin-only -> `--bins`, unknown -> plain `cargo test -p` (never errors; slightly
// heavier is better than a guaranteed false failure).
export function buildScopedCommands(packages: string[], info?: CargoPackage[] | null): string[] {
  const byName = new Map<string, CargoPackage>();
  for (const p of info ?? []) byName.set(p.name, p);
  const cmds: string[] = [];
  for (const p of packages) {
    cmds.push(`cargo check -p ${p}`);
    const hasLib = byName.get(p)?.hasLib;
    if (hasLib === true) cmds.push(`cargo test -p ${p} --lib`);
    else if (hasLib === false) cmds.push(`cargo test -p ${p} --bins`);
    else cmds.push(`cargo test -p ${p}`);
  }
  return cmds;
}

// ---- W-077: effective bash-tool timeout budget -------------------------------
//
// The harness kills a foreground bash command at the tool-timeout ceiling (docs:
// 2 min default, 10 min if the call requests it, raisable by BASH_MAX_TIMEOUT_MS
// — code.claude.com/docs/en/tools-reference.md). We forward-supply the EFFECTIVE
// ceiling so a producer sizes its foreground gate/verify against the real limit
// instead of guessing (a job that would exceed it must go to the operator
// watch+wake path, not foreground-then-end-turn). Read precedence, highest
// first: the project's `.claude/settings.local.json` `env.BASH_MAX_TIMEOUT_MS`,
// then `.claude/settings.json` `env.BASH_MAX_TIMEOUT_MS`, then the process env
// `BASH_MAX_TIMEOUT_MS`, then the fallback below (the documented 10-minute
// request ceiling). Fail-open at every step: an absent / unreadable /
// unparseable settings file is skipped, never a crash.

// The documented 10-minute per-command request ceiling, in ms — the fallback
// when nothing raises it.
export const DEFAULT_BASH_TIMEOUT_BUDGET_MS = 600000;

// Read `env.BASH_MAX_TIMEOUT_MS` from a `.claude/settings*.json`. Returns a
// positive finite number, or null when the file is absent / unreadable /
// unparseable / missing the key / non-positive (fail-open — the caller falls
// through to the next source).
function settingsBashMax(settingsPath: string): number | null {
  try {
    if (!existsSync(settingsPath)) return null;
    const j = JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: Record<string, unknown> };
    const v = j?.env?.BASH_MAX_TIMEOUT_MS;
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null; // fail-open
  }
}

// Resolve the effective bash timeout budget (ms) for a project. `env` is passed
// in (not read from `process.env` directly) so the resolution order is testable;
// main() passes `process.env`.
export function resolveBashTimeoutBudgetMs(
  projectRoot: string,
  env: Record<string, string | undefined> = {},
): number {
  if (projectRoot) {
    const local = settingsBashMax(pathJoin(projectRoot, ".claude", "settings.local.json"));
    if (local != null) return local;
    const shared = settingsBashMax(pathJoin(projectRoot, ".claude", "settings.json"));
    if (shared != null) return shared;
  }
  const fromEnv = env.BASH_MAX_TIMEOUT_MS != null ? Number(env.BASH_MAX_TIMEOUT_MS) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_BASH_TIMEOUT_BUDGET_MS;
}

// Extract the three Context-pack anchors from a blueprint's `## Context pack`
// section. An unfilled `{{...}}` placeholder counts as missing.
export function parseAnchors(blueprintMd: string, source: string | null): Anchors {
  // Collect the lines under `## Context pack` up to the next `## ` heading.
  // (Line scan, not a single regex — JS has no `\Z` end-of-string anchor.)
  const lines = blueprintMd.split("\n");
  let inSection = false;
  const collected: string[] = [];
  for (const ln of lines) {
    if (/^##\s+Context pack\s*$/i.test(ln)) { inSection = true; continue; }
    if (inSection && /^##\s+/.test(ln)) break;
    if (inSection) collected.push(ln);
  }
  const section = collected.join("\n");
  const grab = (label: string): string | null => {
    const re = new RegExp(`^[-*]\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im");
    const g = re.exec(section);
    if (!g) return null;
    const val = g[1].trim();
    if (!val || val.includes("{{")) return null; // unfilled placeholder
    return val;
  };
  const entry_points = grab("Entry points");
  const invariants = grab("Invariants");
  const local_verify = grab("Local verify");
  return {
    entry_points,
    invariants,
    local_verify,
    source,
    filled: Boolean(entry_points || invariants || local_verify),
  };
}

// Same sanitize + 64-char truncate as dispatch_prepare.sh's AGENT_NAME /
// GUARDIAN_NAME / OBSERVER_NAME (bash `tr -c 'A-Za-z0-9_-' '-'` + leading-char
// guard) so a slug that reaches either implementation resolves to the same name.
function sanitizeAgentName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "-");
  const named = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : `a${cleaned}`;
  return named.slice(0, 64);
}

// commit_template (W-051): fill the `Garelier:` trailer with what dispatch knows
// (pm_id, `<role>#<id>` actor, and the runtime task `#<id>` as the bound item id).
// The subject is a placeholder the producer completes. Null when role/id is absent.
export function buildCommitTemplate(pmId: string, role: string | null, id: number | null): string | null {
  if (!role || id == null) return null;
  const item = `#${id}`;
  return `<type>(<scope>): <summary>  [${item}]\n\nGarelier: ${pmId} ${role}#${id} ${item}`;
}

// bug_fix_discipline (W-052): the constant one-line pointer shipped on every
// dispatch (see the FactPack field comment). dispatch_prepare.sh emits the
// identical literal so context.json and the JSON handoff agree.
export const BUG_FIX_DISCIPLINE =
  "bug fix discipline: observe -> hypothesize -> verify -> fix the confirmed root cause only; reproduction test RED->GREEN first (instrumentation-log before/after when a test is impossible, e.g. visual/GPU); no guess fix / symptom-silencing guard / shotgun fix. Full rule: garelier-core/references/debugging_discipline.md (W-052).";

// The gate verdict-marker template (W-020): the canonical starting point a gate
// role copies so its `## Verdict` marker is a bare canonical token the parser reads
// (the fail-closed contract lives in the template header). Repo-relative so the PM
// pastes it into the gate request verbatim. dispatch_prepare.sh emits the identical
// literal into its own gate_agents JSON.
export const GATE_VERDICT_TEMPLATE = "skills/garelier-core/templates/gate_verdict.md";

export function buildGateAgents(slug: string | null): FactPack["gate_agents"] {
  if (!slug) return null;
  return {
    guardian: {
      name: sanitizeAgentName(`ga-guardian-${slug}`),
      report: `runtime/guardian/results/${slug}-guardian.md`,
      verdict_template: GATE_VERDICT_TEMPLATE,
    },
    observer: {
      name: sanitizeAgentName(`ga-observer-${slug}`),
      report: `runtime/observer/results/${slug}-observer.md`,
      verdict_template: GATE_VERDICT_TEMPLATE,
    },
  };
}

export interface BuildInputs {
  pmId: string;
  projectRoot: string;
  integration?: string | null;
  config?: Record<string, unknown> | null;
  blueprintMd?: string | null;
  blueprintPath?: string | null;
  task?: Partial<FactPack["task"]>;
  routing?: Partial<FactPack["routing"]>;
  // W-068: cargo package names resolved from task.touches (main() does the fs
  // walk via resolveTouchedPackages and passes them in so buildFactPack stays
  // pure/testable). Absent -> [] -> nothing to scope.
  touchedPackages?: string[];
  // W-040: the resolved workspace package list (with lib-target info) so the
  // scoped gate can shape each crate's test command. Absent/null -> unknown.
  packages?: CargoPackage[] | null;
  // W-090: declared touches that verification could not resolve to a real package
  // (main() runs verifyTouchedPackages and passes them in so buildFactPack stays
  // pure/testable). Absent -> [] -> nothing unverified.
  touchesUnverified?: string[];
  // W-068: --full-gate opt-in — force default_gate="full" for a task that
  // genuinely needs the whole-workspace gate as its self-gate.
  fullGate?: boolean;
  // W-077: the resolved effective bash timeout budget (ms). main() resolves it
  // via resolveBashTimeoutBudgetMs (fs read of .claude/settings*.json + env) so
  // buildFactPack stays pure/testable. Absent -> DEFAULT_BASH_TIMEOUT_BUDGET_MS.
  bashTimeoutBudgetMs?: number;
}

export function buildFactPack(inp: BuildInputs): FactPack {
  const cfg = inp.config ?? {};
  const branches = (cfg.branches && typeof cfg.branches === "object" ? cfg.branches : {}) as Record<string, unknown>;
  const target = typeof branches.target === "string" ? branches.target : null;
  const target_slug = deriveTargetSlug(target, typeof branches.target_slug === "string" ? branches.target_slug : null);
  const integration =
    inp.integration ?? (typeof branches.integration === "string" ? branches.integration : null);

  // W-068: derive the scoped default gate from the resolved packages. scoped is
  // non-empty only when --touches resolved to cargo crates; default_gate is
  // "scoped" unless --full-gate was requested or scoping was impossible.
  const touchedPackages = inp.touchedPackages ?? [];
  const quality_gate = parseQualityGate(cfg.quality_gate);
  quality_gate.scoped = buildScopedCommands(touchedPackages, inp.packages ?? null);
  quality_gate.default_gate = inp.fullGate ? "full" : quality_gate.scoped.length > 0 ? "scoped" : "full";

  return {
    schema_version: 1,
    generated_by: "context_pack.ts",
    kind: "dispatch_fact_pack",
    advisory: true,
    task: {
      id: inp.task?.id ?? null,
      role: inp.task?.role ?? null,
      slug: inp.task?.slug ?? null,
      branch: inp.task?.branch ?? null,
      base_branch: inp.task?.base_branch ?? integration ?? null,
      base_sha: inp.task?.base_sha ?? null,
      touches: inp.task?.touches ?? [],
      depends_on: inp.task?.depends_on ?? [],
      touched_packages: touchedPackages,
      touches_unverified: inp.touchesUnverified ?? [],
      // W-021: empty at dispatch time — record_touches.ts fills it at REPORTING from
      // the measured base_sha..HEAD diff. Preserved from an existing pack if present
      // (a re-derivation must not wipe a recorded measurement).
      touches_actual: inp.task?.touches_actual ?? [],
      // W-087: normalized at the CLI boundary (main() warns on a defaulted field);
      // buildFactPack stays pure and simply falls back to the least-constraining
      // default so an omitting caller still produces a valid pack (back-compat).
      resource_class: inp.task?.resource_class ?? DEFAULT_RESOURCE_CLASS,
      runtime_effect: inp.task?.runtime_effect ?? DEFAULT_RUNTIME_EFFECT,
    },
    project: {
      pm_id: inp.pmId,
      project_root: inp.projectRoot,
      target,
      target_slug,
      integration_branch: integration,
      target_branch: target,
    },
    quality_gate,
    anchors: inp.blueprintMd
      ? parseAnchors(inp.blueprintMd, inp.blueprintPath ?? null)
      : { entry_points: null, invariants: null, local_verify: null, source: inp.blueprintPath ?? null, filled: false },
    routing: {
      model: inp.routing?.model ?? null,
      effort: inp.routing?.effort ?? null,
      source: inp.routing?.source ?? null,
      commit_mode: inp.routing?.commit_mode ?? null,
    },
    gate_agents: buildGateAgents(inp.task?.slug ?? null),
    commit_template: buildCommitTemplate(inp.pmId, inp.task?.role ?? null, inp.task?.id ?? null),
    bug_fix_discipline: BUG_FIX_DISCIPLINE,
    bash_timeout_budget_ms: inp.bashTimeoutBudgetMs ?? DEFAULT_BASH_TIMEOUT_BUDGET_MS,
    note: "forward-supplied facts (DEC-081); advisory — open the raw assignment / blueprint / AGENTS.md on demand, never a substitute for what the task needs, and re-derivation is never required. The producer hot-rules once inlined here are NOT restated (they only drifted out of sync); read them where your role SKILL already sends you: run-to-completion + ONE mid-build progress message (W-034/W-037) and a scoped self-gate via quality_gate.default_gate/scoped + task.touched_packages with no hand-derived crate name (W-068/DEC-091) = your role SKILL boundaries (Worker SKILL §2); size a foreground command against bash_timeout_budget_ms and route an over-budget job to the operator watch+wake path (not foreground-then-end-turn), and register-terminate your FINAL turn — a commit/STATE update alone is not a completion signal (W-077/W-085) = role_subagent_dispatch.md §6; keep report.md / the compact result register-compliant and pipe heavy gate/verify output through scripts/run_summarized.sh (W-042/W-043b) = garelier-core/output_control.md. Read those for the rule.",
  };
}

// ---- CLI --------------------------------------------------------------------

function fail(msg: string): never {
  process.stderr.write(`context_pack: ${msg}\n`);
  process.exit(2);
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function numFlag(name: string): number | null {
  const v = flag(name);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function csvFlag(name: string): string[] {
  const v = flag(name);
  if (v == null) return [];
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

async function readMaybe(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    const f = Bun.file(path);
    return (await f.exists()) ? await f.text() : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const pmId = flag("pm-id");
  const projectRoot = flag("project");
  if (!pmId || !projectRoot) fail("usage: context_pack.ts --config <toml> --pm-id <id> --project <abs> --integration <branch> [--task-id N --role R --slug S --branch B --base-sha SHA] [--touches a,b --depends-on slug,#id] [--resource-class heavy|light|data|review --runtime-effect none|headless|visual|aural|input] [--full-gate] [--blueprint <path>] [--out <path>]");

  // W-087: normalize the two engine-aware fields; warn (never fail) when a field
  // was unspecified or unknown so an omitting dispatch defaults to light/none with
  // a visible nudge to declare them (required on new dispatches).
  const resourceClass = normalizeResourceClass(flag("resource-class"));
  const runtimeEffect = normalizeRuntimeEffect(flag("runtime-effect"));
  if (resourceClass.warning) process.stderr.write(`context_pack: ${resourceClass.warning}\n`);
  if (runtimeEffect.warning) process.stderr.write(`context_pack: ${runtimeEffect.warning}\n`);

  let config: Record<string, unknown> | null = null;
  const configText = await readMaybe(flag("config"));
  if (configText) {
    try {
      config = parse(configText) as Record<string, unknown>;
    } catch (e) {
      // Fail-open: keep config null so the pack carries unknowns, never crash dispatch.
      process.stderr.write(`context_pack: cannot parse config (${(e as Error).message}); emitting partial pack\n`);
    }
  }

  const blueprintPath = flag("blueprint");
  const blueprintMd = await readMaybe(blueprintPath);

  // W-090: verify the declared --touches against the project's real package list
  // (`cargo metadata`, or skip on a non-cargo project). Corrects a stale/wrong path
  // to the crate's canonical dir and keeps an unresolvable touch in touches_unverified
  // instead of silently dropping it (the #178/#180/#179 drift). Skip = the pre-W-090
  // fs walk (resolveTouchedPackages), so a non-cargo project is unchanged.
  const declaredTouches = csvFlag("touches");
  const workspacePackages = cargoPackages(projectRoot);
  const verified = verifyTouchedPackages(projectRoot, declaredTouches, workspacePackages);
  if (verified.touches_unverified.length) {
    process.stderr.write(
      `context_pack: ${verified.touches_unverified.length} declared --touches did not resolve to a cargo package ` +
        `(kept as touches_unverified, not dropped): ${verified.touches_unverified.join(", ")}\n`,
    );
  }

  const pack = buildFactPack({
    pmId,
    projectRoot,
    integration: flag("integration") ?? null,
    config,
    blueprintMd,
    blueprintPath: blueprintPath ?? null,
    task: {
      id: numFlag("task-id"),
      role: flag("role") ?? null,
      slug: flag("slug") ?? null,
      branch: flag("branch") ?? null,
      base_sha: flag("base-sha") ?? null,
      // W-053 CSV declarations -> trimmed, non-empty arrays. touches carries the
      // W-090-corrected paths (stale/wrong paths fixed to the canonical crate dir).
      touches: verified.touches,
      depends_on: csvFlag("depends-on"),
      // W-087: the normalized engine-aware fields (defaulted + warned above).
      resource_class: resourceClass.value,
      runtime_effect: runtimeEffect.value,
    },
    routing: {
      // Empty strings (resolver's "inherit") normalize to null.
      model: flag("model") || null,
      effort: flag("effort") || null,
      source: flag("model-source") || null,
      commit_mode: flag("commit-mode") || null,
    },
    // W-068/W-090: the cargo package names the declared --touches refer to, resolved
    // against the real package list (verification layer) so the scoped default gate
    // carries every touched crate's real id; --full-gate forces the whole-workspace
    // gate as the self-gate instead.
    touchedPackages: verified.touched_packages,
    packages: workspacePackages,
    touchesUnverified: verified.touches_unverified,
    fullGate: process.argv.includes("--full-gate"),
    // W-077: resolve the effective bash-tool timeout ceiling from the project's
    // .claude/settings*.json + env so the producer sizes its foreground gate
    // against the real limit (fail-open to the documented 10-minute ceiling).
    bashTimeoutBudgetMs: resolveBashTimeoutBudgetMs(projectRoot, process.env),
  });

  const json = JSON.stringify(pack, null, 2);
  const out = flag("out");
  if (out) {
    await Bun.write(out, json + "\n");
    process.stdout.write(`${out}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

if (import.meta.main) {
  void main();
}
