#!/usr/bin/env bun
// attended_spawn.ts — W-168: ONE command to prepare a PM-attended subagent spawn.
//
// Hand-making a gate/worker seat is where names drift ("サブの名称が ga-role でなくなって
// いる") and records get forgotten (→ every command asks). This helper does all of it
// in one call: it resolves the canonical seat identity, issues the attended
// permission record (--pm-direct), and prints a spawn plan (name + profile + report
// path + verdict template + prompt skeleton). The PM only appends the task-specific
// prompt and passes name/model to the Agent tool.
//
// For a gate seat tied to a prepared dispatch (--dispatch-id), the name / report /
// verdict template are read VERBATIM from that dispatch's context.json gate_agents
// (dispatch_prepare + context_pack + this tool all derive identity from the shared
// gate_agents.ts, so they cannot drift). It never relaxes policy — it only supplies
// the record command_guard already reads; the deny floor is unaffected.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeAttendedRecord, type AttendedProfile } from "../guard/attended_record.ts";
import { crewSubdir } from "../workspace.ts";
import { GATE_VERDICT_TEMPLATE, seatAgentName, seatReportPath } from "./gate_agents.ts";

export type SpawnRole = "guardian" | "observer" | "worker" | "scout";

// (a) role → attended profile: gate seats (guardian/observer) get the read-only
// gate profile; work seats (worker/scout) get the producer in-fence band.
const ROLE_PROFILE: Record<SpawnRole, AttendedProfile> = {
  guardian: "gate", observer: "gate", worker: "producer", scout: "producer",
};
const ROLE_SKILL: Record<SpawnRole, string> = {
  guardian: "garelier-guardian", observer: "garelier-observer",
  worker: "garelier-worker", scout: "garelier-scout",
};

export function roleProfile(role: string): AttendedProfile {
  if (!(role in ROLE_PROFILE)) {
    throw new Error(`attended_spawn: --role must be guardian|observer|worker|scout (got '${role}')`);
  }
  return ROLE_PROFILE[role as SpawnRole];
}
export type GateRole = "guardian" | "observer";
// W-182: a type predicate (not `: boolean`), so a guarded `role` narrows to
// GateRole and `ctx.gate_agents[role]` type-checks (the latent tsc error was
// indexing the `{ guardian; observer }` map with an un-narrowed SpawnRole).
export function isGateRole(role: SpawnRole): role is GateRole { return role === "guardian" || role === "observer"; }

// O1: model comes through so the --dispatch-id plan carries the dispatch's already-
// resolved gate model (the PM does not re-supply a value the machine computed).
export interface GateAgentInfo { name: string; report: string; verdict_template: string; model?: string }
export interface DispatchContext {
  slug: string | null;
  worktree: string | null;
  branch: string | null;
  gate_agents: { guardian: GateAgentInfo; observer: GateAgentInfo } | null;
}

/** Read a dispatch container's context.json — the slug, checkout worktree, branch,
 * and the declared gate_agents (adopted verbatim for a gate seat). Null when
 * unreadable. */
export function readDispatchContext(container: string): DispatchContext | null {
  const path = join(container, "context.json");
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    return {
      slug: j?.task?.slug ?? j?.slug ?? null,
      worktree: j?.guard?.worktree ?? j?.worktree ?? null,
      branch: j?.task?.branch ?? j?.branch ?? null,
      gate_agents: j?.gate_agents ?? null,
    };
  } catch { return null; }
}

export interface SpawnPlan {
  role: SpawnRole;
  profile: AttendedProfile;
  name: string;
  slug: string;
  model: string | null;
  report_path: string;
  verdict_template: string | null;
  worktree: string;
  fence_roots: string[];
  record_path: string;
  prompt_skeleton: string;
}

export interface PromptOrientation { project?: string; pmId?: string; branch?: string | null; worktree: string; reportPath: string; verdictTemplate: string | null }

/** The prompt骨格: an ORIENTATION line (repo root / pm_id / branch / worktree — the
 * mechanical per-dispatch context, O2) + the garelier skill invocation + the
 * read-only / commit contract + the report path + the W-146 delivery rule. The PM
 * appends only the task-specific tail below the boundary. */
