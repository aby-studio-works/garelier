import { expect, test } from "bun:test";
import { runShellOracle } from "../driver/src/scripts/shell_oracle_test_runner.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main as dispatchCleanupMain } from "../driver/src/scripts/dispatch_cleanup.ts";
import { configurePathGuardRoots, removeTreeSync } from "../driver/src/guard/path_guard.ts";

// W-111: Bun registers this parity oracle. Its existing shell assertions remain
// verbatim while every Garelier CLI under test is invoked directly with Bun.
const shellScript = [
  "#!/usr/bin/env bash",
  "#",
  "# dispatch_cleanup.test.ts — pins the dispatch_cleanup.ts options this bundle adds:",
  "#",
  "#   1. W-019 --report-from-file — cleanup transcribes a register-derived text file",
  "#      into report.md BEFORE archiving, so the archived done/<id>-<slug>.md carries",
  "#      the real outcome (with the \"transcribed from the role register\" marker)",
  "#      instead of the untouched dispatch scaffold; the result JSON reports",
  "#      report_source. A missing source file is a non-fatal no-op.",
  "#   2. DEC-063 completion retention — archives assignment/report/report.json and",
  "#      removes the whole ephemeral container, including generated pickup/checkpoint",
  "#      files that otherwise leave stale `_crew/dispatch<N>/` directories.",
  "#   3. W-021 --record-touches — records the MEASURED base_sha..HEAD path set into",
  "#      context.json task.touches_actual (removing nothing), so a gate/Guardian reads",
  "#      the actual diff instead of the stale dispatch-time `touches` prediction.",
  "#",
  "# Self-contained: run directly (`bun test dispatch_cleanup.test.ts`) or from ci.ts.",
  "# Needs bun + git + a POSIX shell. Exits 0 only if every case holds.",
  "set -uo pipefail",
  "",
  "ORIG_CWD=\"$(pwd -P)\"",
  "SELF_DIR=\"$(cd \"$(dirname \"$0\")\" && pwd)\"",
  "CLEANUP=\"$SELF_DIR/../driver/src/scripts/dispatch_cleanup.ts\"",
  "[ -f \"$CLEANUP\" ] || { echo \"dispatch_cleanup.test: cannot find dispatch_cleanup.ts next to me\" >&2; exit 1; }",
  "",
  "fail() { echo \"  FAIL: $*\" >&2; exit 1; }",
  "",
  "# W-053: run this whole file from a throwaway scratch cwd, never from the",
  "# invoker's real cwd — same rationale as merge_land.test.ts's sibling guard",
  "# (target project 実戦 2026-07-12 literal `$DT/…` residue at a real project",
  "# root). Each fixture below already scopes itself under `mktemp -d`; this",
  "# protects the top-level process cwd against any latent path bug in $CLEANUP",
  "# that resolves against cwd instead of its --project/--target-root argument.",
  "RUN_CWD=\"$(mktemp -d)\"",
  "cd \"$RUN_CWD\"",
  "",
  "# W-053 (c): self-detecting backstop — fail loudly if a literal `$`-prefixed",
  "# dir (the leak's signature) appears in the ORIGINAL invoker cwd by the time",
  "# this script exits, so a recurrence is caught by the test itself, not by a",
  "# human noticing residue days later.",
  "assert_no_cwd_residue() {",
  "  local stray",
  "  stray=\"$(find \"$ORIG_CWD\" -maxdepth 1 -name '$*' 2>/dev/null)\"",
  "  if [ -n \"$stray\" ]; then",
  "    echo \"  FAIL: stray literal \\$VAR dir(s) leaked into invoker cwd $ORIG_CWD:\" >&2",
  "    printf '%s\\n' \"$stray\" >&2",
  "    return 1",
  "  fi",
  "  return 0",
  "}",
  "trap 'rc=$?; rm -rf \"$RUN_CWD\" 2>/dev/null || true; assert_no_cwd_residue || rc=1; exit $rc' EXIT",
  "",
  "# mk_fixture <slug> <id> -> sets TMP (posix) + DT (windows-usable path). A git repo",
  "# with studio + a workbench branch merged into studio (so cleanup's W-044 guard sees",
  "# merge_status=merged) + setup_config + a _crew/dispatch<id> worktree with a scaffold",
  "# report.md and a context.json carrying the base_sha.",
  "mk_fixture() {",
  "  local slug=\"$1\" id=\"$2\"",
  "  TMP=\"$(mktemp -d)\"; DT=\"$(cygpath -m \"$TMP\" 2>/dev/null || printf '%s' \"$TMP\")\"",
  "  (",
  "    cd \"$TMP\"",
  "    git init -q -b main; git config user.email ci@ci; git config user.name t",
  "    echo base > base.txt; git add -A; git commit -q -m init",
  "    BASE_SHA=\"$(git rev-parse --short HEAD)\"",
  "    git branch \"garelier/main/tpm/studio\" main",
  "    git worktree add -q -b \"garelier/main/tpm/workbench/#$id/$slug\" \"wb\" \"garelier/main/tpm/studio\"",
  "    ( cd wb && echo feat > \"$slug.txt\" && git add -A && git commit -q -m \"feat $slug\" )",
  "    git worktree remove wb",
  "    # Fast-forward the workbench into studio so the branch is a confirmed ancestor",
  "    # (merge_status=merged) — lets --delete-branch pass the W-044 guard.",
  "    git branch -f \"garelier/main/tpm/studio\" \"garelier/main/tpm/workbench/#$id/$slug\"",
  "    mkdir -p \"__garelier/tpm/_crew/pm\"",
  "    printf '[project]\\nname = \"test\"\\n\\n[branches]\\ntarget = \"main\"\\nintegration = \"garelier/main/tpm/studio\"\\n' \\",
  "      > \"__garelier/tpm/_crew/pm/setup_config.toml\"",
  "    git worktree add -q \"__garelier/tpm/_crew/dispatch$id/checkout\" \"garelier/main/tpm/workbench/#$id/$slug\"",
  "    local dc=\"__garelier/tpm/_crew/dispatch$id\"",
  "    # The untouched dispatch scaffold report.md (what W-019 replaces).",
  "    printf '# Assignment - #%s %s\\n\\nGoal: fixture\\n' \"$id\" \"$slug\" > \"$dc/assignment.md\"",
  "    printf '# Report - #%s %s\\n\\n## Status\\n\\n(REPORTING | BLOCKED)\\n' \"$id\" \"$slug\" > \"$dc/report.md\"",
  "    printf '{\"schema_version\":1,\"task_id\":\"#%s\",\"status\":\"done\"}\\n' \"$id\" > \"$dc/report.json\"",
  "    printf '{\"task\":{\"id\":%s,\"slug\":\"%s\",\"base_sha\":\"%s\"}}\\n' \"$id\" \"$slug\" \"$BASE_SHA\" > \"$dc/context.json\"",
  "    printf '{\"schema_version\":1,\"task\":{\"id\":%s}}\\n' \"$id\" > \"$dc/pickup_pack.json\"",
  "    printf '# Dispatch #%s\\n\\n## Status\\n\\nREPORTING\\n' \"$id\" > \"$dc/STATE.md\"",
  "    mkdir -p \"$dc/checkpoints\"",
  "    printf '# Checkpoint\\n' > \"$dc/checkpoints/0001-work.md\"",
  "  )",
  "}",
  "cleanup_fixture() { cd /; rm -rf \"$TMP\" 2>/dev/null || true; }",
  "",
  "# ── W-530: destructive cleanup refuses an omitted explicit checkout ─────────",
  "mk_fixture explicit-required 530",
  "set +e",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$DT\" --target-root \"$DT\" --pm-id tpm --id 530 --force-remove 2>&1)\"",
  "RC=$?",
  "set -e",
  "[ \"$RC\" -ne 0 ] || fail \"W-530 missing --checkout was accepted. out=$OUT\"",
  "echo \"$OUT\" | grep -q -- '--checkout <path> is required' || fail \"W-530 refusal did not name --checkout. out=$OUT\"",
  "[ -e \"$TMP/__garelier/tpm/_crew/dispatch530\" ] || fail \"W-530 refusal removed the selected container\"",
  "cleanup_fixture",
  "",
  "# ── 1. W-019 --report-from-file: transcribe register text into the archived report ─",
  "mk_fixture rf-ok 1",
  "REG=\"$TMP/register.txt\"",
  "printf '+++\\n[lane]\\nstate = \"REPORTING\"\\n+++\\n\\nbranch=...#1/rf-ok sha=deadbeef gate=GREEN ledger 0/0\\nresult: the real register outcome text\\n' > \"$REG\"",
  "set +e",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$DT\" --target-root \"$DT\" --pm-id tpm --id 1 \\",
  "  --checkout \"$TMP/__garelier/tpm/_crew/dispatch1/checkout\" \\",
  "  --report-from-file \"$REG\" 2>/dev/null)\"",
  "RC=$?",
  "set -e",
  "[ \"$RC\" -eq 0 ] || fail \"W-019 case exit was $RC (expected 0). out=$OUT\"",
  "echo \"$OUT\" | grep -q '\"report_source\":' || fail \"W-019 result lacks report_source key: $OUT\"",
  "echo \"$OUT\" | grep -q 'register.txt' || fail \"W-019 result report_source not the passed file: $OUT\"",
  "DONE=\"$TMP/__garelier/tpm/runtime/backlog/done/1-rf-ok.md\"",
  "[ -f \"$DONE\" ] || fail \"W-019 archived report not found at $DONE\"",
  "grep -q 'transcribed from the role register' \"$DONE\" || fail \"W-019 archive missing the transcription marker: $(cat \"$DONE\")\"",
  "grep -q 'the real register outcome text' \"$DONE\" || fail \"W-019 archive missing the register body: $(cat \"$DONE\")\"",
  "grep -q '(REPORTING | BLOCKED)' \"$DONE\" && fail \"W-019 archive still holds the scaffold placeholder (transcription did not replace it)\"",
  "grep -q 'Goal: fixture' \"$DONE\" || fail \"DEC-063 archive missing assignment body: $(cat \"$DONE\")\"",
  "SIDECAR=\"$TMP/__garelier/tpm/runtime/backlog/done/1-rf-ok.json\"",
  "[ -f \"$SIDECAR\" ] || fail \"DEC-063 archived report sidecar not found at $SIDECAR\"",
  "[ ! -e \"$TMP/__garelier/tpm/_crew/dispatch1\" ] || fail \"DEC-063 cleanup left stale dispatch container\"",
  "cleanup_fixture",
  "",
  "# ── 2. W-019 missing source file is a non-fatal no-op ─────────────────────────",
  "mk_fixture rf-missing 2",
  "set +e",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$DT\" --target-root \"$DT\" --pm-id tpm --id 2 \\",
  "  --checkout \"$TMP/__garelier/tpm/_crew/dispatch2/checkout\" \\",
  "  --report-from-file \"$TMP/does-not-exist.txt\" 2>/dev/null)\"",
  "RC=$?",
  "set -e",
  "[ \"$RC\" -eq 0 ] || fail \"W-019 missing-source exit was $RC (expected 0). out=$OUT\"",
  "echo \"$OUT\" | grep -q '\"report_source\":\"none\"' || fail \"W-019 missing-source should report report_source=none: $OUT\"",
  "DONE=\"$TMP/__garelier/tpm/runtime/backlog/done/2-rf-missing.md\"",
  "[ -f \"$DONE\" ] || fail \"W-019 missing-source did not archive the scaffold report\"",
  "[ ! -e \"$TMP/__garelier/tpm/_crew/dispatch2\" ] || fail \"DEC-063 missing-source cleanup left stale dispatch container\"",
  "cleanup_fixture",
  "",
  "# ── 3. W-021 --record-touches: measured base..HEAD paths into context.json ────",
  "mk_fixture rt-ok 3",
  "CTX=\"$TMP/__garelier/tpm/_crew/dispatch3/context.json\"",
  "set +e",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$DT\" --target-root \"$DT\" --pm-id tpm --id 3 --record-touches 2>/dev/null)\"",
  "RC=$?",
  "set -e",
  "[ \"$RC\" -eq 0 ] || fail \"W-021 --record-touches exit was $RC (expected 0). out=$OUT\"",
  "echo \"$OUT\" | grep -q '\"ok\":true' || fail \"W-021 result not ok: $OUT\"",
  "# The fixture's workbench added rt-ok.txt on top of the base commit → touches_actual.",
  "grep -q '\"touches_actual\"' \"$CTX\" || fail \"W-021 context.json missing touches_actual: $(cat \"$CTX\")\"",
  "grep -q 'rt-ok.txt' \"$CTX\" || fail \"W-021 touches_actual did not record the changed file: $(cat \"$CTX\")\"",
  "# The container must NOT have been removed (record-touches cleans up nothing).",
  "[ -d \"$TMP/__garelier/tpm/_crew/dispatch3\" ] || fail \"W-021 --record-touches WRONGLY removed the container\"",
  "cleanup_fixture",
  "",
  "# ── 4. W-053(b): a malformed --target-root (literal, unexpanded \"$DT\") falls",
  "#      back to --project instead of being trusted -- mirrors W-045's guard",
  "#      (absolute + no literal \"$\" + names an existing dir, else fall back",
  "#      untouched) so a broken caller can never turn this into a stray literal-",
  "#      named dir OR a silent no-op (every git -C call below used to run against",
  "#      whatever garbage --target-root carried).",
  "mk_fixture guard-target 4",
  "set +e",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$DT\" --target-root '$DT' --pm-id tpm --id 4 --checkout \"$TMP/__garelier/tpm/_crew/dispatch4/checkout\" --delete-branch 2>/dev/null)\"",
  "RC=$?",
  "set -e",
  "[ \"$RC\" -eq 0 ] || fail \"W-053(b) malformed target-root exit was $RC (expected 0 -- guard should fall back to --project). out=$OUT\"",
  "[ ! -e \"$TMP/\\$DT\" ] || fail \"W-053(b) malformed target-root created a literal \\$DT dir\"",
  "[ -z \"$(git -C \"$TMP\" branch --list '*workbench*')\" ] || fail \"W-053(b) malformed target-root: branch not deleted (fallback broken, git -C never reached the real repo)\"",
  "cleanup_fixture",
  "",
  "# ── 6. W-084(a): --sweep reclaims orphaned runtime/scratch/<slug> lane dirs and",
  "#      preserves a scratch dir whose lane still has a live dispatch container.",
  "#      Role intermediate output (dispatch_prompt_craft §1.8) survives",
  "#      container cleanup and otherwise piles up in the retention gap; the sweep",
  "#      that dispatch_prepare already runs on every new dispatch now reclaims it.",
  "#      No git repo needed — the sweep touches only the runtime/scratch tree.",
  "SWTMP=\"$(mktemp -d)\"; SWDT=\"$(cygpath -m \"$SWTMP\" 2>/dev/null || printf '%s' \"$SWTMP\")\"",
  "mkdir -p \"$SWTMP/__garelier/tpm/runtime/scratch/orphan-lane\"",
  "echo junk > \"$SWTMP/__garelier/tpm/runtime/scratch/orphan-lane/build.log\"",
  "mkdir -p \"$SWTMP/__garelier/tpm/runtime/scratch/live-lane\"",
  "echo live > \"$SWTMP/__garelier/tpm/runtime/scratch/live-lane/preview.png\"",
  "# A live dispatch container still owning slug \"live-lane\" (context.json task.slug).",
  "mkdir -p \"$SWTMP/__garelier/tpm/_crew/dispatch7\"",
  "printf '{\"task\":{\"id\":7,\"slug\":\"live-lane\"}}\\n' > \"$SWTMP/__garelier/tpm/_crew/dispatch7/context.json\"",
  "set +e",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$SWDT\" --pm-id tpm --sweep 2>/dev/null)\"",
  "RC=$?",
  "set -e",
  "[ \"$RC\" -eq 0 ] || fail \"W-084(a) --sweep exit was $RC (expected 0). out=$OUT\"",
  "echo \"$OUT\" | grep -q 'swept=0 remaining=0' || fail \"W-084(a) --sweep should keep the existing swept/remaining prefix: $OUT\"",
  "echo \"$OUT\" | grep -q 'scratch_swept=1' || fail \"W-084(a) --sweep should report scratch_swept=1: $OUT\"",
  "echo \"$OUT\" | grep -q 'scratch_kept=1' || fail \"W-084(a) --sweep should report scratch_kept=1: $OUT\"",
  "[ ! -e \"$SWTMP/__garelier/tpm/runtime/scratch/orphan-lane\" ] || fail \"W-084(a) --sweep left the orphaned scratch lane dir behind\"",
  "[ -d \"$SWTMP/__garelier/tpm/runtime/scratch/live-lane\" ] || fail \"W-084(a) --sweep wrongly removed a live lane's scratch dir\"",
  "[ -f \"$SWTMP/__garelier/tpm/runtime/scratch/live-lane/preview.png\" ] || fail \"W-084(a) --sweep damaged the live lane's scratch contents\"",
  "rm -rf \"$SWTMP\" 2>/dev/null || true",
  "",
  "# ── 7. W-274: the shared sweep reclaims only merged, inactive temporary refs ──",
  "BRTMP=\"$(mktemp -d)\"; BRDT=\"$(cygpath -m \"$BRTMP\" 2>/dev/null || printf '%s' \"$BRTMP\")\"",
  "(",
  "  cd \"$BRTMP\"",
  "  git init -q -b main; git config user.email ci@ci; git config user.name t",
  "  echo base > base.txt; git add -A; git commit -q -m init",
  "  git branch \"garelier/main/tpm/studio\" main",
  "  for branch in garelier/main/tpm/workbench/#10/merged garelier/main/tpm/satchel/#11/merged garelier/isolate/merged __studio_verify; do",
  "    git branch \"$branch\" \"garelier/main/tpm/studio\"",
  "  done",
  "  git checkout -q -b garelier/main/tpm/workbench/#12/unmerged \"garelier/main/tpm/studio\"",
  "  echo unmerged > unmerged.txt; git add -A; git commit -q -m unmerged",
  "  git checkout -q main",
  "  git branch other/unknown \"garelier/main/tpm/studio\"",
  "  git branch user/__studio_preserved \"garelier/main/tpm/studio\"",
  "  git branch garelier/main/tpm/workbench/#13/active \"garelier/main/tpm/studio\"",
  "  git branch garelier/main/tpm/workbench/#14/gate-held \"garelier/main/tpm/studio\"",
  "  git branch garelier/main/tpm/workbench/#16/user-target \"garelier/main/tpm/studio\"",
  "  git branch garelier/main/tpm/workbench/#17/archive-held \"garelier/main/tpm/studio\"",
  "  git worktree add -q checked-wt \"garelier/main/tpm/workbench/#10/merged\"",
  "  git worktree add -q dirty-wt -b garelier/main/tpm/workbench/#15/dirty \"garelier/main/tpm/studio\"",
  "  echo dirty > dirty-wt/dirty.txt",
  "  mkdir -p __garelier/tpm/_crew/pm __garelier/tpm/_crew/dispatch9 __garelier/tpm/runtime/merge_gate/locks __garelier/tpm/runtime/merge_gate/requests __garelier/tpm/runtime/merge_gate/archive",
  "  printf '%s\\n' '[project]' 'name = \"test\"' '' '[branches]' \"target = 'garelier/main/tpm/workbench/#16/user-target'\" 'integration = \"garelier/main/tpm/studio\"' > __garelier/tpm/_crew/pm/setup_config.toml",
  "  printf '{\"task\":{\"branch\":\"garelier/main/tpm/workbench/#13/active\"}}\\n' > __garelier/tpm/_crew/dispatch9/context.json",
  "  printf '{\"workbench_branch\":\"garelier/main/tpm/workbench/#14/gate-held\"}\\n' > __garelier/tpm/runtime/merge_gate/requests/pending.json",
  "  printf '{\"pid\":1,\"request_id\":\"active\",\"request_file\":\"active.json\"}\\n' > __garelier/tpm/runtime/merge_gate/locks/active.lock",
  "  printf '{\"workbench_branch\":\"garelier/main/tpm/workbench/#17/archive-held\"}\\n' > __garelier/tpm/runtime/merge_gate/archive/active.request.json",
  ")",
  "# The aggregate's own canonical temp-ref role is try/finally-shaped:",
  "# both a normal body and a failing body delete exactly their owned ref via -d.",
  "run_studio_fixture() {",
  "  local branch=\"$1\" mode=\"$2\"",
  "  git -C \"$BRTMP\" branch \"$branch\" garelier/main/tpm/studio",
  "  (",
  "    trap 'git -C \"$BRTMP\" branch -d \"$branch\" >/dev/null 2>&1 || true' EXIT",
  "    [ \"$mode\" = success ] || exit 19",
  "  )",
  "}",
  "run_studio_fixture __studio_fixture_success success || fail \"W-274 success fixture body failed\"",
  "set +e; run_studio_fixture __studio_fixture_failure failure; FIXTURE_RC=$?; set -e",
  "[ \"$FIXTURE_RC\" -eq 19 ] || fail \"W-274 failure fixture returned $FIXTURE_RC (expected 19)\"",
  "[ -z \"$(git -C \"$BRTMP\" branch --list '__studio_fixture_*')\" ] || fail \"W-274 fixture role leaked its canonical temp ref\"",
  "set +e",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$BRDT\" --target-root \"$BRDT\" --pm-id tpm --sweep 2>/dev/null)\"",
  "RC=$?",
  "set -e",
  "[ \"$RC\" -eq 0 ] || fail \"W-274 branch sweep exit was $RC (expected 0). out=$OUT\"",
  "echo \"$OUT\" | grep -q 'branch_swept=3' || fail \"W-274 sweep should report three reclaimed branches: $OUT\"",
  "echo \"$OUT\" | grep -q 'branch_failed=0' || fail \"W-274 successful sweep reported a failed deletion: $OUT\"",
  "for branch in garelier/main/tpm/satchel/#11/merged garelier/isolate/merged __studio_verify; do",
  "  [ -z \"$(git -C \"$BRTMP\" branch --list \"$branch\")\" ] || fail \"W-274 sweep left merged inactive branch $branch\"",
  "done",
  "for branch in garelier/main/tpm/workbench/#10/merged garelier/main/tpm/workbench/#12/unmerged garelier/main/tpm/workbench/#13/active garelier/main/tpm/workbench/#14/gate-held garelier/main/tpm/workbench/#15/dirty garelier/main/tpm/workbench/#16/user-target garelier/main/tpm/workbench/#17/archive-held other/unknown user/__studio_preserved main garelier/main/tpm/studio; do",
  "  [ -n \"$(git -C \"$BRTMP\" branch --list \"$branch\")\" ] || fail \"W-274 sweep removed protected branch $branch\"",
  "done",
  "[ -f \"$BRTMP/dirty-wt/dirty.txt\" ] || fail \"W-274 sweep damaged dirty worktree\"",
  "# An unreadable/malformed gate snapshot fails closed and leaves a candidate ref.",
  "git -C \"$BRTMP\" branch __studio_gate_unknown garelier/main/tpm/studio",
  "printf '{malformed\\n' > \"$BRTMP/__garelier/tpm/runtime/merge_gate/locks/active.lock\"",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$BRDT\" --target-root \"$BRDT\" --pm-id tpm --sweep 2>/dev/null)\"",
  "echo \"$OUT\" | grep -q 'branch_swept=0' || fail \"W-274 malformed gate snapshot did not fail closed: $OUT\"",
  "echo \"$OUT\" | grep -q 'gate_inventory_failed:8' || fail \"W-274 malformed gate snapshot reason/count missing: $OUT\"",
  "[ -n \"$(git -C \"$BRTMP\" branch --list __studio_gate_unknown)\" ] || fail \"W-274 malformed gate snapshot exposed a candidate ref\"",
  "rm -f \"$BRTMP/__garelier/tpm/runtime/merge_gate/locks/active.lock\"",
  "git -C \"$BRTMP\" branch -d __studio_gate_unknown >/dev/null",
  "printf '{\"pid\":1,\"request_id\":\"active\",\"request_file\":\"active.json\"}\\n' > \"$BRTMP/__garelier/tpm/runtime/merge_gate/locks/active.lock\"",
  "# A ref lock makes git branch -d fail; the still-present ref is failed, never swept.",
  "git -C \"$BRTMP\" branch __studio_delete_failure garelier/main/tpm/studio",
  "mkdir -p \"$BRTMP/.git/refs/heads\"; : > \"$BRTMP/.git/refs/heads/__studio_delete_failure.lock\"",
  "OUT=\"$(bun \"$CLEANUP\" --project \"$BRDT\" --target-root \"$BRDT\" --pm-id tpm --sweep 2>/dev/null)\"",
  "echo \"$OUT\" | grep -q 'branch_swept=0' || fail \"W-274 failed delete was counted as swept: $OUT\"",
  "echo \"$OUT\" | grep -q 'branch_failed=1' || fail \"W-274 failed delete count missing: $OUT\"",
  "echo \"$OUT\" | grep -q 'delete_failed:1' || fail \"W-274 failed delete reason missing: $OUT\"",
  "[ -n \"$(git -C \"$BRTMP\" branch --list __studio_delete_failure)\" ] || fail \"W-274 delete-failure fixture unexpectedly lost its ref\"",
  "rm -f \"$BRTMP/.git/refs/heads/__studio_delete_failure.lock\"",
  "git -C \"$BRTMP\" branch -d __studio_delete_failure >/dev/null",
  "git -C \"$BRTMP\" worktree remove --force dirty-wt >/dev/null 2>&1 || true",
  "git -C \"$BRTMP\" worktree remove --force checked-wt >/dev/null 2>&1 || true",
  "rm -rf \"$BRTMP\" 2>/dev/null || true",
  "",
  "echo \"dispatch_cleanup.test: OK\"",
].join("\n") + "\n";

