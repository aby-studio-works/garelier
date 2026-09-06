# Execution-route selection addendum (W-043) — new patterns + hard rules

The **canonical execution-route decision tree is `entry_routing.md`** (PM planning /
PM-directed / Artisan / Dock). This addendum adds the patterns and rules decided
2026-07-11 and completed by W-206.
Consult this from the PM/Dock seat when dispatching.

## Added patterns

| Situation | Pattern |
| --- | --- |
| External seat wanted (cost / parallel capacity) and the task is edit+gate shaped | **Codex-dispatched role seat** — launch ONLY via the `launch_cmd` emitted by `dispatch_prepare`; `commit_mode=proxy` (W-042): the role never runs `git add/commit` (its sandbox re-pins `.git`/gitdir read-only after `--add-dir` — upstream openai/codex #14338/#15505/#18918); it reports a commit plan; the Dock proxy-commits it after two mandatory checks (guardian W-042): reconcile the actual changed files against the declared `--touches` scope (refuse/escalate on out-of-scope hooks/CI/.gitattributes/.gitignore/validator paths — never commit blind), and write the `Garelier-Seat: codex <model> (proxy-commit via dock seat)` trailer from the dispatch JSON (authoritative), not from the plan text. Gates then review that SHA. The proxy floor is fail-closed: `--commit-mode self` and `GARELIER_EXTERNAL_SEAT_COMMIT=self` are rejected before id/branch/worktree mutation. Any future self-commit mode requires a recorded decision and implementation change; an upstream capability alone does not enable it. Details: `codex_worker_playbook.md` |
| Standalone advisory audit NOT bound to a dispatch (plan coverage, perf sweep, test-debt census…) | **field investigation** (W-044): bare agent named `ga-audit-<topic>`, read-only, NO execution route/branch/STATE, report to `runtime/observer/results/<topic>-audit.md`; the PM writes a disposition and commits accepted findings to `control/`. Same advisory philosophy as the Wanderer, but PM-spawned and topic-scoped |

## Hard rules (user-set, 2026-07-11)

- **TWO DISTINCT RULES — do not conflate** (user correction 2026-07-11):
  1. **Preventive-fix / mechanism work goes through Dock orchestration ONLY**
     (framework scripts, gates, validators, hooks, CI, process rules). The PM
     or Artisan must not author it directly — dispatch a role, run
     Guardian + Observer, integrate via the merge gate.
  2. **PM- or Artisan-authored work of ANY kind still requires Guardian +
     Observer** before it is considered landed — the PM's own diff review is
     never a substitute for the gates. (Supersedes the DEC-090/DEC-093
     risk-class-only gate scope for the PM-directed route.)
- The PM never implements in `_crew/pm/` paths; recurring PM hand-work is a
  framework defect signal — file a work item instead.
- Attended PM-as-Dock concurrency: the Dock seat writes into a dispatch
  container/worktree (proxy-commit, rework note) only when the role is NOT
  mid-run — after its register/BLOCKED message or a confirmed process exit.
  One Dock-seat occupant per `<pm_id>` world.
- **External ops (push / tag / release / publish)**: the role of record is the
  Concierge (DEC-025). Two legitimate paths: (a) **user-instructed PM-direct** —
  in an attended session the PM may execute the external op itself when the
  user explicitly instructs/authorizes it; (b) **Concierge route** — everything
  else, including all unattended/autonomous external ops. A PM must never
  originate an external op without one of the two.
  - **Guardian preflight is MANDATORY on BOTH paths** (guardian W-042 finding
    7): before anything leaves the sandbox, Guardian scans EXACTLY the payload
    that will leave it — the range being pushed, the tagged tree, or the
    release artifact — for secrets, credentials, and PII. User instruction
    gates the *decision* to publish; Guardian gates the *safety* of what is
    published. Neither path may skip it, including the PM-direct path.
  - **The authorization record must be a verifiable reference**, not PM
    free-text: the user-message timestamp or a quote of the instruction, not a
    paraphrase. Log location by path (an op with no commit/release notes to
    carry it, e.g. a bare push or tag, still needs a place to record this):
    attended PM-direct logs the reference as typed Evidence on the Backlog record
    for the op; the Concierge route logs it in the concierge op record
    (`concierge_report.md` / the runtime concierge external-op result).
- `runtime/lane.lock` was **retired by W-206**. There is no fixed/default execution
  route, no route acquisition/release, and no route-derived status. PM selects an execution
  route per task. Execution routes may run concurrently; the single-integrator
  invariant is enforced only by the merge-gate critical section
  `runtime/merge_gate/locks/active.lock`. An Artisan submission includes its
  expected studio SHA; if it is stale, the Artisan forward-integrates and repeats
  the required quality, Guardian, and Observer gates before a new request.
