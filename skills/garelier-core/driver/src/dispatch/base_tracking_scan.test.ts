import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// W-061: base_tracking_scan.sh implements DEC-039 §8.6 forward-integration drift
// detection (studio -> in-flight workbench/anvil) as one command. These tests
// pin the load-bearing behavior in a throwaway git repo: behind-count, the
// eligibility filter (WORKING + workbench/anvil only), the threshold gate,
// dry-run vs --write, and idempotency (a second --write must not re-trigger a
// producer that already has a pending track-target.md).

const SCRIPT = join(import.meta.dir, "..", "..", "..", "scripts", "base_tracking_scan.sh");
const T = 90_000; // spawns many git worktree subprocesses; robust under load

let repo: string;
afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } }, T);

// Build a fake project. Studio history is created BEFORE any __garelier scaffold
// exists, so the untracked scaffold is never swept by a branch switch. Producer
// branches are cut at chosen studio ancestors to fix their behind-count.
//
// Containers (all with a checkout worktree on their branch + a STATE.md):
//   _dispatch1  worker  behind 5  WORKING     -> trigger
//   _dispatch2  worker  behind 0  WORKING     -> current
//   _dispatch3  worker  behind 1  WORKING     -> below-threshold (default 3)
//   _dispatch4  worker  behind 5  REPORTING   -> skipped (not WORKING)
//   _dispatch5  smith   behind 5  WORKING     -> trigger (anvil, role=smith)
//   _dispatch6  scout   behind 5  WORKING     -> skipped (spyglass branch)
//   _workers/w1 worker  behind 5  WORKING     -> trigger (persistent container path)
function buildRepo(): string {
  repo = mkdtempSync(join(tmpdir(), "garelier-bts-"));
  const P = "garelier/main/tpm";
  const script = `
set -e
cd "${repo.replace(/\\/g, "/")}"
git init -q -b main
git config user.email t@t; git config user.name t
git config commit.gpgsign false
echo c0 > f; git add f; git commit -qm c0
# studio history: 5 commits past c0 (tip = studio~0, c0 = main)
git branch ${P}/studio
git switch -q ${P}/studio
for i in 1 2 3 4 5; do echo "s$i" > "s$i"; git add "s$i"; git commit -qm "s$i"; done
git switch -q main
# producer branches at chosen ancestors of the studio tip
git branch "${P}/workbench/#1/feat5" main               # behind 5
git branch "${P}/workbench/#2/cur"   ${P}/studio         # behind 0
git branch "${P}/workbench/#3/feat1" ${P}/studio~1       # behind 1
git branch "${P}/workbench/#4/done"  main               # behind 5 (REPORTING)
git branch "${P}/anvil/#5/hard"      main               # behind 5 (smith)
git branch "${P}/spyglass/#6/probe"  main               # behind 5 (scout, skipped)
git branch "${P}/workbench/#7/persist" main             # behind 5 (persistent worker)
# scaffold (untracked) + checkout worktrees + STATE.md
mkdir -p __garelier/tpm/_pm
printf '[branches]\\nintegration = "${P}/studio"\\n' > __garelier/tpm/_pm/setup_config.toml
mkcont() {  # <container-dir> <branch> <status>
  git worktree add -q "$1/checkout" "$2"
  printf '# Dispatch\\n\\n## Status\\n\\n%s\\n\\n## Current task\\n\\ntask\\n' "$3" > "$1/STATE.md"
}
mkcont __garelier/tpm/_dispatch1 "${P}/workbench/#1/feat5" WORKING
mkcont __garelier/tpm/_dispatch2 "${P}/workbench/#2/cur"   WORKING
mkcont __garelier/tpm/_dispatch3 "${P}/workbench/#3/feat1" WORKING
mkcont __garelier/tpm/_dispatch4 "${P}/workbench/#4/done"  REPORTING
mkcont __garelier/tpm/_dispatch5 "${P}/anvil/#5/hard"      WORKING
mkcont __garelier/tpm/_dispatch6 "${P}/spyglass/#6/probe"  WORKING
mkdir -p __garelier/tpm/_workers/w1
mkcont __garelier/tpm/_workers/w1 "${P}/workbench/#7/persist" WORKING
`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("buildRepo failed: " + r.stderr + r.stdout);
  return repo;
}