test("dispatch_cleanup shell parity oracle", async () => {
  const result = runShellOracle(shellScript, import.meta.path);
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  expect(result.exitCode, stdout + stderr).toBe(0);

  const cleanup: string[] = [];
  const invoke = async (args: string[]) => {
    let capturedOut = "", capturedErr = "", code = 1;
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => { capturedOut += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { capturedErr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(); return true; }) as typeof process.stderr.write;
    try {
      code = await dispatchCleanupMain(args);
    } catch (error) {
      code = typeof (error as { exitCode?: unknown }).exitCode === "number"
        ? (error as { exitCode: number }).exitCode : 1;
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
    return { code, stdout: capturedOut, stderr: capturedErr };
  };
  const git = (cwd: string, ...args: string[]): string => {
    const child = Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return child.stdout.toString().trim();
  };
  const repoFixture = (id: number, slug: string) => {
    const root = mkdtempSync(join(tmpdir(), "garelier-w530-parity-"));
    cleanup.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "ci@ci");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    writeFileSync(join(root, "base.txt"), "base\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    git(root, "branch", "garelier/main/tpm/studio", "main");
    const staging = join(root, "wb");
    git(root, "worktree", "add", "-q", "-b", `garelier/main/tpm/workbench/#${id}/${slug}`, staging, "garelier/main/tpm/studio");
    writeFileSync(join(staging, `${slug}.txt`), "feature\n");
    git(staging, "add", "-A");
    git(staging, "commit", "-q", "-m", slug);
    git(root, "worktree", "remove", staging);
    git(root, "branch", "-f", "garelier/main/tpm/studio", `garelier/main/tpm/workbench/#${id}/${slug}`);
    const pmContainer = join(root, "__garelier", "tpm", "_crew", "pm");
    mkdirSync(pmContainer, { recursive: true });
    writeFileSync(join(pmContainer, "setup_config.toml"), [
      "[project]", 'name = "test"', "", "[branches]", 'target = "main"',
      'integration = "garelier/main/tpm/studio"', "",
    ].join("\n"));
    const container = join(root, "__garelier", "tpm", "_crew", `dispatch${id}`);
    const checkout = join(container, "checkout");
    mkdirSync(container, { recursive: true });
    git(root, "worktree", "add", "-q", checkout, `garelier/main/tpm/workbench/#${id}/${slug}`);
    writeFileSync(join(container, "context.json"), `${JSON.stringify({ task: { id, slug, base_sha: git(root, "rev-parse", "HEAD") } })}\n`);
    return { root, container, checkout };
  };

  try {
    const root = mkdtempSync(join(tmpdir(), "garelier-w530-selection-"));
    cleanup.push(root);
    const pmRoot = join(root, "__garelier", "tpm");
    const container = (id: number): string => join(pmRoot, "_crew", `dispatch${id}`);
    mkdirSync(container(1), { recursive: true });
    writeFileSync(join(container(1), "keep.txt"), "keep\n");
    mkdirSync(container(2), { recursive: true });

    const missing = await invoke(["--project", root, "--target-root", root, "--pm-id", "tpm", "--id", "1", "--force-remove"]);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("--checkout <path> is required");
    expect(existsSync(join(container(1), "keep.txt"))).toBeTrue();
    process.stdout.write(`W530_CF_01 command=dispatch_cleanup --id 1 --force-remove actual=exit:${missing.code},container_exists:true\n`);

    const mismatch = await invoke([
      "--project", root, "--target-root", root, "--pm-id", "tpm", "--id", "1",
      "--checkout", join(container(2), "checkout"), "--force-remove",
    ]);
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stderr).toContain("does not match the checkout derived from --id 1");
    expect(existsSync(container(1))).toBeTrue();
    expect(existsSync(container(2))).toBeTrue();
    process.stdout.write(`W530_CF_02 command=dispatch_cleanup --id 1 --checkout dispatch2/checkout --force-remove actual=exit:${mismatch.code},dispatch1_exists:true,dispatch2_exists:true\n`);

    const failedFile = join(pmRoot, "runtime", "backlog", "failed_cleanups.jsonl");
    mkdirSync(dirname(failedFile), { recursive: true });
    writeFileSync(failedFile, `${JSON.stringify({ dispatch_id: 1, container: container(2), reason: "fixture" })}\n`);
    const mismatchedLedger = await invoke(["--project", root, "--target-root", root, "--pm-id", "tpm", "--sweep"]);
    expect(mismatchedLedger.code, mismatchedLedger.stderr).toBe(0);
    const ledgerPayload = JSON.parse(mismatchedLedger.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(ledgerPayload.failed_cleanups).toContainEqual(expect.objectContaining({
      dispatch_id: 1, status: "skipped", missing_conditions: ["container_path_match"],
    }));
    expect(existsSync(container(1))).toBeTrue();
    expect(existsSync(container(2))).toBeTrue();
    process.stdout.write("W530_CF_03 command=dispatch_cleanup --sweep[ledger-container-mismatch] actual=exit:0,status:skipped,missing:container_path_match\n");

    mkdirSync(join(pmRoot, "control"), { recursive: true });
    writeFileSync(join(pmRoot, "control", "control.toml"), [
      "schema_version = 3", 'kind = "garelier_control"', 'pm_id = "tpm"',
      'mode = "control_only"', 'storage = "plan_graph_markdown"', "",
    ].join("\n"));
    const gateSeat = (id: number, role: "guardian" | "observer", slug: string, workId: string, checkoutPresent: boolean): void => {
      mkdirSync(container(id), { recursive: true });
      writeFileSync(join(container(id), "dispatched_at"), `${Math.floor(Date.now() / 1000)}\n`);
      writeFileSync(join(container(id), "STATE.md"), [
        `# Dispatch #${id} - ${role} ${slug}`, "", "## Status", "", "WORKING", "",
        "## Current task", "", `#${id} ${slug} (garelier/main/tpm/studio)`, "",
      ].join("\n"));
      writeFileSync(join(container(id), "context.json"), `${JSON.stringify({
        task: { id, role, slug, branch: "garelier/main/tpm/studio" },
        control: { work_id: workId, session_id: `cs_${id}`, claim_owned: false },
      })}\n`);
      if (checkoutPresent) mkdirSync(join(container(id), "checkout"), { recursive: true });
    };
    const verdict = (role: "guardian" | "observer", slug: string): void => {
      const path = join(pmRoot, "runtime", role, "results", `${slug}-${role}.md`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `+++\n[verdict]\nresult = 'PASS'\nreview_sha = '${"a".repeat(40)}'\n+++\n`);
    };
    gateSeat(10, "guardian", "missing-verdict", "W-10", false);
    gateSeat(11, "observer", "checkout-present", "W-11", true);
    gateSeat(12, "guardian", "live-claim", "W-12", false);
    verdict("observer", "stale-verdict");
    const staleVerdictPath = join(pmRoot, "runtime", "observer", "results", "stale-verdict-observer.md");
    utimesSync(staleVerdictPath, new Date(0), new Date(0));
    gateSeat(13, "observer", "stale-verdict", "W-13", false);
    verdict("observer", "checkout-present");
    verdict("guardian", "live-claim");
    const claims = join(pmRoot, "runtime", "control", "claims");
    mkdirSync(claims, { recursive: true });
    writeFileSync(join(claims, "W-12.json"), `${JSON.stringify({
      work_id: "W-12", session_id: "cs_12", agent: "guardian(#12)",
      claimed_at: "2026-08-25T00:00:00.000Z", expires_at: "2999-01-01T00:00:00.000Z",
      touches: [], touch_conflicts: [], entity_revision: 1,
      control_schema_version: 3, storage: "plan_graph_markdown",
    })}\n`);
    const held = await invoke(["--project", root, "--target-root", root, "--pm-id", "tpm", "--sweep"]);
    expect(held.code, held.stderr).toBe(0);
    const heldPayload = JSON.parse(held.stdout.trim().split(/\r?\n/).at(-1)!);
    const heldSeats = new Map(heldPayload.gate_seats.map((entry: { id: number }) => [entry.id, entry]));
    expect(heldSeats.get(10)).toMatchObject({ status: "kept", missing_conditions: ["verdict_file"] });
    expect(heldSeats.get(11)).toMatchObject({ status: "kept", missing_conditions: ["checkout_absent"] });
    expect(heldSeats.get(12)).toMatchObject({ status: "kept", missing_conditions: ["claim_not_live"] });
    expect(heldSeats.get(13)).toMatchObject({ status: "kept", missing_conditions: ["verdict_file"] });
    process.stdout.write("W530_CF_09 command=dispatch_cleanup --sweep[checkout-present] actual=exit:0,status:kept,missing:checkout_absent\n");
    process.stdout.write("W530_CF_10 command=dispatch_cleanup --sweep[live-claim] actual=exit:0,status:kept,missing:claim_not_live\n");
    verdict("guardian", "missing-verdict");
    verdict("observer", "stale-verdict");
    const reclaimed = await invoke(["--project", root, "--target-root", root, "--pm-id", "tpm", "--sweep"]);
    expect(reclaimed.code, reclaimed.stderr).toBe(0);
    const reclaimedPayload = JSON.parse(reclaimed.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(reclaimedPayload.gate_seats).toContainEqual(expect.objectContaining({ id: 10, status: "reclaimed", missing_conditions: [] }));
    expect(reclaimedPayload.gate_seats).toContainEqual(expect.objectContaining({ id: 13, status: "reclaimed", missing_conditions: [] }));
    expect(existsSync(container(10))).toBeFalse();
    expect(existsSync(container(13))).toBeFalse();
    process.stdout.write("W530_CF_08 command=dispatch_cleanup --sweep[verdict-missing->restored] actual=kept:verdict_file,reclaimed:true\n");

    const identity = repoFixture(531, "identity");
    unlinkSync(join(identity.checkout, ".git"));
    const identityResult = await invoke(["--project", identity.root, "--target-root", identity.root, "--pm-id", "tpm", "--id", "531", "--checkout", identity.checkout]);
    expect(identityResult.code).toBe(3);
    expect(identityResult.stderr).toContain("linked-worktree marker");
    expect(existsSync(identity.container)).toBeTrue();
    process.stdout.write("W530_CF_04 command=dispatch_cleanup --id 531 --checkout dispatch531/checkout[missing-identity] actual=exit:3,container_exists:true,reason:identity_guard\n");

    const dirty = repoFixture(532, "dirty");
    writeFileSync(join(dirty.checkout, "only-copy.txt"), "uncommitted\n");
    const dirtyResult = await invoke(["--project", dirty.root, "--target-root", dirty.root, "--pm-id", "tpm", "--id", "532", "--checkout", dirty.checkout]);
    expect(dirtyResult.code).toBe(3);
    expect(dirtyResult.stderr).toContain("uncommitted path(s)");
    expect(existsSync(join(dirty.checkout, "only-copy.txt"))).toBeTrue();
    process.stdout.write("W530_CF_05 command=dispatch_cleanup --id 532 --checkout dispatch532/checkout[dirty] actual=exit:3,container_exists:true,reason:uncommitted_paths\n");

    const reparse = repoFixture(533, "reparse");
    const sentinel = join(reparse.root, "sentinel");
    mkdirSync(sentinel, { recursive: true });
    writeFileSync(join(sentinel, "precious.txt"), "survives\n");
    symlinkSync(sentinel, join(reparse.checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const reparseResult = await invoke(["--project", reparse.root, "--target-root", reparse.root, "--pm-id", "tpm", "--id", "533", "--checkout", reparse.checkout]);
    expect(reparseResult.code, reparseResult.stderr).toBe(0);
    expect(reparseResult.stderr).toContain("detached 1 reparse point(s)");
    expect(readFileSync(join(sentinel, "precious.txt"), "utf8")).toBe("survives\n");

    const fenceRoot = mkdtempSync(join(tmpdir(), "garelier-w530-fence-"));
    cleanup.push(fenceRoot);
    configurePathGuardRoots([fenceRoot]);
    const reparseTarget = mkdtempSync(join(tmpdir(), "garelier-w530-reparse-target-"));
    cleanup.push(reparseTarget);
    writeFileSync(join(reparseTarget, "precious.txt"), "survives refusal\n");
    const reparseRoot = join(fenceRoot, "reparse-root");
    symlinkSync(reparseTarget, reparseRoot, process.platform === "win32" ? "junction" : "dir");
    expect(() => removeTreeSync(reparseRoot, { fenceRoots: [fenceRoot] })).toThrow("path_guard: delete denied outside fence roots");
    expect(existsSync(reparseRoot)).toBeTrue();
    expect(readFileSync(join(reparseTarget, "precious.txt"), "utf8")).toBe("survives refusal\n");
    process.stdout.write("W530_CF_06 command=removeTreeSync[reparse-root-outside-fence] actual=threw:path_guard-delete-denied,link_exists:true,target_exists:true\n");

    const refused = join(fenceRoot, "nested", ".git", "container");
    mkdirSync(refused, { recursive: true });
    writeFileSync(join(refused, "keep.txt"), "keep\n");
    expect(() => removeTreeSync(refused)).toThrow("path_guard: delete denied for .git path");
    expect(existsSync(join(refused, "keep.txt"))).toBeTrue();
    process.stdout.write("W530_CF_07 command=removeTreeSync[path-fence] actual=threw:path_guard-delete-denied,container_exists:true\n");
  } finally {
    for (const path of cleanup.reverse()) rmSync(path, { recursive: true, force: true });
  }
}, 240_000);
