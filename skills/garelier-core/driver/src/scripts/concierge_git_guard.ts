#!/usr/bin/env bun
// Garelier Concierge git guard (DEC-030) — TS port of concierge_git_guard.ts
// (W-083). The sanctioned path for any git operation the Concierge runs that
// could touch a remote. It MECHANICALLY refuses the operations the Concierge
// SKILL forbids, instead of relying on the prompt. The pre-push hook
// (hooks/pre-push) is the unconditional backstop for pushes.
//
// Modes:
//   concierge_git_guard <git-subcommand> [args...]
//       Run a git command with the universal bans enforced:
//         - `pull`                        => REFUSED (use fetch + a named merge)
//         - `push --force|-f|--force-with-lease`  => REFUSED (no history rewrite)
//         - push of a garelier/* ref     => REFUSED (local-only branches)
//       Read-only commands (fetch/status/log/diff/ls-remote/...) pass through.
//
//   concierge_git_guard preflight-target-push \
//       --remote <remote> --ref <target-branch> \
//       --expected-sha <sha> --verdict <guardian_report.md> --head <sha>
//       Verify BEFORE a promote/push to <target>:
//         - the live remote tip equals <expected-sha>  (no drift / no clobber)
//         - <verdict> is a PASS / PASS_WITH_NOTES whose review_sha == <head>
//
// Exit codes: 0 ok; 2 refused/blocked; 3 verification failed; 4 usage.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { requireRuntimeExecutable } from "./_lib.ts";

function dieRefuse(msg: string): never {
  console.error(`concierge_git_guard: REFUSED — ${msg}`);
  process.exit(2);
}
function dieVerify(msg: string): never {
  console.error(`concierge_git_guard: VERIFY FAILED — ${msg}`);
  process.exit(3);
}
function dieUsage(msg: string): never {
  console.error(`concierge_git_guard: usage error — ${msg}`);
  process.exit(4);
}

const argv = process.argv.slice(2);
if (argv.length < 1) dieUsage("no command");

const mode = argv[0];

// Split lines the way grep processes a file (per line, CR tolerated).
function fileLines(path: string): string[] {
  return readFileSync(path, "utf8").split(/\r?\n/);
}

if (mode === "preflight-target-push") {
  const rest = argv.slice(1);
  let remote = "", ref = "", expected = "", verdict = "", head = "";
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case "--remote": remote = rest[++i] ?? ""; break;
      case "--ref": ref = rest[++i] ?? ""; break;
      case "--expected-sha": expected = rest[++i] ?? ""; break;
      case "--verdict": verdict = rest[++i] ?? ""; break;
      case "--head": head = rest[++i] ?? ""; break;
      default: dieUsage(`unknown preflight arg '${rest[i]}'`);
    }
  }
  if (!remote || !ref || !expected || !verdict || !head) {
    dieUsage("preflight-target-push needs --remote --ref --expected-sha --verdict --head");
  }

  // case "$ref" in garelier/*|*/garelier/*)
  if (/^garelier\//.test(ref) || /\/garelier\//.test(ref)) {
    dieRefuse(`target ref '${ref}' is a local-only garelier/* branch`);
  }

  // Drift guard: the live remote tip must equal the expected sha the PM approved.
  const lr = spawnSync(requireRuntimeExecutable("git"), ["ls-remote", remote, `refs/heads/${ref}`], { windowsHide: true, encoding: "utf8" });
  const live = (lr.status === 0 ? lr.stdout : "").split(/\r?\n/)[0]?.trim().split(/\s+/)[0] ?? "";
  if (live === "") {
    console.error(`concierge_git_guard: remote '${remote}' has no refs/heads/${ref} yet (new branch); skipping drift check.`);
  } else if (live !== expected) {
    dieVerify(`remote ${ref} tip ${live} != expected ${expected} (drift — refuse to clobber)`);
  }

  // Gate guard: a PASS/PASS_WITH_NOTES verdict bound to exactly this head.
  if (!existsSync(verdict)) dieVerify(`guardian verdict file not found: ${verdict}`);
  const lines = fileLines(verdict);
  const verdictOk = lines.some((l) =>
    /^[ \t]*verdict[ \t]*:?[ \t]*(PASS|PASS_WITH_NOTES)\b/i.test(l));
  if (!verdictOk) dieVerify(`guardian verdict in ${verdict} is not PASS / PASS_WITH_NOTES`);

  // Capture only the leading hex run after review_sha: a quoted or commented
  // value yields no match.
  const shaLine = lines.find((l) => /^[ \t]*review_sha[ \t]*/i.test(l));
  const m = shaLine?.match(/^[ \t]*review_sha[ \t]*:?[ \t]*([0-9a-fA-F]+)/i);
  const vsha = m?.[1] ?? "";
  if (vsha === "") dieVerify(`guardian verdict in ${verdict} has no review_sha (cannot bind the gate to the push)`);
  if (vsha !== head) dieVerify(`guardian review_sha ${vsha} != head ${head} (stale verdict — re-gate before pushing)`);

  console.log(`concierge_git_guard: preflight OK — remote ${ref} at ${expected}, PASS verdict bound to ${head}.`);
  process.exit(0);
}

// ---- git passthrough mode with universal bans ----
const sub = mode;
const gitArgs = argv; // "$@" — the full arg vector, mirrored to `exec git "$@"`.

if (sub === "pull") {
  dieRefuse("'git pull' is forbidden for the Concierge — use 'fetch' + an explicit, assignment-named merge");
}

if (sub === "push") {
  for (const a of gitArgs) {
    if (a === "-f" || a === "--force" || a === "--force-with-lease" || a.startsWith("--force-with-lease=")) {
      dieRefuse(`force push ('${a}') is forbidden (no history rewrite)`);
    }
    if (a.includes("garelier/")) {
      dieRefuse(`pushing a garelier/* ref ('${a}') is forbidden (local-only branches)`);
    }
  }
}

// Everything else (fetch / status / log / diff / ls-remote / a vetted push) runs.
const r = spawnSync(requireRuntimeExecutable("git"), gitArgs, { windowsHide: true, stdio: "inherit" });
if (r.signal) process.exit(1);
process.exit(r.status ?? 0);
