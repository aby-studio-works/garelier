import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// W-063: merge-gate.sh's `run_gate_command` bounds every gate/preflight/
// run-verify command with SIGKILL escalation so a command that ignores SIGTERM
// (e.g. a wedged rustc) can never hang the gate — and therefore the whole merge
// queue — forever. These tests exercise the REAL helper, extracted from the
// script at test time, so a rename/behaviour change fails loudly here.

const MERGE_GATE = join(import.meta.dir, "..", "..", "scripts", "merge-gate.sh").replace(/\\/g, "/");
const T = 30_000;

// Load the helper (GATE_KILL_GRACE_SECS constant + setsid probe + the
// run_gate_command function, up to its closing brace) from the script, shorten
// the kill grace for a fast test, then run `caseScript` which must end by
// printing `RESULT ec=<n> elapsed=<s>`.
function runHelper(caseScript: string): { ec: number; elapsed: number; raw: string } {
  const bash = `
set -uo pipefail
eval "$(sed -n '/^GATE_KILL_GRACE_SECS=/,/^}/p' '${MERGE_GATE}')"
GATE_KILL_GRACE_SECS=2
out="$(mktemp)"; err="$(mktemp)"
${caseScript}
`;
  const r = spawnSync("bash", ["-c", bash], { encoding: "utf8", env: process.env });
  const raw = (r.stdout ?? "") + (r.stderr ?? "");
  const m = raw.match(/RESULT ec=(-?\d+) elapsed=(\d+)/);
  return { ec: m ? Number(m[1]) : NaN, elapsed: m ? Number(m[2]) : NaN, raw };
}

describe("run_gate_command (merge-gate.sh, W-063)", () => {
  test("escalates to SIGKILL a TERM-ignoring command that outlives its limit", () => {
    const { ec, elapsed, raw } = runHelper(`
start=$(date +%s)
run_gate_command 'trap "" TERM; sleep 30' "$out" "$err" 2
ec=$?
echo "RESULT ec=$ec elapsed=$(( $(date +%s) - start ))"
`);
    // limit 2s, grace 2s → SIGKILL at ~4s. 137 = 128 + SIGKILL(9).
    expect(ec).toBe(137);
    expect(elapsed).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(10);
    expect(raw).toBeTruthy();
  }, T);

  test("preserves the real exit code of a fast command (does NOT mask it — the setsid-fork hazard)", () => {
    const { ec } = runHelper(`
run_gate_command 'exit 7' "$out" "$err" 30
echo "RESULT ec=$? elapsed=0"
`);
    expect(ec).toBe(7);
  }, T);

  test("passes a fast success through with its stdout captured", () => {
    const { ec, raw } = runHelper(`
run_gate_command 'echo captured-stdout; exit 0' "$out" "$err" 30
echo "RESULT ec=$? elapsed=0"
echo "OUT=[$(cat "$out")]"
`);
    expect(ec).toBe(0);
    expect(raw).toContain("OUT=[captured-stdout]");
  }, T);

  test("fallback (no coreutils `timeout`) still bounds the wall clock and kills the child", () => {
    // Shadow `command` so `command -v timeout` reports it missing, forcing the
    // bash-native fallback watchdog path.
    const { ec, elapsed } = runHelper(`
command() { if [ "\$1" = -v ] && [ "\$2" = timeout ]; then return 1; fi; builtin command "\$@"; }
start=$(date +%s)
run_gate_command 'sleep 30' "$out" "$err" 2
ec=$?
unset -f command
echo "RESULT ec=$ec elapsed=$(( $(date +%s) - start ))"
`);
    expect(ec).not.toBe(0);      // the hang was killed, not completed
    expect(elapsed).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(10);
  }, T);

  test("fallback preserves the exit code of a fast command", () => {
    const { ec } = runHelper(`
command() { if [ "\$1" = -v ] && [ "\$2" = timeout ]; then return 1; fi; builtin command "\$@"; }
run_gate_command 'exit 5' "$out" "$err" 30
ec=$?
unset -f command
echo "RESULT ec=$ec elapsed=0"
`);
    expect(ec).toBe(5);
  }, T);
});
