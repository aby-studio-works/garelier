#!/usr/bin/env bun
// TS-first port of driver/src/scripts/worker_finalize.ts (W-069 / W-083). Behaviour frozen:
// flags / stdout / stderr / exit codes / commit message assembly / STATE + report
// edits match the shell 1:1. Mechanizes a Worker's gate -> commit -> REPORTING ->
// report -> register finish. Only ever commits the current worktree's Worker
// branch (refuses studio / detached HEAD).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable, resolveBashLaunch } from "./_lib.ts";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

// Lines 2-55 of the original worker_finalize.ts (what `sed -n '2,55p' "$0"` used
// to print for -h/--help). Kept verbatim so the shim's --help is byte-identical.
const HELP = `#
# worker_finalize.ts — mechanize a Worker's "implementation done" finish (W-069).
#
# The recurring live failure this fixes: a Worker runs its quality gate, sees it
# green, and then goes idle WITHOUT committing / flipping STATE to REPORTING /
# notifying Dock — the completion-contract gap. This one command turns the
# manual "gate -> commit -> REPORTING -> report -> register" sequence into a
# single deterministic step so the commit can no longer be forgotten:
#
#   (a) run the SCOPED quality gate (context.json quality_gate.fast, i.e. the
#       per-package check/test for what you touched; the FULL-workspace gate is
#       the merge gate's job — DEC-091). Green/red decision.
#   (b) green + a dirty tree -> \`git add -A\` (this worktree only) + commit using
#       the context.json commit_template's \`Garelier:\` trailer VERBATIM (drift 0,
#       W-051), with the Worker-supplied --subject as the subject line.
#   (c) flip STATE.md -> REPORTING.
#   (d) append a finalize register block to report.md (SHA / gate result / branch
#       / "PM review 待ち").
#   (e) print ONE compact register line to stdout the Worker copies into its Dock
#       message (Inter-agent compressed register, W-042).
#
#   red -> NO commit, print the failed gate command + its output tail, leave
#          STATE at WORKING (nothing changes but the log), exit non-zero.
#   already committed (clean tree) -> idempotent: no new commit, STATE flip only,
#          register refreshed. A second finalize call is a safe no-op.
#
# SAFETY: finalize only ever commits the CURRENT worktree's Worker branch. It
# refuses to run on an integration branch (\`*/studio\`) or a detached HEAD, so it
# can never land a commit on studio (no overlap with the W-055 studio guard).
#
# NON-DESTRUCTIVE: this is the RECOMMENDED path, not the only one. The manual
# gate/commit/report flow still works for special cases (see garelier-worker
# references/working-and-reporting.md §6–§7).
#
# Usage:
#   worker_finalize.ts [--container <dir>] [--checkout <dir>] [--context <path>]
#                      [--subject '<type>(<scope>): <summary>  [#<id>]']
#                      [--message '<full commit message>']
#                      [--gate fast|full] [--gate-cmd '<cmd>']... [-h|--help]
#
#   --container   Worker/dispatch container holding STATE.md, report.md,
#                 context.json (default: parent of the resolved checkout).
#   --checkout    the git worktree to commit in (default: <container>/checkout,
#                 else \`git rev-parse --show-toplevel\` from the cwd).
#   --context     context.json path (default: <container>/context.json).
#   --subject     the commit subject line you write (required to create a commit;
#                 the Garelier trailer is appended VERBATIM from context.json).
#   --message     full commit message override (verbatim; a missing Garelier
#                 trailer is appended from context.json).
#   --gate        which command set to run: fast=scoped (default), full=workspace.
#   --gate-cmd    explicit gate command (repeatable) — overrides context.json.
#
# Exit codes: 0 finalized (or idempotent no-op); 1 gate red (STATE stays WORKING);
# 2 usage/precondition error (nothing changed).`;

interface GitResult { code: number; stdout: string; }
function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync(requireRuntimeExecutable("git"), ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8" });
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").toString() };
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// awk STATE.md Status-flip: replace the first non-blank line after the `## Status`
// heading with a single new value; blank lines between are preserved.
function flipSection(content: string, headingRe: RegExp, replacement: string): string {
  const lines = content.split("\n");
  const outLines: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (headingRe.test(line)) { outLines.push(line); inSection = true; continue; }
    if (inSection && /^[\t ]*$/.test(line)) { outLines.push(line); continue; }
    if (inSection && line.trim().length > 0) { outLines.push(replacement); inSection = false; continue; }
    outLines.push(line);
  }
  return outLines.join("\n");
}

