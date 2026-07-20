# Lane selection addendum (W-043) — new patterns + hard rules

The **canonical lane decision tree is `entry_routing.md`** (control layer /
PM-direct / artisan / dock). This addendum does not compete with it; it adds
the patterns and rules decided 2026-07-11 that the router does not yet cover.
Consult this from the PM/Dock seat when dispatching.

## Added patterns

| Situation | Pattern |
| --- | --- |
| External seat wanted (cost / parallel capacity) and the task is edit+gate shaped | **codex producer seat** — launch ONLY via the `launch_cmd` emitted by `dispatch_prepare`; `commit_mode=proxy` (W-042): the producer never runs `git add/commit` (its sandbox re-pins `.git`/gitdir read-only after `--add-dir` — upstream openai/codex #14338/#15505/#18918); it reports a commit plan; the Dock proxy-commits it after two mandatory checks (guardian W-042): reconcile the actual changed files against the declared `--touches` scope (refuse/escalate on out-of-scope hooks/CI/.gitattributes/.gitignore/validator paths — never commit blind), and write the `Garelier-Seat: codex <model> (proxy-commit via dock seat)` trailer from the dispatch JSON (authoritative), not from the plan text. Gates then review that SHA. Flip back with `--commit-mode self` / `GARELIER_EXTERNAL_SEAT_COMMIT=self` when the upstream opt-in lands. Details: `codex_worker_playbook.md` |
| Standalone advisory audit NOT bound to a dispatch (plan coverage, perf sweep, test-debt census…) | **field investigation** (W-044): bare agent named `ga-audit-<topic>`, read-only, NO lane/branch/STATE, report to `runtime/observer/results/<topic>-audit.md`; the PM writes a disposition and commits accepted findings to `control/`. Same advisory philosophy as the Wanderer, but PM-spawned and topic-scoped |

## Hard rules (user-set, 2026-07-11)

- **TWO DISTINCT RULES — do not conflate** (user correction 2026-07-11):
  1. **Preventive-fix / mechanism work goes through the dock lane ONLY**
     (framework scripts, gates, validators, hooks, CI, process rules). The PM
     or Artisan must not author it directly — dispatch a producer, run
     Guardian + Observer, integrate via the merge gate.
  2. **PM- or Artisan-authored work of ANY kind still requires Guardian +
     Observer** before it is considered landed — the PM's own diff review is
     never a substitute for the gates. (Supersedes the DEC-090/DEC-093
     risk-class-only gate scope for the PM-direct lane.)
- The PM never implements in `_pm/` paths; recurring PM hand-work is a
  framework defect signal — file a work item instead.
- Attended PM-as-Dock concurrency: the Dock seat writes into a dispatch
  container/worktree (proxy-commit, rework note) only when the producer is NOT
  mid-run — after its register/BLOCKED message or a confirmed process exit.
  One Dock-seat occupant per `<pm_id>` world.
- **External ops (push / tag / release / publish)**: the role of record is the
  Concierge (DEC-025). Two legitimate paths: (a) **user-instructed PM-direct** —
  in an attended session the PM may execute the external op itself when the
  user explicitly instructs/authorizes it; (b) **Concierge lane** — everything
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
    attended PM-direct logs the reference in that PM's `_pm/history.md` entry
    for the op; the Concierge lane logs it in the concierge op record
    (`concierge_report.md` / the runtime concierge external-op result).
- `runtime/lane.lock` is **decided for retirement** (user decision 2026-07-11):
  the single-integrator invariant stays, upheld by the entry-routing criteria +
  judgment (attended) and by driver-level serialization (unattended) instead of
  a lock file. Until the retirement work item lands, treat an existing
  lane.lock as advisory state, not as the mechanism of record. **The drift
  surface is 40+ files, not just "docs mirrors + driver + artisan skill"**
  (observer W-042 coherence check 2 — that undercounted scope line is
  retired); the retirement work item must cover at least these load-bearing
  sites, ranked:
  - `entry_routing.md:76,79` — the **canonical router itself** still
    describes lane.lock as the mechanism ("the heavy lanes (dock, artisan)
    arbitrate that with `runtime/lane.lock`"); until fixed this contradicts
    this addendum's "advisory, not mechanism of record" and is the
    highest-priority site.
  - `state_machine.md:347,350,357,476,481` — the Artisan **acquires / holds /
    releases** `lane.lock` across IDLE→REPORTING; the most load-bearing site
    (state-machine semantics the artisan skill implements and the driver
    reads).
  - `protocol.md:103` ("Active lane arbiter"), `:435` (writer table), + the
    `docs/` mirror.
  - `pipeline_flow.md:72,82,88` ("invariant `runtime/lane.lock` protects") +
    its `.ja` mirror.
  - `control_contract.md:223` + its `.ja` mirror + the `docs/` mirror.
  - role skills: `garelier-pm/SKILL.md:169,176`, `garelier-dock/SKILL.md:11`,
    `garelier-artisan/SKILL.md`, `garelier-observer/SKILL.md`.
  - `references/roles-and-lanes.md`, `branches-and-layout.md`,
    `execution-and-operations.md`.
  - driver functional consumers: `driver/src/config.ts`,
    `status_snapshot.ts` (+ `.test.ts`), `dock_status.ts`, `status_types.ts`.
  - scripts: `doctor.ts`, `session_digest.ts`, `setup_wizard.ts`,
    `dispatch_prepare.ts`.
  - `docs/` narrative: `concepts.md`, `getting_started.md`,
    `operational_scenario_validation.md`, `web_console.md` (+ `.ja`).
