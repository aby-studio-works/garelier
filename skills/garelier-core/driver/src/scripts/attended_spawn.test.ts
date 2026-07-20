import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { runAttendedSpawn, roleProfile, runCli, mismatchedGateRecords } from "./attended_spawn.ts";
import { crewSubdir } from "../workspace.ts";
import { seatAgentName } from "./gate_agents.ts";

const tempRoots: string[] = [];
afterEach(() => { for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const PM = "aby_works";

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "attended-spawn-"));
  tempRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "__garelier", PM), { recursive: true });
  return root;
}

test("W-168: roleProfile maps roles (guardian/observer→gate, worker/scout→producer; unknown throws)", () => {
  expect(roleProfile("guardian")).toBe("gate");
  expect(roleProfile("observer")).toBe("gate");
  expect(roleProfile("worker")).toBe("producer");
  expect(roleProfile("scout")).toBe("producer");
  expect(() => roleProfile("smith")).toThrow();
});

test("W-168: worker seat — one command issues a producer pm-direct record + ga-<role>-<slug> plan", () => {
  const root = makeProject();
  const worktree = join(root, "__garelier", PM, "_crew", "lanes", "feat-a", "checkout");
  mkdirSync(worktree, { recursive: true });
  const plan = runAttendedSpawn({ role: "worker", slug: "feat-a", project: root, pmId: PM, worktree });
  expect(plan.name).toBe("ga-worker-feat-a");
  expect(plan.profile).toBe("producer");
  expect(plan.verdict_template).toBeNull();
  expect(plan.report_path).toBe("runtime/worker/results/feat-a-worker.md");
  expect(existsSync(plan.record_path)).toBe(true);
  const rec = JSON.parse(readFileSync(plan.record_path, "utf8"));
  expect(rec.lane_kind).toBe("pm-direct");                 // declared PM-direct lane
  expect(rec.guard.permission_profile).toBe("producer");
  expect(rec.guard.agent_name).toBe("ga-worker-feat-a");
  expect(plan.prompt_skeleton).toContain("garelier-worker");
  expect(plan.prompt_skeleton).toContain("Delivery (W-146)");
});

test("W-168: gate seat via --dispatch-id adopts context.json gate_agents name VERBATIM", () => {
  const root = makeProject();
  const container = crewSubdir(root, PM, "_dispatch42");
  const checkout = join(container, "checkout");
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(container, "context.json"), JSON.stringify({
    task: { slug: "m21-flow", branch: "garelier/x/_workshop/w42" },
    guard: { worktree: checkout },
    gate_agents: {
      guardian: { name: "ga-guardian-m21-flow", report: "runtime/guardian/results/m21-flow-guardian.md", verdict_template: "skills/garelier-core/templates/gate_verdict.md", model: "claude-opus-4-8" },
      observer: { name: "ga-observer-m21-flow", report: "runtime/observer/results/m21-flow-observer.md", verdict_template: "skills/garelier-core/templates/gate_verdict.md", model: "claude-opus-4-8" },
    },
  }, null, 2));

  const plan = runAttendedSpawn({ role: "guardian", project: root, pmId: PM, dispatchId: "42" });
  expect(plan.name).toBe("ga-guardian-m21-flow");          // verbatim from the dispatch
  expect(plan.slug).toBe("m21-flow");
  expect(plan.profile).toBe("gate");
  expect(plan.report_path).toBe("runtime/guardian/results/m21-flow-guardian.md");
  expect(plan.verdict_template).toContain("gate_verdict.md");
  expect(plan.model).toBe("claude-opus-4-8");              // O1: dispatch's resolved gate model, verbatim
  expect(plan.prompt_skeleton).toContain("branch=garelier/x/_workshop/w42"); // O2: orientation line
  expect(plan.prompt_skeleton).toContain("Orientation:");
  expect(existsSync(plan.record_path)).toBe(true);
  const rec = JSON.parse(readFileSync(plan.record_path, "utf8"));
  expect(rec.guard.permission_profile).toBe("gate");
  expect(rec.spawned_via).toBe("attended_spawn");          // O4: self-marker so the detective exempts it
});

test("W-168: the gate name equals the shared derivation (dispatch_prepare/context_pack cannot drift)", () => {
  expect(seatAgentName("guardian", "m21-flow")).toBe("ga-guardian-m21-flow");
  expect(seatAgentName("observer", "m21-flow")).toBe("ga-observer-m21-flow");
});

test("W-168: the CLI output is the spawn-param JSON schema", () => {
  const root = makeProject();
  const worktree = join(root, "__garelier", PM, "_crew", "lanes", "s1", "checkout");
  mkdirSync(worktree, { recursive: true });
  const { code, message } = runCli(["--role", "scout", "--slug", "s1", "--project", root, "--pm-id", PM, "--worktree", worktree]);
  expect(code).toBe(0);
  const plan = JSON.parse(message);
  for (const key of ["role", "profile", "name", "slug", "model", "report_path", "verdict_template", "worktree", "fence_roots", "record_path", "prompt_skeleton"]) {
    expect(plan).toHaveProperty(key);
  }
  expect(plan.name).toBe("ga-scout-s1");
  expect(plan.profile).toBe("producer");
});

test("W-168 (c/O4): the detective flags hand-made gate names but exempts attended_spawn ad-hoc seats", () => {
  const canonical = new Set(["ga-guardian-m21-flow", "ga-observer-m21-flow"]);
  const records = [
    { name: "ga-guardian-m21-flow", profile: "gate" },                              // canonical — OK
    { name: "ga-observer-m21-flow", profile: "gate" },                              // canonical — OK
    { name: "guardian-review", profile: "gate" },                                   // not ga-* shape -> not flagged
    { name: "ga-guardian-typo-slug", profile: "gate" },                             // hand-made ga-guardian-* -> FLAG
    { name: "ga-observer-adhoc", profile: "gate" },                                 // hand-made -> FLAG
    { name: "ga-observer-review-x", profile: "gate", spawnedVia: "attended_spawn" }, // O4: ad-hoc attended_spawn seat, no dispatch -> EXEMPT
    { name: "ga-worker-feat-a", profile: "producer" },                              // producer seat -> not a gate mismatch
  ];
  expect(mismatchedGateRecords(canonical, records)).toEqual(["ga-guardian-typo-slug", "ga-observer-adhoc"]);
  // all-canonical -> no findings
  expect(mismatchedGateRecords(canonical, records.slice(0, 2))).toEqual([]);
  // an ad-hoc attended_spawn gate seat with NO canonical dispatch is exempt (not flagged).
  expect(mismatchedGateRecords(new Set(), [{ name: "ga-observer-review-x", profile: "gate", spawnedVia: "attended_spawn" }])).toEqual([]);
});

test("W-168: an unknown role is rejected (exit 1)", () => {
  const root = makeProject();
  const worktree = join(root, "__garelier", PM, "_crew", "lanes", "x", "checkout");
  mkdirSync(worktree, { recursive: true });
  expect(runCli(["--role", "smith", "--slug", "x", "--project", root, "--pm-id", PM, "--worktree", worktree]).code).toBe(1);
});
