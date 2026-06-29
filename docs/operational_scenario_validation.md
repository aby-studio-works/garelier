# Historical Operational Scenario Validation / 運用シナリオ検証（履歴）

> **Historical document (DEC-066):** this page is a retained validation record,
> not the current execution guide. Rows that exercise the removed headless
> driver (`start_driver` / leases / driver pre-flight, for example S-24,
> S-29, and S-30) are historical evidence only. The live execution model is
> dispatch + jig plus interactive Dock/PM operation; see
> `docs/execution_backends.md` and
> `skills/garelier-core/references/role_subagent_dispatch.md`.


> Date: 2026-05-27
>
> Purpose: judge whether Garelier can carry realistic engineering flow
> and miscellaneous operational work, assuming irregular stops happen and
> recovery must be possible.

## Current Model Mapping

| Historical term in this record | Current interpretation |
| --- | --- |
| Headless driver / `start_driver` / driver pre-flight | Removed execution backend. Use dispatch + jig and interactive Dock/PM operation. |
| Driver leases and restart recovery | Historical restart mechanics. Current recovery is based on file handoff, role state, dispatch manifests, and jig checks. |
| Driver provider switching | Historical autonomous scheduling concern. Current role execution is launched explicitly by dispatch paths. |
| Driver status helpers | Use the current dispatch/jig status and project status surfaces documented in `docs/execution_backends.md`. |

## Conclusion

Historically, Garelier could carry ordinary implementation work, verification work,
investigations, recurring checks, and guarded operational tasks when the
target project provides its own quality gate, credentials, and
data-change policy.

The historical design was recoverable because coordination state is file-based:
blueprints and accepted inspections live in `control/`, live execution
state lives in `runtime/`, role work is isolated by worktree, and the
removed driver cold-started each role from those files. The current model keeps
the file-based recovery premise, but execution is dispatch + jig instead of a
headless driver.

Limits:

- Garelier does not make irreversible external writes atomic. A
  production data-changing task still needs project-specific dry-run,
  rollback, before/after counts, sample records, and explicit user
  approval for each execution.
- Garelier is not a universal webhook receiver or scheduler. External
  adapters must normalize work into PM inbox/request files.
- Provider availability is outside the framework. In the current model, the
  selected CLI/provider for each dispatched role must be installed and logged
  in on the machine running it.

## Validation Method

This is a design-and-smoke validation against the framework repository.
The framework repo has no target application, so real project
end-to-end execution is represented by contract checks and temporary
synthetic target repos where possible.

Historical evidence reviewed:

- Role model and task boundaries: `docs/concepts.md`
- File ownership and compact handoff: `docs/protocol.md`,
  `docs/compact_handoff.md`
- Historical driver scheduling, provider config, wait-state token guard:
  `skills/garelier-core/driver/README.md`
- Smith/Anvil and mixed-provider decisions: DEC-013, DEC-014
- Merge gate contract: DEC-007,
  `skills/garelier-core/scripts/merge-gate.sh`

Verdict labels:

- Pass: framework path exists and recovery is defined.
- Conditional pass: framework path exists, but target-project policy or
  external system behavior is decisive.
- Gap fixed: validation found a defect and this validation cycle fixed
  it.

## Historical Scenario Matrix