function run(args: string[]): { code: number; out: string; err: string } {
  const cmd = `bash '${SCRIPT.replace(/\\/g, "/")}' --pm-id tpm --project '${repo.replace(/\\/g, "/")}' ${args.join(" ")}`;
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

interface Producer { container: string; role: string; branch: string; behind: number; pending: boolean; action: string; wrote: boolean; }
interface ScanOut { pm_id: string; studio: string; threshold: number; mode: string; scanned: number; triggered: number; producers: Producer[]; }

function scan(args: string[]): ScanOut {
  const r = run(args);
  expect(r.code).toBe(0);
  return JSON.parse(r.out.trim()) as ScanOut;
}
const byContainer = (o: ScanOut, c: string) => o.producers.find((p) => p.container === c);

describe("base_tracking_scan.sh (DEC-039 §8.6, W-061)", () => {
  test("dry-run: behind-count + eligibility filter; writes nothing", () => {
    buildRepo();
    const o = scan([]);
    expect(o.mode).toBe("dry-run");
    expect(o.studio).toBe("garelier/main/tpm/studio");
    // Only WORKING producers on a workbench/anvil branch are scanned:
    // dispatch1/2/3/5 + workers/w1 = 5. dispatch4 (REPORTING) and dispatch6
    // (spyglass) are out of scope.
    expect(o.scanned).toBe(5);
    expect(byContainer(o, "_dispatch4")).toBeUndefined();
    expect(byContainer(o, "_dispatch6")).toBeUndefined();

    expect(byContainer(o, "_dispatch1")).toMatchObject({ role: "worker", behind: 5, action: "trigger", wrote: false });
    expect(byContainer(o, "_dispatch2")).toMatchObject({ behind: 0, action: "current" });
    expect(byContainer(o, "_dispatch3")).toMatchObject({ behind: 1, action: "below-threshold" });
    expect(byContainer(o, "_dispatch5")).toMatchObject({ role: "smith", behind: 5, action: "trigger" });
    expect(byContainer(o, "_workers/w1")).toMatchObject({ role: "worker", behind: 5, action: "trigger" });
    expect(o.triggered).toBe(3);

    // dry-run must not have written any track-target.md.
    for (const c of ["_dispatch1", "_dispatch5", "_workers/w1"]) {
      expect(existsSync(join(repo, "__garelier/tpm", c, "track-target.md"))).toBe(false);
    }
  }, T);

  test("--write drops the §8.5 track-target.md for eligible producers only", () => {
    buildRepo();
    const o = scan(["--write"]);
    expect(o.mode).toBe("write");
    expect(o.triggered).toBe(3);
    expect(byContainer(o, "_dispatch1")).toMatchObject({ action: "trigger", wrote: true, pending: true });

    const trig = join(repo, "__garelier/tpm/_dispatch1/track-target.md");
    expect(existsSync(trig)).toBe(true);
    const body = readFileSync(trig, "utf8");
    expect(body).toContain("# Track target");
    expect(body).toContain("Issued by: Dock");
    expect(body).toContain("Strategy: merge");
    expect(body).toContain("DEC-039 §8.6");
    expect(body).toContain("5 commit(s)");

    // Below-threshold / current producers get NO trigger file.
    expect(existsSync(join(repo, "__garelier/tpm/_dispatch2/track-target.md"))).toBe(false);
    expect(existsSync(join(repo, "__garelier/tpm/_dispatch3/track-target.md"))).toBe(false);
  }, T);

  test("idempotent: a second --write does not re-trigger a pending producer", () => {
    buildRepo();
    scan(["--write"]);
    const trig = join(repo, "__garelier/tpm/_dispatch1/track-target.md");
    const first = readFileSync(trig, "utf8");

    const o2 = scan(["--write"]);
    // Nothing newly triggered; the pending producer is reported as skipped.
    expect(o2.triggered).toBe(0);
    expect(byContainer(o2, "_dispatch1")).toMatchObject({ action: "pending", wrote: false, pending: true });
    // The existing trigger file is untouched (not clobbered / re-stamped).
    expect(readFileSync(trig, "utf8")).toBe(first);
  }, T);

  test("--threshold gates triggering; below the threshold is a skip", () => {
    buildRepo();
    const o = scan(["--threshold", "6", "--write"]);
    // behind 5 < threshold 6 for every candidate -> no triggers, no files.
    expect(o.triggered).toBe(0);
    expect(byContainer(o, "_dispatch1")).toMatchObject({ behind: 5, action: "below-threshold" });
    expect(existsSync(join(repo, "__garelier/tpm/_dispatch1/track-target.md"))).toBe(false);
  }, T);

  test("bad args / missing pm-id are rejected (exit 2)", () => {
    buildRepo();
    expect(run(["--bogus"]).code).toBe(2);
    const noPm = spawnSync("bash", ["-c", `bash '${SCRIPT.replace(/\\/g, "/")}' --project '${repo.replace(/\\/g, "/")}'`], { encoding: "utf8" });
    expect(noPm.status).toBe(2);
  }, T);
});