export function buildPromptSkeleton(role: SpawnRole, slug: string, o: PromptOrientation): string {
  const orient = [
    o.project ? `repo=${o.project}` : "",
    o.pmId ? `pm_id=${o.pmId}` : "",
    o.branch ? `branch=${o.branch}` : "",
    `worktree=${o.worktree}`,
  ].filter(Boolean).join(" | ");
  const lines = [
    `Use the ${ROLE_SKILL[role]} skill for this ${role} seat (dispatch ${slug}).`,
    `- Orientation: ${orient}`,
    isGateRole(role)
      ? `- READ-ONLY: inspect only — no worktree edits, no commits. Write your verdict to ${o.reportPath}.`
      : `- Work ONLY inside your assigned worktree; commit with the row trailer; do not push.`,
  ];
  if (o.verdictTemplate) lines.push(`- Write the verdict using the template at ${o.verdictTemplate}.`);
  lines.push(
    `- Delivery (W-146): SEND the register AND every progress message via SendMessage to the PM — plain text alone is not a completion signal.`,
    `<<< PM: append the task-specific instructions below this line >>>`,
  );
  return lines.join("\n");
}

export interface SpawnOptions {
  role: string;
  slug?: string;
  project?: string;
  pmId?: string;
  garelierRoot?: string;
  dispatchId?: string;
  worktree?: string;
  fenceRoots?: string[];
  model?: string;
}

/** The PM control root that holds runtime/<role>/results — the gate seat's verdict
 * fence. Derived from --project/--pm-id, else the `__garelier/<pm>` ancestor of the
 * worktree. */
function pmControlRoot(opts: SpawnOptions, worktree: string): string | null {
  const base = opts.garelierRoot ?? opts.project;
  if (base && opts.pmId) return resolve(base, "__garelier", opts.pmId);
  const parts = resolve(worktree).split(/[\\/]+/);
  const idx = parts.lastIndexOf("__garelier");
  if (idx >= 0 && parts[idx + 1]) return parts.slice(0, idx + 2).join("/");
  return null;
}

export function runAttendedSpawn(opts: SpawnOptions, cwd = process.cwd()): SpawnPlan {
  const profile = roleProfile(opts.role); // validates role
  const role = opts.role as SpawnRole;
  let slug = opts.slug ?? "";
  let worktree = opts.worktree ?? "";
  let branch: string | null = null;
  let gateInfo: GateAgentInfo | null = null;

  if (opts.dispatchId) {
    if (!opts.project) throw new Error("attended_spawn: --dispatch-id requires --project");
    if (!opts.pmId) throw new Error("attended_spawn: --dispatch-id requires --pm-id");
    const container = crewSubdir(opts.project, opts.pmId, `_dispatch${opts.dispatchId}`);
    const ctx = readDispatchContext(container);
    if (!ctx) throw new Error(`attended_spawn: no readable context.json under dispatch ${opts.dispatchId} (${join(container, "context.json")})`);
    if (!slug) slug = ctx.slug ?? "";
    if (!worktree) worktree = ctx.worktree ?? join(container, "checkout");
    branch = ctx.branch;
    // gate seats adopt the dispatch's DECLARED gate_agents entry verbatim — the
    // single fix for hand-made names (user 指摘 2026-07-19).
    if (isGateRole(role) && ctx.gate_agents) gateInfo = ctx.gate_agents[role];
  }
  if (!slug) throw new Error("attended_spawn: --slug is required (or --dispatch-id with a slug in its context.json)");
  if (!worktree) throw new Error("attended_spawn: --worktree is required (or --dispatch-id to derive the checkout)");

  const name = gateInfo?.name ?? seatAgentName(role, slug);
  const reportPath = gateInfo?.report ?? seatReportPath(role, slug);
  const verdictTemplate = profile === "gate" ? (gateInfo?.verdict_template ?? GATE_VERDICT_TEMPLATE) : null;
  // O1: prefer the dispatch's already-resolved gate model; --model overrides.
  const model = opts.model ?? gateInfo?.model ?? null;

  // Fence: a work seat writes in its checkout; a gate seat is read-only and only
  // writes its verdict under the PM control root (runtime/<role>/results).
  let fenceRoots = opts.fenceRoots?.length ? opts.fenceRoots : undefined;
  if (!fenceRoots && isGateRole(role)) {
    const pmRoot = pmControlRoot(opts, worktree);
    if (pmRoot) fenceRoots = [pmRoot];
  }

  const { path: recordPath, record } = writeAttendedRecord(
    {
      agent: name, worktree, profile, fenceRoots,
      garelierRoot: opts.garelierRoot ?? opts.project, pmId: opts.pmId, laneKind: "pm-direct",
      // O4: stamp attended_spawn's own records so the gate-name detective can exempt
      // a conformant ad-hoc (no --dispatch-id) gate seat instead of false-flagging it.
      spawnedVia: "attended_spawn",
    },
    cwd,
  );
  const resolvedFence = ((record.guard as Record<string, unknown>)?.fence_roots as string[]) ?? [];

  return {
    role, profile, name, slug, model,
    report_path: reportPath, verdict_template: verdictTemplate,
    worktree: resolve(worktree), fence_roots: resolvedFence, record_path: recordPath,
    prompt_skeleton: buildPromptSkeleton(role, slug, {
      project: opts.project, pmId: opts.pmId, branch, worktree: resolve(worktree), reportPath, verdictTemplate,
    }),
  };
}