function main(): number {
  const argv = process.argv.slice(2);
  let container = "", checkout = "", context = "", subject = "", message = "", gateKind = "fast";
  const gateCmds: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--container") { container = need(argv, ++i); }
    else if (a === "--checkout") { checkout = need(argv, ++i); }
    else if (a === "--context") { context = need(argv, ++i); }
    else if (a === "--subject") { subject = need(argv, ++i); }
    else if (a === "--message") { message = need(argv, ++i); }
    else if (a === "--gate") { gateKind = need(argv, ++i); }
    else if (a === "--gate-cmd") { gateCmds.push(need(argv, ++i)); }
    else if (a === "-h" || a === "--help") { out(HELP); return 0; }
    else {
      err(`worker_finalize: unknown arg: ${a}`);
      err("worker_finalize: valid flags: --container --checkout --context --subject --message --gate --gate-cmd -h/--help");
      return 2;
    }
  }
  if (gateKind !== "fast" && gateKind !== "full") {
    err(`worker_finalize: --gate must be fast|full (got '${gateKind}')`);
    return 2;
  }

  // --- Resolve checkout / container / context -------------------------------
  if (!checkout) {
    if (container) {
      checkout = `${container}/checkout`;
    } else {
      checkout = git(process.cwd(), ["rev-parse", "--show-toplevel"]).stdout.trim();
      if (!checkout) { err("worker_finalize: not inside a git worktree and no --checkout/--container given"); return 2; }
    }
  }
  if (git(checkout, ["rev-parse", "--show-toplevel"]).code !== 0) {
    err(`worker_finalize: --checkout is not a git worktree: ${checkout}`);
    return 2;
  }
  if (!container) container = resolve(checkout, "..");
  if (!context) context = `${container}/context.json`;
  const stateMd = `${container}/STATE.md`;
  const reportMd = `${container}/report.md`;

  // --- Safety guard: never commit studio / a detached HEAD ------------------
  const curBranch = git(checkout, ["branch", "--show-current"]).stdout.trim();
  if (/\/studio$/.test(curBranch)) {
    err(`worker_finalize: refuse — checkout is on the integration branch '${curBranch}'. finalize only commits Worker branches (workbench/anvil/shelf/satchel). Switch to your Worker branch first.`);
    return 2;
  }
  if (curBranch === "") {
    err(`worker_finalize: refuse — detached HEAD in ${checkout}. Check out your Worker branch before finalizing.`);
    return 2;
  }

  // --- Read commit_template + gate commands from context.json ---------------
  let baseSha = "";
  let commitTemplate = "";
  let ctxCmdCount = 0;
  let ctxCmds: string[] = [];
  if (existsSync(context)) {
    let raw = "";
    try { raw = readFileSync(context, "utf8"); } catch { raw = ""; }
    const bs = raw.match(/"base_sha"[\t ]*:[\t ]*"([^"]*)"/);
    if (bs) baseSha = bs[1];
    let ctx: { quality_gate?: Record<string, unknown>; commit_template?: unknown } | null = null;
    try { ctx = JSON.parse(raw); } catch { ctx = null; }
    if (ctx === null) {
      ctxCmdCount = 0;
      err(`worker_finalize: could not parse ${context} (bun); relying on --gate-cmd / --message overrides`);
    } else {
      const qg = (ctx.quality_gate || {}) as Record<string, unknown>;
      let cmds = gateKind === "full" ? qg.full : qg.fast;
      if (!Array.isArray(cmds) || cmds.length === 0) cmds = (qg.full || qg.fast || qg.commands || []) as unknown;
      ctxCmds = (Array.isArray(cmds) ? cmds : []).map((c) => String(c)).filter((c) => c.trim().length > 0);
      ctxCmdCount = ctxCmds.length;
      commitTemplate = typeof ctx.commit_template === "string" ? ctx.commit_template : "";
    }
  }

  // Effective gate command set: explicit --gate-cmd wins, else context.
  if (gateCmds.length === 0 && ctxCmdCount > 0) {
    for (const c of ctxCmds) if (c) gateCmds.push(c);
  }
  if (gateCmds.length === 0) {
    err(`worker_finalize: no quality-gate commands (none in ${context} quality_gate.${gateKind}, no --gate-cmd).`);
    err("worker_finalize: an undefined quality gate is a MUST-BLOCK for a Worker (garelier-worker SKILL §13) — refusing to finalize. Pass --gate-cmd or fix the dispatch context.");
    return 2;
  }

  // --- Run the scoped gate --------------------------------------------------
  err(`worker_finalize: running the ${gateKind} (scoped) quality gate in ${checkout}`);
  err("worker_finalize: note — the FULL-workspace gate is the merge gate's job (DEC-091); this runs your scoped check/test only.");
  let gateI = 0;
  for (const cmd of gateCmds) {
    gateI++;
    err(`worker_finalize: gate[${gateI}/${gateCmds.length}]> ${cmd}`);
    const shell = resolveBashLaunch();
    if (!shell) {
      err("worker_finalize: GATE RED — Git Bash not found; NO commit made, STATE stays WORKING");
      return 1;
    }
    const r = spawnSync(shell.executable, ["-c", cmd], { windowsHide: true, cwd: checkout, env: shell.env, encoding: "utf8" });
    if ((r.status ?? 1) === 0) {
      err(`worker_finalize: gate[${gateI}] ok`);
    } else {
      const rc = r.status ?? 1;
      const log = (r.stdout ?? "").toString() + (r.stderr ?? "").toString();
      err("");
      err(`worker_finalize: GATE RED — command failed (exit ${rc}), NO commit made, STATE stays WORKING:`);
      err(`worker_finalize:   failed command: ${cmd}`);
      err("worker_finalize:   --- output tail (last 30 lines) ---");
      const tail = log.split("\n");
      // tail -n 30 drops a single trailing empty element from a final newline.
      if (tail.length && tail[tail.length - 1] === "") tail.pop();
      for (const l of tail.slice(-30)) err(`worker_finalize:   ${l}`);
      err(`worker_finalize:   --- end tail --- (full: rerun the command in ${checkout})`);
      return 1;
    }
  }
  err(`worker_finalize: gate GREEN (${gateCmds.length} command(s) passed)`);

  // --- Commit (only if the tree is dirty) -----------------------------------
  const now = utcNow();
  let dirty = git(checkout, ["status", "--porcelain"]).stdout.trim().length > 0;
  let commitState = "already-committed";

  if (dirty) {
    let finalMsg = "";
    if (message) {
      finalMsg = message;
      if (!/^Garelier: /m.test(message)) {
        const trailer = templateTrailer(commitTemplate);
        if (trailer) finalMsg = `${message}\n\n${trailer}`;
      }
    } else if (subject) {
      finalMsg = subject;
      if (commitTemplate.length > 0) {
        const rest = commitTemplate.split("\n").slice(1).join("\n");
        if (/^Garelier: /m.test(rest)) {
          finalMsg = `${subject}\n${rest}`;
        } else {
          err("worker_finalize: warning — context.json commit_template carried no 'Garelier:' trailer; committing subject only.");
        }
      } else {
        err("worker_finalize: warning — no commit_template in context.json; committing subject only (no Garelier trailer).");
      }
    } else {
      err("worker_finalize: the working tree has changes but no --subject/--message was given.");
      err("worker_finalize: pass --subject '<type>(<scope>): <summary>  [#<id>]' — finalize appends the Garelier trailer from context.json verbatim (W-051). Nothing committed; STATE unchanged.");
      return 2;
    }

    if (git(checkout, ["add", "-A"]).code !== 0) { err(`worker_finalize: git add -A failed in ${checkout}`); return 2; }
    if (git(checkout, ["diff", "--cached", "--name-only"]).stdout.trim().length === 0) {
      dirty = false;
    } else {
      // Shell did `git commit -m ... >&2`: the summary goes to stderr, keeping
      // stdout clean for the single register line.
      const c = spawnSync(requireRuntimeExecutable("git"), ["-C", checkout, "commit", "-m", finalMsg], { windowsHide: true, encoding: "utf8" });
      if (c.stdout) process.stderr.write(c.stdout.toString());
      if (c.stderr) process.stderr.write(c.stderr.toString());
      if ((c.status ?? 1) === 0) {
        commitState = "committed";
      } else {
        err("worker_finalize: git commit failed; STATE unchanged, nothing flipped.");
        return 2;
      }
    }
  }

  const sha = git(checkout, ["rev-parse", "--short", "HEAD"]).stdout.trim() || "unknown";

  // "nothing to finalize" guard.
  if (!dirty && commitState === "already-committed" && baseSha) {
    if (git(checkout, ["rev-parse", "--verify", "-q", baseSha]).code === 0) {
      const ahead = git(checkout, ["rev-list", "--count", `${baseSha}..HEAD`]).stdout.trim() || "0";
      if (Number(ahead) === 0) {
        err(`worker_finalize: nothing to finalize — clean tree and no commits past the dispatch base (${baseSha}) on '${curBranch}'. Implement + stage your change first.`);
        return 2;
      }
    }
  }

  // --- Flip STATE.md -> REPORTING -------------------------------------------
  if (existsSync(stateMd)) {
    let content = readFileSync(stateMd, "utf8");
    content = flipSection(content, /^##[\t ]+Status[\t ]*$/, "REPORTING");
    writeFileSync(stateMd, content);
    if (/^##[\t ]+Last activity[\t ]*$/m.test(content)) {
      try {
        const updated = flipSection(content, /^##[\t ]+Last activity[\t ]*$/, `${now} -- worker_finalize: gate green, ${commitState}, REPORTING`);
        writeFileSync(stateMd, updated);
      } catch { /* best effort */ }
    }
  } else {
    err(`worker_finalize: warning — no STATE.md at ${stateMd}; skipped STATE flip.`);
  }

  // --- Register block in report.md (idempotent) -----------------------------
  const registerHeader = "## Finalize register (worker_finalize.ts)";
  if (existsSync(reportMd)) {
    let content = readFileSync(reportMd, "utf8");
    content = dropRegisterBlock(content, registerHeader);
    let block = "";
    block += `\n${registerHeader}\n\n`;
    block += `- Commit: \`${sha}\` (${commitState})\n`;
    block += `- Gate: ${gateKind} scoped PASS (${gateCmds.length} command(s)); full-workspace gate = merge gate (DEC-091)\n`;
    block += `- Branch: \`${curBranch}\`\n`;
    block += `- State: REPORTING — PM review 待ち\n`;
    block += `- Finalized: ${now}\n`;
    writeFileSync(reportMd, content + block);
  } else {
    err(`worker_finalize: warning — no report.md at ${reportMd}; skipped register block.`);
  }

  // --- One-line register to stdout ------------------------------------------
  const segs = curBranch.split("/");
  const taskTail = segs.length >= 2 ? `${segs[segs.length - 2]} ${segs[segs.length - 1]}` : curBranch;
  out(`finalize: ${taskTail} | REPORTING | commit=${sha} (${commitState}) | gate=${gateKind} PASS(${gateCmds.length}) | branch=${curBranch} | PM review 待ち`);
  return 0;
}

// tail -n +2 | drop blank lines | first `Garelier: ` line.
function templateTrailer(template: string): string {
  const rest = template.split("\n").slice(1);
  for (const l of rest) {
    if (/^[\t ]*$/.test(l)) continue;
    if (/^Garelier: /.test(l)) return l;
  }
  return "";
}

// awk drop of a prior `## Finalize register ...` block up to the next `## ` head.
function dropRegisterBlock(content: string, header: string): string {
  const lines = content.split("\n");
  const outLines: string[] = [];
  let drop = false;
  for (const line of lines) {
    if (line === header) { drop = true; continue; }
    if (drop && /^##[\t ]/.test(line)) drop = false;
    if (!drop) outLines.push(line);
  }
  return outLines.join("\n");
}

function need(argv: string[], i: number): string {
  const v = argv[i];
  if (v === undefined || v === "") { err("worker_finalize: missing option value"); process.exit(2); }
  return v;
}

export { flipSection, templateTrailer, dropRegisterBlock };

if (import.meta.main) process.exit(main());
