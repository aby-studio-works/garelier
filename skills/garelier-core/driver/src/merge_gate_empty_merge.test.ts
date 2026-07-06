import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// Integration test for merge-gate.sh's already-up-to-date short-circuit (W-055,
// point 3). When a re-submitted request's workbench tip is already an ancestor
// of studio (e.g. its content was absorbed into an earlier commit), step 3's
// `git merge --no-ff --no-commit` prints "Already up to date." and writes no
// MERGE_HEAD, so step 5 would hit "nothing to commit" and abort. The gate must
// instead complete as success (idempotent re-submission).

const MERGE_GATE = join(import.meta.dir, "..", "..", "scripts", "merge-gate.sh");
const PM = "tpm";
const STUDIO = `garelier/t/${PM}/studio`;
const WB = `garelier/t/${PM}/workbench/#1/x`;
// merge-gate.sh spawns bun (parse/prune); give a generous budget under load.
const T = 90_000;

type Run = { code: number; stdout: string; stderr: string };
function run(cwd: string, cmd: string): Run {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: process.env });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let repo: string;
afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } }, T);

function writeIn(rel: string, content: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// Build a project + git repo. `alreadyMerged` controls whether the workbench is
// pre-merged into studio (empty re-merge) or still distinct (real merge).
function setup(alreadyMerged: boolean, gateCmd: string) {
  repo = mkdtempSync(join(tmpdir(), "garelier-mg-"));
  run(repo, "git init -q");
  run(repo, "git config user.email ci@ci && git config user.name ci && git config commit.gpgsign false");
  run(repo, `git checkout -q -b ${STUDIO}`);
  writeIn("base.txt", "base\n");
  run(repo, "git add -A && git commit -q -m base");
  run(repo, `git checkout -q -b ${WB}`);
  writeIn("feature.txt", "feature\n");
  run(repo, "git add -A && git commit -q -m feature");
  run(repo, `git checkout -q ${STUDIO}`);
  if (alreadyMerged) {
    // Land the workbench first, so a later gate re-merge is a no-op.
    run(repo, `git merge --no-ff --no-commit ${WB} && git commit -q -m "absorbed ${WB}"`);
  }
  const reqDir = `__garelier/${PM}/runtime/merge_gate/requests`;
  const req = {
    request_id: "req1",
    workbench_branch: WB,
    studio_branch: STUDIO,
    target_root: repo,
    quality_gate_commands: [gateCmd],
    merge_message: `merge x into studio`,
  };
  writeIn(join(reqDir, "req1.json"), JSON.stringify(req, null, 2));
  return join(repo, reqDir, "req1.json");
}

function result(): Record<string, unknown> {
  const p = join(repo, `__garelier/${PM}/runtime/merge_gate/results/req1.json`);
  expect(existsSync(p)).toBe(true);
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("merge-gate.sh already-up-to-date short-circuit (W-055)", () => {
  test("an already-merged workbench completes as success without running the gate", () => {
    // The gate command would FAIL if executed — proving the short-circuit skips it.
    const reqPath = setup(true, "exit 1");
    const studioBefore = run(repo, `git rev-parse ${STUDIO}`).stdout.trim();
    const r = run(repo, `bash '${MERGE_GATE}' '${reqPath}'`);
    expect(r.code).toBe(0);
    const res = result();
    expect(res.status).toBe("success");
    // Studio must not have advanced (no new merge commit).
    expect(run(repo, `git rev-parse ${STUDIO}`).stdout.trim()).toBe(studioBefore);
    // Gate marker: an empty gate_steps array means the quality gate never ran.
    expect(res.gate_steps).toEqual([]);
  }, T);

  test("a real (non-empty) merge still runs the gate — a failing gate fails the merge", () => {
    const reqPath = setup(false, "exit 1");
    const r = run(repo, `bash '${MERGE_GATE}' '${reqPath}'`);
    const res = result();
    expect(res.status).toBe("failed"); // gate ran and failed -> proves the gate is not always skipped
  }, T);
});
