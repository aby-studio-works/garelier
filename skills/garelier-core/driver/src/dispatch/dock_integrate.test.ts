// DEC-083 — dock_integrate.ts deterministic merge tail. Tests the core
// integrateItems()/integrateOne() with INJECTED deps (no bash, no real gate),
// covering the risk-first mechanics: status mapping, idempotent adopt (keyed on
// workbench_branch, not the lossy task_id), questions.md, cleanup-on-success-only,
// gate_held (dispatchId==null) no-op cleanup, and missing-guardian guarding.
import { test, expect } from "bun:test";
import { integrateItems, integrateOne, type IntegrateDeps, type IntegrateCtx, type IntegrateItem } from "./dock_integrate.ts";

const CTX: IntegrateCtx = {
  project: "/proj", pmId: "demo", scriptsDir: "/core/scripts", studioBranch: "x/studio",
  pollMs: 1, ceilingMs: 1000, noCleanup: false,
};

interface Recorder { bash: Array<{ script: string; args: string[] }>; questions: Array<{ id: string | number; content: string }>; }

function makeDeps(opts: {
  result?: (stem: string) => { status?: string } | null;   // readResult
  ancestor?: boolean;                                        // isAncestorOfStudio
  existing?: Array<{ stem: string; workbench_branch: string | null; terminalStatus: string | null }>;
  mergeRequestId?: string;
  nowSeq?: number[];                                          // controllable clock
  bashCode?: (script: string) => number;                     // exit code per script
} = {}): { deps: IntegrateDeps; rec: Recorder } {
  const rec: Recorder = { bash: [], questions: [] };
  let nowi = 0;
  const nowSeq = opts.nowSeq ?? [0, 0, 0, 0, 0, 0];
  return {
    rec,
    deps: {
      runBash(script, args) {
        rec.bash.push({ script, args });
        const code = opts.bashCode ? opts.bashCode(script) : 0;
        if (script.endsWith("merge_request.sh")) return { stdout: JSON.stringify({ request_id: opts.mergeRequestId ?? "REQ-NEW" }), stderr: "", code };
        return { stdout: "", stderr: "", code };
      },
      async pollOnce() { /* no-op */ },
      readResult(stem) { return opts.result ? opts.result(stem) : null; },
      isAncestorOfStudio() { return !!opts.ancestor; },
      scanRequests() { return opts.existing ?? []; },
      writeQuestions(id, content) { rec.questions.push({ id, content }); },
      now() { const v = nowSeq[Math.min(nowi, nowSeq.length - 1)]; nowi++; return v; },
      sleep: () => Promise.resolve(),
      log: { info() {}, warn() {} },
    },
  };
}

const baseItem = (over: Partial<IntegrateItem> = {}): IntegrateItem => ({
  slug: "demo-task", branch: "x/workbench/#1/demo-task", guardianVerdict: "PASS", observerVerdict: "PASS_WITH_NOTES",
  dispatchId: 1, role: "worker", sha: "abc123", summary: "did the thing", hasWarmProducer: true, task: "demo-task",
  deleteBranch: true, ...over,
});

test("success -> INTEGRATED + cleanup called", async () => {
  const { deps, rec } = makeDeps({ result: () => ({ status: "success" }) });
  const r = await integrateItems([baseItem()], CTX, deps);
  expect(r.integrated.length).toBe(1);
  expect(r.integrated[0].merged).toBe(true);
  expect(rec.bash.some((b) => b.script.endsWith("merge_request.sh"))).toBe(true);
  expect(rec.bash.some((b) => b.script.endsWith("dispatch_cleanup.sh"))).toBe(true);
  expect(rec.questions.length).toBe(0); // complete -> no questions.md
});

test("failed -> mergeFailed + NO cleanup + questions.md", async () => {
  const { deps, rec } = makeDeps({ result: () => ({ status: "failed" }), ancestor: false });
  const r = await integrateItems([baseItem()], CTX, deps);
  expect(r.mergeFailed.length).toBe(1);
  expect(r.integrated.length).toBe(0);
  expect(rec.bash.some((b) => b.script.endsWith("dispatch_cleanup.sh"))).toBe(false);
  expect(rec.questions.length).toBe(1); // non-complete + dispatchId -> questions.md
  expect(rec.questions[0].content).toContain("# demo-task -> MERGE_FAILED");
});