// --- W-168 (c) detective: hand-made gate seat names ------------------------

/** A gate-seat attended record whose name looks like a gate seat (`ga-guardian-*`
 * / `ga-observer-*`) but is NOT among the DECLARED dispatch gate_agents names AND
 * was NOT written by attended_spawn is a HAND-MADE name — the drift this tool
 * removes (user 指摘: "サブの名称が ga-role でなくなっている"). O4: a record stamped
 * `spawned_via: "attended_spawn"` is conformant by construction (attended_spawn
 * always uses seatAgentName), so an ad-hoc gate seat created WITHOUT --dispatch-id
 * is exempt and does not false-flag pmAction NEEDED. Pure: the caller supplies the
 * canonical set (from each dispatch's context.json gate_agents) and the records. */
export function mismatchedGateRecords(
  canonicalGateNames: Set<string>,
  records: Array<{ name: string; profile?: string; spawnedVia?: string }>,
): string[] {
  return records
    .filter((r) => (r.profile === undefined || r.profile === "gate")
      && r.spawnedVia !== "attended_spawn"
      && /^ga-(?:guardian|observer)-\S+/.test(r.name)
      && !canonicalGateNames.has(r.name))
    .map((r) => r.name);
}

// --- CLI -------------------------------------------------------------------

export function parseArgs(argv: string[]): SpawnOptions {
  const out: SpawnOptions = { role: "" };
  const fenceRoots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`attended_spawn: ${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--role": out.role = next(); break;
      case "--slug": out.slug = next(); break;
      case "--project": out.project = next(); break;
      case "--pm-id": out.pmId = next(); break;
      case "--garelier-root": out.garelierRoot = next(); break;
      case "--dispatch-id": out.dispatchId = next(); break;
      case "--worktree": out.worktree = next(); break;
      case "--fence-root": fenceRoots.push(next()); break;
      case "--model": out.model = next(); break;
      default: throw new Error(`attended_spawn: unknown argument '${arg}'`);
    }
  }
  if (fenceRoots.length) out.fenceRoots = fenceRoots;
  return out;
}

export function runCli(argv: string[], cwd = process.cwd()): { code: number; message: string } {
  let opts: SpawnOptions;
  try { opts = parseArgs(argv); } catch (err) { return { code: 2, message: String(err) }; }
  if (!opts.role) return { code: 2, message: "attended_spawn: --role is required (guardian|observer|worker|scout)" };
  try {
    const plan = runAttendedSpawn(opts, cwd);
    return { code: 0, message: JSON.stringify(plan, null, 2) };
  } catch (err) { return { code: 1, message: String(err) }; }
}

if (import.meta.main) {
  const { code, message } = runCli(process.argv.slice(2));
  (code === 0 ? process.stdout : process.stderr).write(message + "\n");
  process.exit(code);
}
