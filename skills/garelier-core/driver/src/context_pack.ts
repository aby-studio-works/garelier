// Dispatch fact-pack builder (DEC-081 Piece 1) — forward-supply at dispatch.
//
// dispatch_prepare scaffolds a producer's cold worktree, then calls this to write
// `context.json` into the container. It FORWARD-SUPPLIES the project facts every
// producer otherwise re-derives in its cold worktree (the survey behind DEC-081
// found this is the biggest waste): the quality-gate command(s), target /
// target_slug, the studio (integration) and target branch names, the base sha,
// and — when a blueprint is named — the blueprint's Context-pack anchors
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
//       [--blueprint <path>] [--out <path>]
//   Writes the pack JSON to --out (default: stdout). Exit 0 on a produced pack,
//   2 on a usage error.

import { parse } from "smol-toml";

export interface QualityGate {
  stack: string | null;
  full: string[];
  fast: string[];
  run_verify: string[];
  timeout_minutes_per_cmd: number | null;
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
    run_verify: strArr(qg.run_verify_commands),
    timeout_minutes_per_cmd: typeof qg.timeout_minutes_per_cmd === "number" ? qg.timeout_minutes_per_cmd : null,
  };
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

export interface BuildInputs {
  pmId: string;
  projectRoot: string;
  integration?: string | null;
  config?: Record<string, unknown> | null;
  blueprintMd?: string | null;
  blueprintPath?: string | null;
  task?: Partial<FactPack["task"]>;
}

export function buildFactPack(inp: BuildInputs): FactPack {
  const cfg = inp.config ?? {};
  const branches = (cfg.branches && typeof cfg.branches === "object" ? cfg.branches : {}) as Record<string, unknown>;
  const target = typeof branches.target === "string" ? branches.target : null;
  const target_slug = deriveTargetSlug(target, typeof branches.target_slug === "string" ? branches.target_slug : null);
  const integration =
    inp.integration ?? (typeof branches.integration === "string" ? branches.integration : null);

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
    },
    project: {
      pm_id: inp.pmId,
      project_root: inp.projectRoot,
      target,
      target_slug,
      integration_branch: integration,
      target_branch: target,
    },
    quality_gate: parseQualityGate(cfg.quality_gate),
    anchors: inp.blueprintMd
      ? parseAnchors(inp.blueprintMd, inp.blueprintPath ?? null)
      : { entry_points: null, invariants: null, local_verify: null, source: inp.blueprintPath ?? null, filled: false },
    note: "forward-supplied facts (DEC-081); advisory — open the raw assignment / blueprint / AGENTS.md on demand. Re-derivation is never required.",
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
  if (!pmId || !projectRoot) fail("usage: context_pack.ts --config <toml> --pm-id <id> --project <abs> --integration <branch> [--task-id N --role R --slug S --branch B --base-sha SHA] [--blueprint <path>] [--out <path>]");

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
    },
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