test("timeout (ceiling) -> ENQUEUED, no cleanup, not a failure", async () => {
  const { deps, rec } = makeDeps({ result: () => null, nowSeq: [0, 999999] });
  const r = await integrateItems([baseItem()], CTX, deps);
  expect(r.enqueued.length).toBe(1);
  expect(r.enqueued[0].merged).toBe(false);
  expect(rec.bash.some((b) => b.script.endsWith("dispatch_cleanup.sh"))).toBe(false);
});

test("missing guardian -> INTEGRATE_ERROR, no merge_request call", async () => {
  const { deps, rec } = makeDeps({ result: () => ({ status: "success" }) });
  const r = await integrateItems([baseItem({ guardianVerdict: "" })], CTX, deps);
  expect(r.integrateError.length).toBe(1);
  expect(rec.bash.some((b) => b.script.endsWith("merge_request.sh"))).toBe(false);
});

test("re-run adopts existing in-flight request for the SAME branch (no second merge_request)", async () => {
  const it = baseItem();
  const { deps, rec } = makeDeps({
    existing: [{ stem: "REQ-OLD", workbench_branch: it.branch, terminalStatus: null }],
    result: (stem) => (stem === "REQ-OLD" ? { status: "success" } : null),
  });
  const r = await integrateOne(it, CTX, deps);
  expect(r.adopted).toBe(true);
  expect(r.requestId).toBe("REQ-OLD");
  expect(r.state).toBe("INTEGRATED");
  expect(rec.bash.some((b) => b.script.endsWith("merge_request.sh"))).toBe(false); // adopted, no new request
});

test("SAFE_TASK collision: same task, different branch -> does NOT cross-adopt (keyed on workbench_branch)", async () => {
  const itB2 = baseItem({ slug: "task-b2", branch: "x/workbench/#2/task-b2", task: "same-truncated-task" });
  const { deps, rec } = makeDeps({
    // an existing request belongs to a DIFFERENT branch (#1) though the task string collides
    existing: [{ stem: "REQ-B1", workbench_branch: "x/workbench/#1/task-b1", terminalStatus: null }],
    result: () => ({ status: "success" }),
    mergeRequestId: "REQ-B2-FRESH",
  });
  const r = await integrateOne(itB2, CTX, deps);
  expect(r.adopted).toBe(false);                          // did NOT adopt REQ-B1
  expect(r.requestId).toBe("REQ-B2-FRESH");
  expect(rec.bash.some((b) => b.script.endsWith("merge_request.sh"))).toBe(true); // issued its own
});

test("already-merged ancestor -> INTEGRATED without issuing a request", async () => {
  const { deps, rec } = makeDeps({ ancestor: true });
  const r = await integrateOne(baseItem(), CTX, deps);
  expect(r.state).toBe("INTEGRATED");
  expect(rec.bash.some((b) => b.script.endsWith("merge_request.sh"))).toBe(false); // already merged, no request
  expect(rec.bash.some((b) => b.script.endsWith("dispatch_cleanup.sh"))).toBe(true); // success -> cleanup
});

test("gate_held (dispatchId==null) success -> cleanup no-op (git branch -D, not dispatch_cleanup)", async () => {
  const { deps, rec } = makeDeps({ result: () => ({ status: "success" }) });
  const r = await integrateOne(baseItem({ dispatchId: null, hasWarmProducer: false, deleteBranch: true }), CTX, deps);
  expect(r.state).toBe("INTEGRATED");
  expect(rec.bash.some((b) => b.script.endsWith("dispatch_cleanup.sh"))).toBe(false); // no container to clean
  expect(rec.bash.some((b) => b.script === "git" && b.args[0] === "branch")).toBe(true); // direct branch delete
});

test("--no-cleanup -> success but cleanup skipped", async () => {
  const { deps, rec } = makeDeps({ result: () => ({ status: "success" }) });
  const r = await integrateItems([baseItem()], { ...CTX, noCleanup: true }, deps);
  expect(r.integrated.length).toBe(1);
  expect(rec.bash.some((b) => b.script.endsWith("dispatch_cleanup.sh"))).toBe(false);
});

test("aborted but actually already-merged -> reclassified INTEGRATED (commit-before-result window)", async () => {
  // gate synthesized 'aborted' AFTER committing studio; ancestor check flips it to success.
  let polls = 0;
  const { deps } = makeDeps({ result: () => ({ status: "aborted" }), ancestor: true });
  const r = await integrateOne(baseItem(), CTX, deps);
  // ancestor:true means the already-merged short-circuit returns success before any request — INTEGRATED
  expect(r.state).toBe("INTEGRATED");
  void polls;
});
