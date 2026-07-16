import { existsSync, readFileSync } from "node:fs";
import { die, printHelp, readTomlScalar, valueAfter } from "./_lib.ts";

const HELP = `#
# gate_result_waiter.sh — attended push notification for a merge-gate result (W-079).
#
# The merge gate runs async: merge_request.sh enqueues a request and the gate
# subprocess later writes runtime/merge_gate/results/<request_id>.json (status
# success | failed | conflict | aborted). In DRIVER mode the driver's poll loop
# picks that result up and drives Dock; in ATTENDED mode (no driver, PM turns
# SendMessage/Agent by hand — pm_playbook.md) NOTHING watches results/, so a gate
# that finishes (or fails on a conflict) sits unnoticed until the PM happens to
# look. Real incident 2026-07-05: a conflict-failed gate sat 1h+ before the user
# flagged it.
#
# This is the lightweight, opt-in event bridge (same shape as the driver watchdog
# but for one request): run it in the background right after merge_request.sh and
# it cheaply polls for THIS request's terminal result, then echoes a one-line
# \`MERGE_RESULT:\` and exits with a status-derived code. Because the Claude Code
# harness re-wakes the main session when a \`run_in_background\` task completes, the
# PM is pushed the outcome instead of having to poll.
#
# It ONLY watches its own request_id's result file. It never polls the gate, never
# takes the active lock, and never advances the queue — the merge gate self-drains
# its own queue on completion (W-039), so a waiter must not (and does not) touch
# that machinery. Safe to run zero, one, or many in parallel (one per request).
#
# Usage:
#   gate_result_waiter.sh --project <control-root> --pm-id <id> --request-id <id>
#                         [--max-wait <seconds>] [--poll-interval <seconds>]
#
#   --request-id     the REQ_ID merge_request.sh printed (its request file stem).
#   --max-wait       seconds to wait before giving up. Default: the gate's own
#                    wall-clock ceiling + a margin, so the waiter outlives a
#                    healthy long gate and only times out when the gate itself has
#                    gone rogue. Resolution order: this flag → [merge_gate]
#                    gate_ceiling_minutes in setup_config × 60 + margin → a
#                    built-in worst-case default.
#   --poll-interval  seconds between existence checks (lean I/O). Default 30.
#
# Output (stdout, one line):
#   terminal → MERGE_RESULT: <status> <request_id> <studio_commit|failure_reason>`;

const DEFAULT_CEILING_MINUTES = 240;
const CEILING_MARGIN_SECONDS = 900;
const DEFAULT_POLL_INTERVAL = 30;

function positiveInteger(value: string | number): boolean {
  return /^\d+$/.test(String(value)) && Number(value) > 0;
}

function rawJsonStringField(path: string, key: string): string {
  const re = new RegExp(`^\\s*"${key}"\\s*:\\s*"(.*)".*$`);
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(re);
      if (match) return match[1];
    }
  } catch { /* a vanished/torn file is retried like the shell pipeline */ }
  return "";
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let project = "";
  let pm = "";
  let requestId = "";
  let maxWait = "";
  let pollInterval = "";
  for (let i = 0; i < argv.length;) {
    switch (argv[i]) {
      case "--project": project = valueAfter(argv, i); i += 2; break;
      case "--pm-id": pm = valueAfter(argv, i); i += 2; break;
      case "--request-id": requestId = valueAfter(argv, i); i += 2; break;
      case "--max-wait": maxWait = valueAfter(argv, i); i += 2; break;
      case "--poll-interval": pollInterval = valueAfter(argv, i); i += 2; break;
      case "-h": case "--help": printHelp(HELP);
      default:
        die(`gate_result_waiter: unknown arg: ${argv[i]}\ngate_result_waiter: valid flags: --project --pm-id --request-id --max-wait --poll-interval -h/--help`);
    }
  }
  if (!project || !pm || !requestId) {
    die("gate_result_waiter: --project, --pm-id, --request-id are required");
  }

  const resultFile = `${project}/__garelier/${pm}/runtime/merge_gate/results/${requestId}.json`;
  const config = `${project}/__garelier/${pm}/_pm/setup_config.toml`;
  if (!maxWait) {
    let ceiling = readTomlScalar(config, "merge_gate", "gate_ceiling_minutes");
    if (!positiveInteger(ceiling)) ceiling = String(DEFAULT_CEILING_MINUTES);
    maxWait = String(Number(ceiling) * 60 + CEILING_MARGIN_SECONDS);
  }
  if (!pollInterval) pollInterval = String(DEFAULT_POLL_INTERVAL);
  if (!positiveInteger(maxWait)) die("gate_result_waiter: --max-wait must be a positive integer (seconds)");
  if (!positiveInteger(pollInterval)) die("gate_result_waiter: --poll-interval must be a positive integer (seconds)");

  const ceiling = Number(maxWait);
  const poll = Number(pollInterval);
  let elapsed = 0;
  for (;;) {
    if (existsSync(resultFile)) {
      const status = rawJsonStringField(resultFile, "status");
      if (status) {
        if (status === "success") {
          const detail = rawJsonStringField(resultFile, "studio_commit") || "(no studio_commit)";
          process.stdout.write(`MERGE_RESULT: success ${requestId} ${detail}\n`);
          return 0;
        }
        const detail = rawJsonStringField(resultFile, "failure_reason") || "(no failure_reason)";
        process.stdout.write(`MERGE_RESULT: ${status} ${requestId} ${detail}\n`);
        return 1;
      }
    }
    if (elapsed >= ceiling) break;
    const step = Math.min(poll, ceiling - elapsed);
    await Bun.sleep(step * 1000);
    elapsed += step;
  }
  process.stdout.write(`MERGE_TIMEOUT: ${requestId} waited ${ceiling}s (no terminal result; check runtime/merge_gate/locks/active.lock and results/${requestId}.json)\n`);
  return 124;
}

if (import.meta.main) process.exit(await main());