| ID | Scenario | Primary roles | Irregular stop injected | Recovery path | Verdict |
| --- | --- | --- | --- | --- | --- |
| S-01 | Implement a normal code task from user request to promote readiness | PM, Dock, Worker, optional Smith | Driver killed after Worker writes `report.md` but before Dock reviews | Worker remains `REPORTING`; driver restart sees marker/state files; Dock consumes report, merge gate runs; promote remains user-gated | Pass |
| S-02 | Bugfix with failed test and rework | Dock, Worker | Quality gate fails after workbench merge attempt | Merge gate aborts the merge and writes `result.status=failed`; Dock writes `review.md`; Worker enters `REWORK` | Pass |
| S-03 | Multiple Workers produce parallel work while merge gate is busy | Dock, Workers | Driver killed while Worker child and merge subprocess are active | Agent JSON lease pid and merge-gate `active.lock` pid are checked on restart; live subprocesses are not duplicated; dead merge subprocess without result becomes synthetic `aborted` | Pass |
| S-04 | GUI test exclusivity: reduce active Worker pool to one without cancelling tasks | PM, Dock, Worker | User removes active Workers while tasks are in progress | PM uses retire-and-requeue: no `abort.md`, same task id returns to `pending.md`, history outcome is `requeued`; setup wizard removal requires explicit requeue flag | Pass |
| S-05 | Claude Code rate-limited, continue under Codex CLI | Driver, all roles | Provider returns 429/rate-limit during role iteration | Driver records `rate_limited`, invalidates mtime snapshot, backs off, and retries; operator can edit provider/model/effort before driver restart | Pass, if Codex CLI is logged in |
| S-06 | Non-code research, market check, status report, or accounting read-only check | PM, Dock, Scout | Driver killed while Scout is `REPORTING` | Scout draft remains in its worktree; PM commits accepted inspection; driver does not respawn Scout until `committed.md` or `abort.md` appears | Pass |
| S-07 | Full test pass, benchmark, deploy health check, or external API read-only probe | Dock, Scout | Long command finishes after driver was stopped | Scout/inspection files are the handoff; restart resumes from state files. External command output must be captured into the inspection | Conditional pass: external command must be read-only or covered by data-change guards |
| S-08 | Production data mutation: database update, API write, destructive filesystem change | PM, Worker, Scout, Dock | Process stops mid-run during production execution | Framework gates require dry-run, rollback plan, before/after counts, sample records, and per-run user approval; report records actual outcome | Conditional pass: project script must provide transaction/idempotency/rollback; framework cannot guarantee external atomicity |
| S-09 | Worker merge with manual conflict resolution needs post-merge hardening | Dock, Smith | Smith is killed while Anvil work is in progress | Smith state and Anvil branch remain; driver restarts from files, or PM can retire-and-requeue without `aborted`; promote is blocked while Smith target count is non-zero | Pass |
| S-10 | Worker merges continue while Smith is busy; Smith later validates accumulated window | Dock, Workers, Smith | Driver restarts after several Worker merges and one busy Smith | `smith_targets: #task@sha` tokens in backlog/assignment keep pending and active counts parseable; `dock_status.ts` exposes remaining target count | Pass |
| S-11 | Target-project docs consistency, license, security, or compliance check | Dock, Smith, Scout | Check stops before completion | If no commit is needed, use Scout inspection; if integrated fixes are needed, use Smith Anvil branch. Undecided policy escalates to PM | Pass |
| S-12 | Delegated request or scheduled job triggers work | PM, request/scheduler adapters, Dock | Adapter or driver stops after writing runtime inbox item | Request/job is normalized into `runtime/requests/` or `runtime/pm/inbox/`; PM converts to blueprint/inspection/work as usual | Conditional pass: external receiver/scheduler must follow the guarded contract |
| S-13 | Promote to target after several tasks | PM, Dock, Smith | Stop happens after studio is ready but before user approval | Promote remains blocked until explicit user instruction; checklist verifies clean studio, merged/abandoned workbenches, zero Smith targets or waiver, and no pending data write | Pass |
| S-14 | Idle autonomous driver over long periods | Driver | Driver restarted while no files changed and agents are waiting | `runtime/driver/change_tracker.json` prevents no-op cold-start provider calls; marker-waiting roles are skipped until files change; live detached leases are skipped until they finish | Pass |
| S-15 | Merge gate result visibility and failure classification | Driver, Dock, merge gate | Merge gate subprocess exits quickly before next Dock tick, or a quality-gate command exits non-zero | Subprocess archives only request; result/log stay visible for Dock. Validation found the merge gate archived result/log too early and classified quality-gate failure as `aborted`; fixed in this cycle | Gap fixed |
| S-16 | Multiple PMs in the same target project | PMs, driver, merge gate | Merge gate runs while another PM tree exists | Driver is single-PM per process; merge gate now reads `setup_config.toml` from the request's own PM tree, not the first sibling PM | Pass |
| S-17 | Dirty primary checkout or partial merge left by an interrupted run | PM, Dock, driver | `.git/MERGE_HEAD`, stale `driver.pid`, or stale merge-gate lock remains | PM pre-driver audit removes stale pid/stop/lock, aborts orphan merge state, categorizes dirty files, and escalates unknown changes | Pass, with user approval for unknown destructive cleanup |
| S-18 | Artisan takes one task end-to-end on `satchel` and integrates it into `studio` with mandatory Guardian + Observer review (DEC-045) | PM, Artisan, Guardian, Observer | Driver killed after quality/coverage audits pass but before studio integration | Artisan holds `runtime/lane.lock`; on restart it resumes from checkpoint, forward-integrates studio, obtains Guardian then Observer verdicts pinned to studio/satchel SHAs, and merges only while they remain current; lane.lock released at REPORTING | Pass |
| S-19 | Mandatory Observer review returns BLOCK and the merge gate refuses the merge | Dock, Observer, merge gate | Observer reports `BLOCK`; Dock (or a faulty request) still dispatches the merge gate with `observer_required: true` | Merge gate reads the verdict from the Observer `report.md` (not the request's claim) and writes `result.status=failed` with an observer-gate reason without merging; BLOCK escalates to PM and is never waivable | Pass |
| S-20 | Observer returns PASS_WITH_NOTES; merge proceeds and the accepted observation is persisted | Dock, Observer, PM | Driver killed after the merge succeeds but before the observation is committed | Merge gate merges (verdict is passing); the Observer report stays in `_observers/<id>/archive/<request_id>/` and the accepted copy is committed under `control/observations/`; notes are logged for follow-up, not lost on restart | Pass |
| S-21 | Librarian updates registered knowledge on a `shelf` branch, merged via Dock review (DEC-018) | Dock, Librarian | Librarian killed mid-fetch / mid-edit on the shelf branch | Librarian uses the Worker state set; `shelf` branch + `_librarians/<id>/` state survive; on a fetch failure no stale overwrite occurs; Dock runs the §7.4 Librarian review then the merge gate (shelf in `workbench_branch`); registries (`source_registry`/`routine_registry`) merge through the same gate | Pass |
| S-22 | Worker requests non-binding `direction_advice` from an Observer mid-task | Worker, Observer | Driver killed while the Observer is drafting `advice.md` | Worker stays in WORKING (advice is non-binding, scope-bounded); Observer never holds `lane.lock`; if adopting the advice would change scope the Worker transitions to BLOCKED and asks Dock/PM instead; restart resumes from state files | Pass |
| S-23 | Observer request interrupted; driver restart resumes or re-issues safely | Driver, Observer, requester | Driver killed after a request lands in `runtime/observer/requests/` but before the Observer reports | Observer detached lease pid is checked on restart (live → not duplicated; dead without `report.md` → re-dispatch the same request); a report is immutable — an insufficient one is replaced by a new `request_id`, never revised; `runtime/observer/results/` is consumed at ACK | Pass |
| S-24 | Doctor blocks an unsafe launch | PM, doctor, driver | `start_driver` invoked while AGENTS.md still has `{{placeholders}}`, AGENTS.md is missing, or `[quality_gate] stack = custom` has no commands | doctor pre-flight reports the matching P0 (`placeholder-leak` / `agents-missing` / `quality-gate`) and `start_driver` refuses unless `--force`; `--agents-policy minimal` avoids the placeholder P0 up front | Pass |
| S-25 | Fresh-setup guard rails | PM, setup wizard | fresh run in a repo with no commits, against an already-complete `__garelier/<pm_id>`, or with `stack=custom/mixed` and no `--quality-gate` | wizard refuses with a guided message (commit first / `--mode diff` / pick another `--pm-id` / supply commands); a detected partial install prompts cleanup before re-init | Pass |
| S-26 | Diff-mode removal of a busy agent | PM, setup wizard | `--mode diff` drops a Worker/Scout/Smith/Librarian/Observer, or `--no-artisan`, while that agent is non-IDLE | wizard exits 2 listing the blocked agents; removal proceeds only after PM retire-and-requeue (task → `pending.md`, Outcome: requeued) with `--allow-requeued-removal`; the flag never edits the backlog itself | Pass |
| S-27 | Scheduled job double-fire / production write | scheduler adapter, PM, Worker | the external clock fires the same RRULE job twice, or a job's work mutates production data | the per-job lock under `runtime/scheduled_jobs/locks/` dedupes the run; any data mutation still goes through the S-08 guards (dry-run, rollback, before/after counts, per-run approval) | Conditional pass: the external scheduler must honor the lock contract |
| S-28 | Delegated request duplicate / forbidden source / priority | request_intake, PM | the same request branch is ingested twice, arrives from an unlisted source, or carries a priority field | request_intake dedupes by request id, rejects sources not in `allowed_sources.toml` into `runtime/requests/rejected/`, and PM honors the priority when ordering backlog pickup (DEC-010) | Conditional pass: the receiver/transport must follow the guarded contract |
| S-29 | start_driver pre-flight cleanup | driver, PM | a stale `merge_gate/locks/active.lock` (dead pid), an orphan `.git/MERGE_HEAD`, or a dirty checkout is present at launch | the shell-level subset removes the stale lock, aborts the orphan merge state, and WARNS (does not auto-fix) on dirty PM-owned files before launching; full classification is PM's §13.4 audit | Pass, with user review of dirty files |
| S-30 | Bun missing at launch | driver, doctor | `start_driver` invoked on a host without Bun installed | the doctor pre-flight runs FIRST, so config problems are surfaced even with no Bun; the `'bun' not found` error (with an install hint) comes only afterward, just before launch | Pass |
| S-31 | Provider rate-limit recovery | driver | repeated 429 / rate-limit responses during role iterations | driver records `rate_limited`, invalidates the mtime snapshot, backs off and retries, and surfaces it in `status`; the operator may switch provider/model before restart (extends S-05) | Pass, if a fallback provider is logged in |
| S-32 | User stop then restart | driver, PM | user touches `runtime/driver/stop` (or PM `/quit` fires the SessionEnd hook) mid-run | the driver stops cleanly after the current detached lease; restart reconciles from STATE / lease files and re-removes the stop marker; no duplicate spawns | Pass |
| S-33 | Stale detached lease on restart | driver | a role lease `.pid` remains after a crash but its pid is dead | the driver detects the dead lease, removes it, invalidates that role's mtime snapshot, and re-evaluates the role from its `STATE.md` (live leases are left untouched) | Pass |
| S-34 | Mandatory Observer review missing on a large / protected merge | Dock, merge gate | Dock dispatches the merge gate WITHOUT `observer_required` for a diff that `[observer_policy]` mandates (large diff / protected path) | the merge gate's mechanical backstop (`observer_policy_check`) computes the trigger from the diff and writes `result.status=failed` unless a passing Observer verdict accompanies the request — independent of the LLM remembering the §7.5 hook | Pass |

## Guardian Gate Scenarios (DEC-024)

These exercise the security gate's **verdict**, not recovery (Guardian is
commit-free and produces a point-in-time verdict). `[guardian_policy].enabled =
true` and a mandatory trigger are assumed.

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| G-01 | Secret added to `.env.example` | Guardian delta gate BLOCKs **before** the Observer review; merge gate refuses on the guardian verdict; evidence is redacted / pointer-only |
| G-02 | Private key committed accidentally | BLOCK (`block_on_private_key`); `incident_response_runbook.md` → rotate + history scrub; the value is never reprinted |
| G-03 | Customer email in a fixture | BLOCK, unless a sanitized-fixture entry in `false_positive_exceptions.toml` covers it |
| G-04 | `Cargo.lock` adds a critical vulnerability | BLOCK (`block_on_critical_vulnerability`) with no recorded exception |
| G-05 | `package-lock` adds a high vuln with an accepted exception | PASS_WITH_NOTES (exception in `vulnerability_exceptions.toml`) |
| G-06 | Forbidden license introduced (GPL / AGPL) | BLOCK (`license_denylist`) |
| G-07 | CI workflow adds a `curl \| sh` deploy step | BLOCK or PM escalation (`security_sensitive_paths`: `.github/workflows/**`) |
| G-08 | Worker report claims no security impact but the diff touches auth | `guardian_required` fires via the mechanical backstop; the gate runs regardless of the report's claim |
| G-09 | A required secret scanner is missing | Default: BLOCK (`block_when_required_scanner_unavailable`) for the mandatory secret/PII gate; dependency/license fall to NO_OPINION + notes. PM-approved degraded mode (`secret_scan = "off"` + `block_when_required_scanner_unavailable = false`) may continue with PASS_WITH_NOTES/NO_OPINION and must disclose that full scanner coverage was disabled |
| G-10 | Guardian finds a false positive | emits `knowledge_update_request.md`; Librarian updates the registry after PM approval; Guardian never allowlists inline |
| G-11 | Smith remediation changes a lockfile | Guardian final gate re-runs (`require_for_lockfile_changes`) |
| G-12 | Artisan premerge into `studio` | guardian delta/final gate required first (`require_for_artisan_premerge`) |
| G-13 | Promote request | guardian promote_gate required (`require_for_promote`) |
| G-14 | Guardian report contains an unredacted secret-like value | doctor P0 `guardian-report-leak` (output safety): scans `_guardians/*/guardian_report.md` + `runtime/guardian/{results,inbox}/*` for high-confidence secret formats (private keys, cloud/provider tokens, JWTs); redaction placeholders never match (doctor.sh, DEC-024) |
| G-15 | An old Guardian verdict reused after a new commit | merge gate reads the verdict from the report (a request can't claim a PASS the report lacks) AND binds it to `review_sha`: when the report's `review_sha` ≠ the live workbench tip, the verdict is refused as stale (merge_gate_parse.ts + merge-gate.sh, DEC-024) |

## Concierge External-Operation Scenarios (DEC-025, Phase 1)

Phase 1 = promote execution moved off PM onto the Concierge. `[concierge_policy]`
enabled with a configured `[[concierges]]` is required; without one, promote is
blocked.

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| C-01 | User asks PM to promote; Guardian promote_gate PASS | PM base-tracks studio, writes a `promote_target` Concierge assignment; Concierge merges studio→`<target>` in its worktree, runs the quality gate on the merged tree, tags, `git push origin <target> --tags`; reports before/after SHA |
| C-02 | Promote with Guardian verdict BLOCK / missing / stale | Concierge does **not** merge or push — BLOCK to PM (consumes the verdict, never re-judges; the DEC-024 `review_sha` stale check applies) |
| C-03 | Live `<target>` tip ≠ `expected_target_sha` (drift) | Concierge BLOCKs before any write (`git_remote_policy.md` drift rule) — no overwrite |
| C-04 | Quality gate fails on the merged tree | Concierge aborts the merge, does not tag/push, BLOCKs to PM with the output; never silently retries |
| C-05 | The promote would require pushing a `garelier/*` branch or a force-push | Refused (`forbid_push_garelier_branches` / `forbid_force_push`); doctor flags either flag set false as P0 (`concierge-safety`) |
| C-06 | `sync_remote` requested | read-only `git fetch --prune` / status / log only; a merge/rebase/push needs an explicit assignment line; `git pull` is forbidden |
| C-07 | `[concierge_policy].enabled = true` but no `[[concierges]]` | doctor P0 `concierge-policy` (external ops enabled with no executor) |
| C-08 | `concierge_report.md` carries an unredacted secret-like value | doctor P0 `concierge-report-leak` (output safety; same high-confidence scan as G-14) |
| C-09 | A ticket investigation reveals real source changes are needed | Concierge stops and hands back to PM (never implements code); PM dispatches a Worker |
| C-10 | No Concierge configured at promote time | Promote BLOCKs until Concierge is configured; PM never executes the target merge |
| C-11 | `create_pr` requested but `create_pr` not in `allowed_operation_kinds` | refused — Phase 2 ops are off unless explicitly granted; no external write |
| C-12 | `create_pr` with `gh` / `glab` unavailable | `NO_OP` report naming the missing CLI + BLOCK; nothing is pushed or opened (provider-parity safe degradation) |
| C-13 | `create_pr` after a passing Guardian safe-to-publish verdict | pushes the head to `pr/<pm_id>/<slug>` (never `garelier/*`, no force), opens the PR with a body from `pull_request_body.md`; reports PR URL + head SHA |
| C-14 | A PR body would contain a secret / internal `__garelier/` path | refused / redacted — published text is pointer-only (`pull_request_policy.md`) |
| C-15 | `create_release` with fixed `tag` + `target_sha`, Guardian PASS, artifact scan PASS | tags `target_sha`, `git push origin <tag>` (no force), `gh/glab release create`; reports release URL, tag SHA, artifact hashes |
| C-16 | `create_release` but the tag already exists on the remote | BLOCK (no clobber of a published tag/release) |
| C-17 | An artifact contains a secret / forbidden file | artifact scan BLOCKs before tag/push (`release_policy.md`); nothing is published |
| C-18 | `create_release` with `gh release` / `glab` unavailable | `NO_OP` + BLOCK; no tag pushed, no release created (provider-parity) |
| C-19 | `update_ticket` (e.g. JIRA `PROJ-123`) with a PM-fixed method | investigates the ticket (PREPARING), executes the approved transition / comment within the fixed method; reports ticket URL + new state |
| C-20 | Investigation reveals the ticket needs source changes | hands back to PM with the finding; PM dispatches a Worker — Concierge never implements code or widens scope |
| C-21 | `update_ticket` with the tracker CLI (`jira` / `gh` / `glab`) unavailable | `NO_OP` + BLOCK; the ticket is left unchanged (provider-parity) |
| C-22 | A ticket comment would contain customer data / PII | refused / redacted — the update is pointer-only (`ticket_policy.md`) |
| C-23 | `sync_remote` (read-only, Phase 1) | `git fetch --prune` + status / log / diff only; reports divergence; no merge/rebase/push, no Guardian gate (writes nothing) |
| C-24 | `sync_remote` write (merge/rebase/push) without an explicit assignment command | refused — the write tier runs only the exact command the assignment names; read-only is the cap otherwise |
| C-25 | `sync_remote` write that would need `git pull` or a force-push | BLOCK — `fetch` + a named merge/rebase only; never `git pull`, never `--force`, never a `garelier/*` push (`sync_remote.md`) |
| C-26 | `check_external_ci` | read-only CI status (`gh run list` / `gh pr checks` / `glab ci status`); reports state to the requester, writes nothing (no Guardian gate); `NO_OP` + BLOCK if the platform CLI is absent |
| C-27 | Concierge crashes after a promote merge+push but before REPORTING | on restart it **reconciles** (SKILL §10.5): `git fetch`; `<target>` already contains the merge → finishes `concierge_report.md` (`DONE`); **no re-merge, no re-push** |
| C-28 | Concierge crashes after `gh pr create` but before REPORTING | on restart the idempotency check finds the open PR for the head (`gh pr list --head pr/<pm_id>/<slug>`) → updates / reports instead of opening a **duplicate** PR (`create_pr.md` step 6) |
| C-29 | A Concierge died holding a target-scoped external lock | next Concierge for the **same** target reclaims the **stale** lock (dead pid) at pickup; a **live** same-target lock → BLOCK; ops on **different** targets are unaffected (target-scoped, SKILL §5); doctor flags the stale lock P1 |
| C-30 | The driver is stopped while a detached Concierge is mid external write | the background child is **not killed** — it finishes the push + report; to abort an in-flight operation use `abort.md` (→ ABORTED), not a driver stop |
| C-31 | Two Concierge operations on **different** targets (e.g. a PR vs a release) | run in parallel — the lock is target-scoped (`pr__…` vs `release__…`); only operations on the **same** target serialize (SKILL §5) |
| C-32 | An Artisan crashed leaving `lane.lock` (dead pid), Artisan STATE not active | the driver auto-clears the provably-orphaned lock (`stale_lane_lock_cleared`) so the dock lane is not blocked; if the Artisan STATE is still active, the lane is kept so the Artisan resumes its own task instead |

## Role Knowledge Tree Scenarios (DEC-029)

Librarian-managed reference knowledge in the `{security,engineering,
quality,review,system}/` knowledge trees, seeded by the wizard. Roles READ the trees; only the
Librarian edits them (PM-approved, on a `shelf` branch). No new "convenience"
Skills; no external skill/web text copied.

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| K-01 | Worker hits a repeated quality-gate failure / flaky test | reads `engineering/debugging_principles.md` + `quality/flaky_test_policy.md`; either fixes with a regression case, or BLOCKs with evidence — never a convenience PASS or a hidden workaround |
| K-02 | Smith integration hardening | reads `quality/test_strategy.md`; reports the chosen test level (unit/contract/integration/system/smoke/regression) and evidence; does not fill missing feature scope |
| K-03 | Observer Artisan premerge review | reads `review/user_perspective_review.md` + `system_impact_review.md`; fills the User-perspective / System-impact report sections; raises concerns but makes no PM/product decision |
| K-04 | Guardian security gate, policy gap found | reads `security/index.md` + assignment-named policies; files a `knowledge_update_request.md` (does NOT edit the security tree, does NOT inline-allowlist) |
| K-05 | A PM-approved external practice should be adopted | Librarian refuses a raw copy; applies `security/provenance_rights_policy.md`; registers the PM-approved source (`source_registry.toml`, with authority/license/use/last_reviewed_at) and writes original, generalized project knowledge |
| K-06 | A new "convenience" Skill dir (e.g. `skills/garelier-debugging/`) is added | `ci.sh` role-knowledge-trees lint FAILs (forbidden knowledge-as-Skill); knowledge belongs in the knowledge trees |
| K-07 | A seeded tree loses its `index.md` (or a project never seeded one) | doctor P1 `knowledge-tree-index` (broken tree) / P2 `knowledge-tree-missing` (not seeded) — re-run the wizard or restore from the Librarian template |
| K-08 | Any role is about to commit a secret / PII / customer data | pre-commit hygiene (`security/commit_hygiene_policy.md`, `correct_operation.md` item 11) catches it before the commit; if already committed locally, treat as compromised → redact + rotate; the Guardian gate is the backstop, not the first line |
| K-09 | A knowledge bundle contains `license = "unknown"` or `license = "not-adoptable"` | `knowledge_export` refuses the bundle; missing license metadata remains a manifest warning so legacy internal docs are visible but not silently treated as externally cleared |
| K-10 | Blueprint requests `Test discipline: tdd` for Worker/Artisan work | assignment carries `Mode: tdd`; role_index trigger loads `quality/test_driven_development.md`; report records focused test, red evidence, green evidence, and refactor status |

## Historical Recovery Coverage

Historically recoverable without losing task intent:

- Driver crash or terminal close.
- Provider CLI non-zero exit, timeout, or rate-limit.
- Worker/Scout/Smith waiting for review, answers, commit marker, merge
  marker, or clean stop marker.
- Merge-gate subprocess death before result write.
- Active Worker/Scout/Smith pool replacement where the user wants the
  task returned to `pending` instead of `aborted`.
- Smith backlog pressure after rolling Worker merges.
- Artisan-lane task interrupted mid-flight; `lane.lock` keeps the dock
  lane parked until the Artisan resumes or PM clears it.
- Mandatory Observer review missing or non-passing — the merge gate refuses
  the merge mechanically (does not depend on the LLM remembering the hook).
- Observer request interrupted before a verdict; re-dispatched safely, and
  reports are immutable (replaced by a new request, never revised).

Requires PM/user decision:

- Unknown dirty source changes in the primary checkout.
- Ambiguous merge conflicts.
- Undecided license/security/compliance policy.
- Any production or destructive external write.
- Promotion to the user-owned target branch.

Not guaranteed by the framework alone:

- Transactional rollback for third-party systems.
- Availability or authentication of provider CLIs.
- Correctness of target-project quality-gate commands.
- Safety of custom external schedulers/webhook receivers that bypass
  the documented request-intake contract.

## Historical Result

This validation record found the framework sufficient for broad day-to-day
engineering and miscellaneous PM-managed operations under the historical driver
model, with the following operating model:

1. Code changes go through Worker before studio, and Smith after studio
   when integrated hardening is needed.
2. Non-code investigations and read-only checks go through Scout
   inspections.
3. Destructive or production mutations are allowed only through the
   data-change gate.
4. The removed driver could be stopped and restarted; persistent files,
   marker files, and mtime snapshots prevented both lost state and idle token
   burn.
5. Promotion remains an explicit user-approved boundary.

## Local Checks

2026-05-27:

- Temporary target repos verified `merge-gate.sh` and
  `merge-gate.sh` success paths keep result/log files visible and
  archive only the request.
- Temporary target repos verified quality-gate
  failures produce `status:"failed"` result JSON, not `aborted`.
- Each temporary repo included a sibling PM with a wrong target branch;
  both scripts read the request PM's own `setup_config.toml`.
- Temporary target project verified a Worker launched as a detached child
  with `runtime/driver/pids/worker-w01.pid`, a second `--once` skipped
  duplicate launch while the PID was alive, and a later `--once`
  consumed the finished lease.
- `garelier status` was smoke-checked against JSON agent
  leases.
