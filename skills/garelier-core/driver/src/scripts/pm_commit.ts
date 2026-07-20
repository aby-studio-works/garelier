import { basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { die, printHelp, requireRuntimeExecutable, valueAfter } from "./_lib.ts";

const HELP = `#
# pm_commit.ts — a thin \`git commit\` wrapper that refuses to commit while a merge
# gate is running (W-023). It mechanizes pm_field_manual §9: "studio commit は merge
# gate idle 時のみ." A commit made while the gate holds its staged merge is absorbed
# by git into a 2-parent merge commit and the gate aborts (W-055) — a race the PM
# otherwise had to avoid by hand ("gate 中は studio commit を保留").
#
# This is an EXPLICIT wrapper the PM calls in place of \`git commit\`. It is NOT a git
# hook: a repo-wide pre-commit hook would misfire on every producer worktree commit
# (the W-158 problem), so the guard is opt-in per invocation, not ambient.
#
# Usage:
#   pm_commit.ts --project <root> --pm-id <id> [--wait]
#                [--max-wait <seconds>] [--poll-interval <seconds>]
#                [--] <git commit args…>
#
#   --project / --pm-id  locate the merge-gate state
#                        (__garelier/<pm_id>/runtime/merge_gate/). Required.
#   --wait               instead of refusing, BLOCK-poll until the gate goes idle,
#                        then commit. Bounded by --max-wait (default 1800s); a
#                        timeout exits 124 without committing.
#   --poll-interval      seconds between idle checks under --wait (default 15).
#   --                   end pm_commit's own flags; everything after is git commit's.
#                        (Also implicit: the first token pm_commit does not recognize
#                        starts the git commit args, so \`-m\`, \`-a\`, paths, … pass
#                        through without needing \`--\`.)
#
# "Gate busy" = an active.lock is present (a gate is mid-merge) OR a submitted
# request has no result yet (a gate is queued and about to stage a merge). Either
# way a commit now risks the W-055 absorption, so both count as not-idle. When idle,
# pm_commit runs \`git commit\` in the CURRENT directory (the PM's studio worktree)
# and forwards every remaining arg verbatim, so it is transparent apart from the
# guard.
#
# Exit codes:
#   0    committed (git commit's own exit forwarded on success/its failure)
#   2    usage error (missing --project/--pm-id)
#   3    gate busy, default (no --wait) — nothing committed
#   124  --wait timed out before the gate went idle — nothing committed
set -uo pipefail

PROJECT="" PM="" WAIT=0 MAX_WAIT=1800 POLL_INTERVAL=15
GIT_ARGS=()`;

function gateBusy(gateDir: string, noisy: boolean): boolean {
  const active = `${gateDir}/locks/active.lock`;
  if (existsSync(active)) {
    if (noisy) process.stderr.write(`pm_commit: merge gate is ACTIVE (mid-merge) — ${active} present.\n`);
    return true;
  }
  const requests = `${gateDir}/requests`;
  const results = `${gateDir}/results`;
  if (existsSync(requests)) {
    for (const name of readdirSync(requests).filter((x) => x.endsWith(".json")).sort()) {
      const id = basename(name, ".json");
      if (!existsSync(`${results}/${id}.json`)) {
        if (noisy) process.stderr.write(`pm_commit: a merge gate request is QUEUED with no result yet (${id}) — a merge is imminent.\n`);
        return true;
      }
    }
  }
  return false;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let project = "";
  let pm = "";
  let wait = false;
  let maxWait = 1800;
  let pollInterval = 15;
  let gitArgs: string[] = [];
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": project = valueAfter(argv, i); i += 2; break;
      case "--pm-id": pm = valueAfter(argv, i); i += 2; break;
      case "--wait": wait = true; i++; break;
      case "--max-wait": maxWait = Number(valueAfter(argv, i)); i += 2; break;
      case "--poll-interval": pollInterval = Number(valueAfter(argv, i)); i += 2; break;
      case "-h": case "--help": printHelp(HELP);
      case "--": gitArgs = argv.slice(i + 1); i = argv.length; break;
      default: gitArgs = argv.slice(i); i = argv.length; break;
    }
  }
  if (!project || !pm) {
    process.stderr.write("pm_commit: --project and --pm-id are required\n");
    process.stderr.write(`${HELP}\n`);
    return 2;
  }

  const gateDir = `${project}/__garelier/${pm}/runtime/merge_gate`;
  if (gateBusy(gateDir, true)) {
    if (!wait) {
      process.stderr.write("pm_commit: REFUSING to commit while the merge gate is running — a commit now would be absorbed into the gate's staged merge and abort it (W-055). Wait for the gate to finish, or re-run with --wait to block until it is idle.\n");
      return 3;
    }
    process.stderr.write(`pm_commit: --wait: polling until the merge gate is idle (max ${maxWait}s, every ${pollInterval}s)…\n`);
    let waited = 0;
    while (gateBusy(gateDir, false)) {
      if (waited >= maxWait) {
        process.stderr.write(`pm_commit: --wait timed out after ${maxWait}s; the merge gate is still running. Nothing committed.\n`);
        return 124;
      }
      await Bun.sleep(pollInterval * 1000);
      waited += pollInterval;
    }
    process.stderr.write(`pm_commit: merge gate is now idle after ${waited}s — committing.\n`);
  }

  const child = Bun.spawn([requireRuntimeExecutable("git"), "commit", ...gitArgs], { windowsHide: true,
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

if (import.meta.main) process.exit(await main());
