#!/usr/bin/env bun
// TS-first port of driver/src/scripts/jig_render.ts (DEC-062/DEC-090). Behaviour frozen:
// flags / stdout JSON line / stderr / exit codes / rendered workflow-file bytes
// match the shell 1:1. The --help block reproduces the shell's `sed -n '2,19p'`
// header verbatim.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePmSetupConfig } from "../workspace.ts";

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s + "\n");

// Verbatim reproduction of jig_render.ts lines 2-19 (the old `-h` output).
const HELP = `#
# jig_render.ts — render the jig tick template for a ONE-OFF manual
# dispatch (DEC-062). The autonomous loop renders the tick automatically; this
# helper gives the same one-command convenience for a manual single dispatch:
# it reads [jig] from the project's setup_config (documented defaults when the
# block is absent), substitutes the template's {{placeholders}}, writes a runnable
# workflow script, and prints {scriptPath, jig, args_schema} as one JSON line so
# the PM passes current provider/host telemetry plus per-item resource_class.
# An items-only call is compatibility-only: one non-heavy diagnostic may run.
#
# Usage:
#   jig_render.ts --project <root> --pm-id <id>
#                 [--template <jig_tick.workflow.js>] [--out <path>]
#                 [--gate-held]   # render jig_gate_held instead of the tick (DEC-090)
#                 [--max-rework N] [--smith-every N]
#                 [--depth-low gate] [--depth-normal gate+refute]
#
# --gate-held selects templates/jig_gate_held.workflow.js — the role-safe re-gate
# path for a HELD branch (a role that returned BLOCKED on a since-repaired
`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Port of the shell toml_get(): read a key from a TOML section, tolerating CRLF,
// inline # comments and surrounding quotes; return the default when absent.
function tomlGet(config: string, section: string, key: string, dflt: string): string {
  const sec = `[${section}]`;
  const keyRe = new RegExp(`^[ \\t]*${escapeRe(key)}[ \\t]*=`);
  let ins = false;
  for (const raw of config.split(/\n/)) {
    const line = raw.replace(/\r$/, "");
    if (line === sec) { ins = true; continue; }
    if (/^\[/.test(line)) ins = false;
    if (ins && keyRe.test(line)) {
      let v = line.replace(/^[^=]*=[ \t]*/, "");
      v = v.replace(/[ \t]*#.*$/, "");
      v = v.replace(/^"|"$/g, "");
      v = v.replace(/[ \t]+$/, "");
      return v;
    }
  }
  return dflt;
}

function main(): void {
  const argv = process.argv.slice(2);
  const selfDir = dirname(fileURLToPath(import.meta.url));
  // garelier-core is three levels up from driver/src/scripts/. Normalize to a
  // mixed Windows path (C:/...) so the rendered CORE matches the C:/-form PROJECT.
  const coreDir = resolve(selfDir, "../../..").replace(/\\/g, "/");

  let project = "", pm = "", template = "", outPath = "";
  let gateHeld = false;
  let oRework = "", oSmith = "", oLow = "", oNormal = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--project": project = req(argv, ++i); break;
      case "--pm-id": pm = req(argv, ++i); break;
      case "--template": template = req(argv, ++i); break;
      case "--out": outPath = req(argv, ++i); break;
      case "--gate-held": gateHeld = true; break;
      case "--max-rework": oRework = req(argv, ++i); break;
      case "--smith-every": oSmith = req(argv, ++i); break;
      case "--depth-low": oLow = req(argv, ++i); break;
      case "--depth-normal": oNormal = req(argv, ++i); break;
      case "-h": case "--help": out(HELP); process.exit(0); break;
      default: err(`jig_render: unknown arg: ${a}`); process.exit(2);
    }
  }

  if (!project || !pm) { err("jig_render: --project and --pm-id are required"); process.exit(2); }

  const configResolution = resolvePmSetupConfig(project, pm);
  const config = configResolution.path;
  if (!config) {
    err(`jig_render: no setup_config at ${configResolution.canonical}`);
    process.exit(2);
  }

  if (!template) {
    template = gateHeld
      ? `${coreDir}/templates/jig_gate_held.workflow.js`
      : `${coreDir}/templates/jig_tick.workflow.js`;
  }
  if (!isFile(template)) { err(`jig_render: template not found: ${template}`); process.exit(2); }

  if (!outPath) {
    outPath = gateHeld
      ? `${project}/__garelier/${pm}/runtime/jig/gate_held.workflow.js`
      : `${project}/__garelier/${pm}/runtime/jig/tick.workflow.js`;
  }

  const cfg = readFileSync(config, "utf8");
  const rework = oRework || tomlGet(cfg, "jig", "max_rework_rounds", "2");
  const smith = oSmith || tomlGet(cfg, "jig", "smith_batch_every", "5");
  const low = oLow || tomlGet(cfg, "jig.review_depth", "low", "gate");
  const normal = oNormal || tomlGet(cfg, "jig.review_depth", "normal", "gate+refute");

  // The template uses rework/smith_every UNQUOTED as JS numbers.
  for (const [name, val] of [["max_rework_rounds", rework], ["smith_batch_every", smith]] as const) {
    if (val === "" || /[^0-9]/.test(val)) {
      err(`jig_render: ${name} must be a non-negative integer (got '${val}')`);
      process.exit(2);
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  let rendered = readFileSync(template, "utf8");
  const subs: Array<[string, string]> = [
    ["{{project_root}}", project],
    ["{{pm_id}}", pm],
    ["{{garelier_core_dir}}", coreDir],
    ["{{jig_max_rework_rounds}}", rework],
    ["{{jig_smith_batch_every}}", smith],
    ["{{jig_depth_low}}", low],
    ["{{jig_depth_normal}}", normal],
  ];
  for (const [token, value] of subs) rendered = rendered.replaceAll(token, () => value);
  writeFileSync(outPath, rendered, "utf8");

  // Only knob placeholders must be gone; the template legitimately keeps literal
  // "{{" tokens in its DEC-071 placeholder-DETECTION code.
  if (/\{\{(jig_|project_root|pm_id|garelier_core_dir)/.test(readFileSync(outPath, "utf8"))) {
    err(`jig_render: an unsubstituted knob placeholder remains in ${outPath}`);
    process.exit(1);
  }

  if (gateHeld) {
    out(`{"scriptPath":"${outPath}","template":"gate_held","args_schema":"{ items: [ { slug: kebab-slug, branch: <held branch>, assignmentPath: <abs path>, reportPath: <abs path> } ], note?: reviewer-context }"}\n`);
  } else {
    out(`{"scriptPath":"${outPath}","jig":{"admission":"adaptive","telemetry_unavailable":"bounded-diagnostic-one-non-heavy","max_rework_rounds":${rework},"smith_batch_every":${smith},"depth_low":"${low}","depth_normal":"${normal}"},"args_schema":"{ admission: { provider_available_slots, host: { cpu_available_slots, memory_available_slots, io_available_slots } }, items: [ { role: worker|smith|librarian|artisan, slug: kebab-slug, assignmentPath: <abs path>, criticality: low|normal|critical, resource_class: light|normal|heavy } ] }"}\n`);
  }
}

function req(argv: string[], i: number): string {
  if (i >= argv.length) { err("jig_render: missing value for flag"); process.exit(2); }
  return argv[i];
}
function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }

main();
