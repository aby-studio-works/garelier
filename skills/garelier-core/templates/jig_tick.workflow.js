// Jig tick — Mode E (DEC-062) Phase 1 template, hardened by live dispatch runs
// (2026-06-11): every step below that is code was a step the prose tick lost
// in practice (worktree not cut from studio; merge request missing verdicts /
// merge_message; RECORD skipped so the Status Web showed nothing).
//
// The Dock substitutes {{placeholders}} and runs ONE tick:
// DISPATCH → GATE (Guardian→Observer) → INTEGRATE. LOW/NORMAL review depths;
// CRITICAL items PARK to PM (Phase 2). DEC-061 invariants hold: runs inside the
// attended session; human gates park, never auto-decide; promote out of scope.
// DEC-083: the mechanical merge tail (merge_request → await → record → cleanup)
// runs deterministically in dock_integrate.ts, driven by ONE thin journaled agent
// in the Integrate phase — no schema-bearing merge agent to drop StructuredOutput.
//
// args: { items: [{ id?, role, slug, assignmentPath, criticality }] }
// (id optional — dispatch_prepare claims one when absent).
export const meta = {
  name: 'ga-tick',
  description: 'One deterministic dock-lane tick: prepare → produce → Guardian→Observer → dock_integrate (merge gate + record + cleanup) (DEC-062/083)',
  phases: [
    { title: 'Dispatch', detail: 'dispatch_prepare + producers in isolated worktrees' },
    { title: 'Gate', detail: 'Guardian then Observer, fixed order, verdicts as artifacts' },
    { title: 'Integrate', detail: 'dock_integrate.ts — zero-LLM merge_request + await + record + cleanup (DEC-083)' },
    { title: 'Smith', detail: 'accumulated-window hardening when the merge window is due (DEC-069)' },
  ],
}

const PROJECT = '{{project_root}}'
const PM_ID = '{{pm_id}}'
const CORE = '{{garelier_core_dir}}'           // skills/garelier-core
const FAN_OUT_CAP = {{jig_fan_out_cap}}        // [jig] fan_out_cap
const MAX_REWORK = {{jig_max_rework_rounds}}   // [jig] max_rework_rounds
const SMITH_EVERY = {{jig_smith_batch_every}}  // [jig] smith_batch_every (0 = disabled)
const DEPTH = { low: '{{jig_depth_low}}', normal: '{{jig_depth_normal}}' } // [jig.review_depth]

const VERDICT = {
  type: 'object', required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'PASS_WITH_NOTES', 'REWORK_RECOMMENDED', 'BLOCK', 'NO_OPINION'] },
    summary: { type: 'string' },
  },
}
// Worker-requested direction advice (DEC-019; honors
// observer_policy.allow_worker_direction_request). The Observer's reply is
// ADVISORY (non-binding) and scope-bounded (HOW, never WHAT/acceptance).
const ADVICE = {
  type: 'object', required: ['advice'],
  properties: { advice: { type: 'string' } },
}
const PRODUCER_RESULT = {
  type: 'object', required: ['state', 'branch', 'sha', 'reportPath', 'summary'],
  properties: {
    state: { type: 'string', enum: ['REPORTING', 'BLOCKED', 'NEEDS_ADVICE'] },
    branch: { type: ['string', 'null'] },
    sha: { type: ['string', 'null'] },
    reportPath: { type: ['string', 'null'] },
    summary: { type: 'string' },
    dispatchId: { type: ['number', 'null'] },
    adviceQuestion: { type: ['string', 'null'] },  // set when state=NEEDS_ADVICE
  },
}
// W-033: the dispatch_prepare.sh output line (id/worktree + W-026 routing decision).
// The tick runs dispatch_prepare in a mechanical PREPARE agent BEFORE spawning the
// produce agent, so the resolved model/effort can be applied to the produce agent()
// call — a produce agent cannot re-route its own already-running model. `model` is
// already clamped to the PM ceiling (deny/ask), so this unattended path uses it
// verbatim; `needs_confirmation` + `suggested_model` are surfaced (log) only.
const PREPARE_RESULT = {
  type: 'object', required: ['id', 'checkout', 'branch'],
  properties: {
    id: { type: 'number' },
    container: { type: ['string', 'null'] },
    checkout: { type: 'string' },
    branch: { type: 'string' },
    base_sha: { type: ['string', 'null'] },
    label: { type: ['string', 'null'] },        // canonical produce:<slug> label (workflow-naming §4)
    agent_name: { type: ['string', 'null'] },   // ga-produce-<slug> (bare-Agent form, §5)
    model: { type: ['string', 'null'] },        // resolved (ceiling-clamped) model; "" = inherit
    effort: { type: ['string', 'null'] },       // resolved effort; "" = inherit (jig/Workflow path honors it)
    model_source: { type: ['string', 'null'] },
    suggested_model: { type: ['string', 'null'] },
    needs_confirmation: { type: ['boolean', 'null'] },
  },
}
// W-033: per-tick gate-seat routing (W-026). Gate/judge seats are forced to the
// strong tier by the resolver regardless of the item, so it is resolved ONCE and
// reused for every item's Guardian/Observer/refuter agent. Empty model = inherit
// (full back-compat when [model_routing] is absent).
const GATE_ROUTE = {
  type: 'object',
  properties: {
    guardian: { type: ['object', 'null'], properties: { model: { type: ['string', 'null'] }, effort: { type: ['string', 'null'] } } },
    observer: { type: ['object', 'null'], properties: { model: { type: ['string', 'null'] }, effort: { type: ['string', 'null'] } } },
    refuter: { type: ['object', 'null'], properties: { model: { type: ['string', 'null'] }, effort: { type: ['string', 'null'] } } },
  },
}
// W-033: contract_check.ts (W-022) result — mechanical completion-contract check on
// a producer that returned REPORTING (committed past base, STATE closed out, report
// no longer the scaffold). ok=false carries a ready-to-use Japanese `nudge`.
const CONTRACT_RESULT = {
  type: 'object', required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    mode: { type: ['string', 'null'] },
    violations: { type: ['array', 'null'], items: { type: 'object' } },
    nudge: { type: ['string', 'null'] },
  },
}
// DEC-082 fix-1: INTEGRATE now AWAITS the merge gate's terminal result (via
// dock_merge.ts await), so the tick completion = merge DONE, not merge enqueued.
const MERGE_RESULT = {
  type: 'object', required: ['status'],
  properties: {
    request_id: { type: ['string', 'null'] },
    status: { type: 'string' },  // success | failed | conflict | aborted | timeout
  },
}

// DEC-083: the deterministic dock_integrate.ts batch result (one thin journaled
// agent runs the whole zero-LLM merge tail for all GATED branches). No status to
// drop in the merge PATH; this schema is only the advisory summary the tick folds.
const INTEGRATE_BATCH = {
  type: 'object',
  properties: {
    integrated: { type: 'array', items: { type: 'object' } },
    enqueued: { type: 'array', items: { type: 'object' } },
    mergeFailed: { type: 'array', items: { type: 'object' } },
    integrateError: { type: 'array', items: { type: 'object' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

// args may arrive as a JSON-encoded STRING depending on the invoker — tolerate
// both (live-run lesson: a string args made items undefined and the tick a no-op).
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const items = (A.items || []).slice(0, FAN_OUT_CAP)
const overCap = (A.items || []).slice(FAN_OUT_CAP)
  .map((x) => ({ ...x, parked: 'over fan_out_cap — requeue next tick' }))

phase('Dispatch')
log(`jig tick: ${items.length} item(s) within fan_out_cap=${FAN_OUT_CAP}`)

// PREFLIGHT — doctor gate + base health (live-run lesson: two producers
// independently diagnosed the same pre-existing breakage). One read-only
// agent: doctor P0 PARKS the whole tick (never dispatch onto a broken
// install); the base-health heuristic is advisory and feeds the producers.
const PREFLIGHT = {
  type: 'object', required: ['doctorP0', 'baseKnownGreen'],
  properties: {
    doctorP0: { type: 'boolean' },
    doctorSummary: { type: ['string', 'null'] },
    baseKnownGreen: { type: 'boolean' },
    tipSha: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
    itemsCheck: {
      type: ['array', 'null'],
      items: {
        type: 'object', required: ['slug'],
        properties: {
          slug: { type: 'string' },
          park: { type: 'boolean' },
          thin: { type: 'boolean' },
          why: { type: ['string', 'null'] },
        },
      },
    },
  },
}
const pre = items.length === 0 ? null : await agent(
  `Mechanical check, no judgment, read-only. In ${PROJECT}: ` +
  `1. Run: bash ${CORE}/scripts/doctor.sh --pm-id ${PM_ID} --project ${PROJECT} — doctorP0=true ` +
  `iff it exits nonzero (P0 findings); put its Summary line in doctorSummary. ` +
  `2. STUDIO=$(grep '^integration' __garelier/${PM_ID}/_pm/setup_config.toml | cut -d'"' -f2). ` +
  `3. TIP=$(git rev-parse --short "$STUDIO"); SUBJ=$(git log -1 --format=%s "$STUDIO"). ` +
  `4. Read the newest non-summary __garelier/${PM_ID}/runtime/merge_gate/results/*.json status. ` +
  `Return baseKnownGreen=true ONLY IF the newest result is "success" AND the tip subject ` +
  `starts with "merge " (i.e. the tip is gate-made — no manual commits after the last gate). ` +
  `Else false, with tipSha and a one-line note. ` +
  `5. Context-pack guard (DEC-071) — for each item in ` +
  `${JSON.stringify(items.map((x) => ({ slug: x.slug, role: x.role, assignmentPath: x.assignmentPath })))}: ` +
  `read the assignment file. park=true (with a one-line why) IFF the file is missing or still ` +
  `contains '{{' template placeholders (the design was never filled in). thin=true IFF the role ` +
  `is worker/smith/artisan AND neither the assignment nor the blueprint it references carries ` +
  `non-empty Context pack content (entry points / invariants / local verify) — thinness never ` +
  `parks, it only warns. Return all of them as itemsCheck.`,
  { label: 'preflight:doctor+base', phase: 'Dispatch', schema: PREFLIGHT },
)
if (pre && pre.doctorP0) {
  log(`doctor P0 — tick parked: ${pre.doctorSummary || 'see doctor output'}`)
  return {
    enqueued: [], needsRework: [],
    blockedOrParked: items.map((x) => ({ slug: x.slug, state: 'PARKED', why: `doctor P0: ${pre.doctorSummary || 'fix the install first'}` })),
    overCap,
    note: 'Doctor reported P0 findings - fix them (doctor.sh) and re-run the tick. Nothing was dispatched.',
  }
}
const BASE_NOTE = pre && pre.baseKnownGreen === false
  ? `\nCAUTION: the studio base is NOT verified green (${pre.note || pre.tipSha || 'unverified tip'}). ` +
    `Budget for pre-existing failures.`
  : ''
if (pre && pre.baseKnownGreen === false) log(`base not verified green: ${pre.note || pre.tipSha || ''}`)

// STALL-SCAN (W-034, mechanical, no judgment): a producer left WORKING by a
// prior tick/session can read as "idle" to a PM without telling apart a still-
// running cold build (false positive; the W-053 live mis-diagnosis) from a
// genuine stall. Runs every tick — including a 0-item Smith-window-only tick —
// so a leftover stall from a crashed/aborted session surfaces on the next
// invocation rather than sitting silent until someone happens to look.
const STALL_SCAN_RESULT = {
  type: 'object', required: ['ok', 'items'],
  properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'object' } } },
}
const stallScanResult = await agent(
  `Mechanical step, NO judgment, NO prose. Run EXACTLY and return its one-line JSON verbatim ` +
  `as the StructuredOutput:\n` +
  `bun ${CORE}/driver/src/dispatch/contract_check.ts --pm-id ${PM_ID} --project ${PROJECT} ` +
  `--stall-scan --format json`,
  { label: 'preflight:stall-scan', phase: 'Dispatch', schema: STALL_SCAN_RESULT },
)
const stallSuspects = ((stallScanResult && stallScanResult.items) || []).filter((x) => x && x.judgement === 'stall-suspect')
// Surface to PM ONLY when there is something to act on — build-wait/unknown
// items are expected noise on every tick and would bury the real signal.
if (stallSuspects.length > 0) {
  // escalation (W-037): contract_check.ts persists judgement history across
  // ticks and steps none -> nudge -> handoff once a dispatch stays
  // stall-suspect with an unchanged checkout diff long enough — surfaced here
  // so a genuinely stalled producer escalates on its own even on an autonomous
  // run with no PM eyeballing every tick's raw JSON.
  const nudged = stallSuspects.filter((s) => s && s.escalation === 'nudge').length
  const handoff = stallSuspects.filter((s) => s && s.escalation === 'handoff').length
  const escSuffix = (nudged || handoff) ? ` [escalation: nudge=${nudged} handoff=${handoff}]` : ''
  log(`stall-scan: ${stallSuspects.length} stall-suspect dispatch(es) — surfacing to PM: ${stallSuspects.map((s) => s.dispatch).join(', ')}${escSuffix}`)
}

// BASE-TRACKING SCAN (DEC-039 §8.6, W-061, mechanical, no judgment): the jig IS
// the autonomous Dock, so it performs §8.6's per-iteration forward-integration
// duty here — measure how far every in-flight WORKING workbench/anvil producer
// is behind the studio tip and drop an IDEMPOTENT track-target.md catch-up
// trigger (--write) when it is behind >= threshold with none already pending.
// This matters for a producer that spans ticks (warm-resume/leftover WORKING);
// a fresh dispatch cut from the studio tip this tick is never behind. The
// producer performs the merge + resolves conflicts itself at its next iteration
// boundary (Dock's no-code-writing boundary is unchanged). Runs even on a 0-item
// tick so a leftover producer keeps catching up. Best-effort: a dropped result
// or tool miss is silent (the merge-gate readiness check §8.1.A is the backstop).
const BASE_TRACK_RESULT = {
  type: 'object', required: ['scanned', 'triggered'],
  properties: { scanned: { type: 'number' }, triggered: { type: 'number' }, producers: { type: 'array', items: { type: 'object' } } },
}
const baseTrackResult = await agent(
  `Mechanical step, NO judgment, NO prose. Run EXACTLY and return its one-line JSON verbatim ` +
  `as the StructuredOutput:\n` +
  `bash ${CORE}/scripts/base_tracking_scan.sh --pm-id ${PM_ID} --project ${PROJECT} ` +
  `--write --format json`,
  { label: 'preflight:base-tracking-scan', phase: 'Dispatch', schema: BASE_TRACK_RESULT },
)
if (baseTrackResult && baseTrackResult.triggered > 0) {
  const trig = (baseTrackResult.producers || []).filter((p) => p && p.action === 'trigger')
  log(`base-tracking: ${baseTrackResult.triggered} in-flight producer(s) behind studio — dropped track-target.md: ${trig.map((p) => `${p.branch} (behind ${p.behind})`).join(', ')}`)
}

// Context-pack guard (DEC-071): an assignment still carrying {{...}}
// placeholders was never finished — dispatching it burns a producer on
// guesswork, so it is PARKED back to PM. A THIN context pack (no entry
// points / invariants / local verify anywhere) still dispatches, but the
// producer is told to budget rediscovery and record what was missing under
// "Context pack gaps" in the report — the retro digest harvests those.
const checkOf = (slug) => ((pre && pre.itemsCheck) || []).find((c) => c && c.slug === slug)
const parkedUnfilled = items
  .filter((it) => { const c = checkOf(it.slug); return c && c.park })
  .map((it) => ({ slug: it.slug, state: 'PARKED', why: (checkOf(it.slug) || {}).why || 'assignment unfilled ({{placeholders}} remain)' }))
for (const p of parkedUnfilled) log(`parked (unfilled assignment): ${p.slug} — ${p.why}`)
const dispatchable = items.filter((it) => { const c = checkOf(it.slug); return !(c && c.park) })
const THIN_NOTE = `\nNOTE: this assignment's context pack is THIN (no entry points / invariants / ` +
  `local-verify found). Budget time to derive them yourself, and record every fact you had to ` +
  `rediscover under "Context pack gaps" in the report.`

// GATE-SEAT ROUTING (W-026/W-033) — resolve the Guardian/Observer/refuter models
// ONCE per tick and reuse for every item's gate agents. The resolver forces
// gate/judge seats to the strong tier (item-independent), so one resolve suffices.
// This is how a mid-tier PM/producer stays safe: strong gates degrade gracefully
// (more rework, not bad merges). Best-effort — a miss (no [model_routing], resolver
// unavailable, dropped output) leaves the seat's opts empty = inherit the Dock model,
// exactly as before this routing existed. The PM model feeds the escalation ceiling
// (deny/ask clamp) the same way dispatch_prepare derives it.
const gateRoute = dispatchable.length === 0 ? null : await agent(
  `Mechanical step, NO judgment, NO prose. In ${PROJECT}, resolve the gate-seat model routing.\n` +
  `1. Derive the PM model for the escalation ceiling:\n` +
  `CONFIG="${PROJECT}/__garelier/${PM_ID}/_pm/setup_config.toml"; PM_MODEL="\${GARELIER_PM_MODEL:-}"; ` +
  `[ -z "$PM_MODEL" ] && [ -f "$CONFIG" ] && PM_MODEL=$(sed -n 's/^[[:space:]]*pm_model[[:space:]]*=[[:space:]]*"\\(.*\\)".*$/\\1/p' "$CONFIG" | head -1); ` +
  `[ -z "$PM_MODEL" ] && [ -f "$CONFIG" ] && PM_MODEL=$(sed -n 's/^[[:space:]]*default_agent_model[[:space:]]*=[[:space:]]*"\\(.*\\)".*$/\\1/p' "$CONFIG" | head -1); ` +
  `PMARG=""; [ -n "$PM_MODEL" ] && PMARG="--pm-model $PM_MODEL"\n` +
  `2. Run these THREE and read each JSON's "model" and "effort" fields (empty string => null):\n` +
  `bun ${CORE}/driver/src/dispatch/model_routing.ts --project ${PROJECT} --pm-id ${PM_ID} --seat guardian $PMARG\n` +
  `bun ${CORE}/driver/src/dispatch/model_routing.ts --project ${PROJECT} --pm-id ${PM_ID} --seat observer $PMARG\n` +
  `bun ${CORE}/driver/src/dispatch/model_routing.ts --project ${PROJECT} --pm-id ${PM_ID} --seat judge $PMARG\n` +
  `Return {guardian:{model,effort}, observer:{model,effort}, refuter:{model,effort}} where refuter ` +
  `uses the judge result (the adversarial refuter is a judgment-dense seat).`,
  { label: 'preflight:gate-routing', phase: 'Dispatch', schema: GATE_ROUTE },
)
// Gate agent() opts for a seat: {model?, effort?} verbatim, or {} = inherit.
const gateOpts = (seat) => {
  const r = gateRoute && gateRoute[seat]
  const o = {}
  if (r && r.model) o.model = r.model
  if (r && r.effort) o.effort = r.effort
  return o
}

const results = await pipeline(
  dispatchable,
  // DISPATCH (W-033). PREPARE first (mechanical), THEN produce. dispatch_prepare
  // claims the task id atomically and cuts the worktree OFF THE STUDIO TIP on the
  // right branch family (NEVER the Agent tool's session-repo isolation, which
  // branches from the session HEAD). Running it BEFORE the produce agent lets the
  // W-026 routing decision it emits (model/effort) apply to the produce agent()
  // call — a produce agent cannot re-route its own already-running model.
  async (it) => {
    if (String(it.criticality || 'normal') === 'critical') return { state: 'PARKED', it }
    // PREPARE — mechanical: cut the worktree + resolve routing; return the JSON line.
    const prep = await agent(
      `Mechanical step, NO judgment, NO prose. Run EXACTLY this and return its FINAL JSON line ` +
      `verbatim as the StructuredOutput (do NOT alter or summarize it):\n` +
      `TARGET_ARG=""; [ -f "${PROJECT}/container.lock.toml" ] && TARGET_ARG="--target-root ${PROJECT}/target"; ` +
      `bash ${CORE}/scripts/dispatch_prepare.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
      `--role ${it.role} --slug ${it.slug} $TARGET_ARG`,
      { label: `prepare:${it.slug}`, phase: 'Dispatch', schema: PREPARE_RESULT },
    )
    if (!prep || !prep.checkout || !prep.branch || prep.id == null) {
      // dispatch_prepare did not yield a usable worktree (prepare agent dropped its
      // output, or the script failed). SAFE failure: no gate, no merge. Any partial
      // worktree is reaped by dispatch_prepare's self-heal sweep on the next tick.
      return { state: 'FAILED', it, r: { summary: 'dispatch_prepare produced no worktree (prepare step failed)', dispatchId: (prep && prep.id != null) ? prep.id : null, branch: (prep && prep.branch) || null } }
    }
    // W-026 routing decision. `model` is already ceiling-clamped (deny/ask) => safe to
    // apply verbatim on this unattended path. needs_confirmation is surfaced only (an
    // attended PM confirms an above-PM suggestion; the jig never auto-escalates).
    if (prep.needs_confirmation) log(`routing: ${it.slug} — resolver suggests '${prep.suggested_model || '?'}' above the PM model (above_pm=ask); dispatching at the SAFE '${prep.model || 'inherit'}'. An attended PM confirms before using the suggestion.`)
    else if (prep.model) log(`routing: ${it.slug} -> model=${prep.model}${prep.effort ? ` effort=${prep.effort}` : ''} (${prep.model_source || 'resolved'})`)
    const routeOpts = {}
    if (prep.model) routeOpts.model = prep.model
    if (prep.effort) routeOpts.effort = prep.effort
    // Use the label dispatch_prepare emitted verbatim (workflow-naming §4 produce:<slug>),
    // keeping the board Task column / branch <slug> / events role aligned by construction.
    const produceLabel = prep.label || `produce:${it.slug}`
    // A producer may request ONE round of Observer direction advice
    // (observer_policy.allow_worker_direction_request) when the assignment is
    // genuinely silent on an in-scope HOW fork — instead of guessing. The
    // advice is advisory; the producer still decides and stays in scope.
    const produce = (resume) => agent(
      `You are the Garelier ${it.role} producer for pm_id=${PM_ID} in ${PROJECT}.\n` +
      (resume
        ? `RESUME in your EXISTING worktree __garelier/${PM_ID}/_dispatch${resume.id}/checkout ` +
          `(do NOT run dispatch_prepare again — your work-in-progress is there on branch ` +
          `${resume.branch}, and the build cache is WARM). FIRST verify that checkout directory ` +
          `still exists; if it was already cleaned up, return state=BLOCKED (a cold re-dispatch is ` +
          `needed — do not fabricate work).\n` +
          (resume.kind === 'rework'
            // DEC-082 fix-2: warm rework — apply reviewer/merge-gate/contract findings on
            // the producer's own warm worktree (incremental build), never a cold re-implement.
            ? `Reviewers (Guardian / Observer / adversarial refuter), the merge gate, or the ` +
              `completion-contract check returned findings — address them WITHIN assignment scope:\n` +
              `<<<FINDINGS\n${resume.findings}\nFINDINGS>>>\n` +
              `Re-run the local quality gate, commit the fix on this same branch, update the report, ` +
              `and return {state, branch, sha, reportPath, summary, dispatchId: ${resume.id}}. ` +
              `state=BLOCKED only for a genuine blocker (do NOT request advice in a rework round).`
            : `You asked for direction advice; the Observer replied (ADVISORY, ` +
              `non-binding — you decide):\n<<<ADVICE\n${resume.advice}\nADVICE>>>\n` +
              `Weigh it within assignment scope, finish the work, run the local quality gate, commit, ` +
              `fill the report (incl. "Context pack gaps"), and return {state, branch, sha, reportPath, ` +
              `summary, dispatchId: ${resume.id}}. state=BLOCKED only for a real blocker; do NOT ` +
              `request advice again.`)
        : `1. Your ISOLATED worktree is ALREADY prepared (dispatch_prepare ran): work ONLY inside ` +
          `${prep.checkout} (branch ${prep.branch}, cut from the studio tip). Do NOT run ` +
          `dispatch_prepare again — cd into that checkout.\n` +
          `2. Work per the garelier-${it.role} skill and the binding assignment at ` +
          `${it.assignmentPath} (load role_index read_first + matching [[triggers]] knowledge per ` +
          `knowledge-consult §1b). Implement, then run the local quality gate the skill/config requires ` +
          `SCOPED to the components you touched (the project's per-package/per-module check + test), NOT ` +
          `a full-project build — the comprehensive whole-project build is the merge gate's job. Run each ` +
          `gate command in the FOREGROUND; if one cannot finish within the foreground time limit even on a ` +
          `warm cache, return state=BLOCKED with reason "gate exceeds foreground budget — needs a warm ` +
          `cache" (the PM warms the cache from main and re-dispatches you warm) — NEVER background-it-and ` +
          `-end-your-turn, which strands you (a detached command does not re-invoke a sub-agent). Commit ` +
          `(red tests before fix where the assignment demands red→green). ` +
          `If a required gate failure REPRODUCES at the base SHA (stash your diff and re-run), it ` +
          `is PRE-EXISTING: do not widen scope to fix it — record the evidence and the failing ` +
          `command, and return state=BLOCKED.${BASE_NOTE}` +
          `${(checkOf(it.slug) || {}).thin ? THIN_NOTE : ''}\n` +
          `If you hit a genuinely uncertain IN-SCOPE implementation-direction fork the assignment ` +
          `does NOT settle, you MAY (once) commit your work-so-far and return state=NEEDS_ADVICE ` +
          `with adviceQuestion = the specific question + the options you weigh, instead of guessing. ` +
          `Decide yourself when the assignment is clear.\n` +
          `3. Fill in the report scaffold at ${prep.container || '<container>'}/report.md (created by ` +
          `dispatch_prepare, one level above your checkout) including "Context pack gaps" (facts you had ` +
          `to rediscover that the assignment should have carried; "none" when it sufficed), and return ` +
          `{state, branch, sha, reportPath, summary, dispatchId: ${prep.id}}. If blocked, return ` +
          `state=BLOCKED with the question in summary. Never merge, never touch studio, never push.`),
      { label: produceLabel, phase: 'Dispatch', schema: PRODUCER_RESULT, ...routeOpts },
    )
    return produce(null).then(async (r) => {
      // Normalize (W-033): keep dispatchId/branch from PREPARE if the produce agent
      // dropped them, so the advice / rework / integrate paths (keyed on both) stay
      // reliable even when the producer's StructuredOutput is incomplete.
      if (r) { if (r.dispatchId == null) r.dispatchId = prep.id; if (!r.branch) r.branch = prep.branch }
      // One-shot Worker→Observer direction advice round-trip (advisory).
      if (r && r.state === 'NEEDS_ADVICE' && r.dispatchId != null) {
        const adv = await agent(
          `Garelier Observer DIRECTION ADVICE (read-only, commit-free, NON-BINDING) for ` +
          `pm_id=${PM_ID} in ${PROJECT}, per garelier-observer references/direction-advice.md. ` +
          `The ${it.role} on branch ${r.branch} is at an in-scope implementation fork and asks:\n` +
          `<<<Q\n${r.adviceQuestion || r.summary || '(see report)'}\nQ>>>\n` +
          `Read the work-so-far (git diff on ${r.branch}) and the assignment ${it.assignmentPath}, ` +
          `then advise on the HOW within scope ONLY — never change WHAT/acceptance, never decide ` +
          `for them. Return concise advice.`,
          { label: `advise:${it.slug}`, phase: 'Dispatch', schema: ADVICE, ...gateOpts('observer') },
        )
        return produce({ id: r.dispatchId, branch: r.branch, advice: (adv && adv.advice) || '(no advice; use your own judgment)' })
          // DEC-082 fix-4: a falsy producer result = the agent DIED (e.g. quota);
          // keep the prior result r (carries dispatchId+branch) so the work on the
          // warm worktree survives for a retry, and surface AGENT_DIED, not FAILED.
          .then((r2) => ({ state: r2 ? r2.state : 'AGENT_DIED', r: r2 || r, it, produce }))
      }
      return { state: r ? r.state : 'AGENT_DIED', r, it, produce }
    })
  },
  // GATE — Guardian then Observer, code-enforced order. Verdicts come back as
  // STRUCTURED VALUES so INTEGRATE can attach them as artifacts (the merge
  // gate mechanically rejects a request without a passing Guardian verdict).
  async (out, it) => {
    if (!out || out.state !== 'REPORTING') return out
    // CONTRACT CHECK (W-022/W-033): before spending two gate agents, mechanically
    // verify the producer actually met its artifact contract — committed past base,
    // STATE closed to REPORTING/BLOCKED, report.md no longer the scaffold. A producer
    // can return state=REPORTING yet have gone idle without committing / left the
    // report as the template; gating that wastes the gate seats on nothing. On a
    // violation WITH a warm producer, nudge it (warm resume, the check's ready-made
    // Japanese nudge as findings) up to MAX_REWORK rounds, then re-check; if it still
    // fails or there is no warm producer, fall through to the gate (which BLOCKs on a
    // real gap) — never silently pass. Best-effort: a check error (tool missing /
    // dropped output) does NOT block the gate.
    if (out.r && out.r.dispatchId != null && out.produce) {
      for (let cround = 0; cround < MAX_REWORK; cround++) {
        const cc = await agent(
          `Mechanical step, NO judgment, NO prose. Run EXACTLY and return its one-line JSON verbatim ` +
          `as the StructuredOutput:\n` +
          `bun ${CORE}/driver/src/dispatch/contract_check.ts --pm-id ${PM_ID} --project ${PROJECT} ` +
          `--dispatch ${out.r.dispatchId} --format json`,
          { label: `contract:${it.slug}`, phase: 'Gate', schema: CONTRACT_RESULT },
        )
        if (!cc || cc.ok !== false) break  // satisfied, or uncheckable — proceed to gate
        log(`contract violation ${it.slug} (round ${cround + 1}): ${((cc.violations || []).map((v) => v && v.check).filter(Boolean).join(', ')) || 'see nudge'}`)
        const r2 = await out.produce({ id: out.r.dispatchId, branch: out.r.branch, kind: 'rework', findings: `Completion-contract not satisfied (contract_check W-022):\n${cc.nudge || JSON.stringify(cc.violations || [])}` })
        if (r2 && r2.dispatchId == null) r2.dispatchId = out.r.dispatchId
        if (r2 && !r2.branch) r2.branch = out.r.branch
        if (r2 && r2.state === 'REPORTING') { out = { ...out, state: 'REPORTING', r: r2 }; continue }
        // resume BLOCKED (warm worktree gone / real blocker) or died — hand back.
        return { ...out, state: r2 ? r2.state : 'AGENT_DIED', r: r2 || out.r }
      }
    }
    // GATE one revision: Guardian → optional adversarial refuter → Observer,
    // code-enforced order; verdicts come back as structured values. Each seat's
    // model comes from the per-tick gate routing (gateOpts, W-026): strong gates.
    const runGate = async (o) => {
      const guard = await agent(
        `Garelier Guardian gate (read-only, commit-free) for pm_id=${PM_ID} in ${PROJECT}: review ` +
        `the diff of ${o.r.branch} vs the studio branch per garelier-guardian (secrets, PII, ` +
        `deps, licenses, unsafe, scope vs ${it.assignmentPath}, and the AGENTS.md §0 principles ` +
        `— a principle violation is BLOCK, cite the P-number). Before judging, match the diff ` +
        `paths against your role_index [[triggers]] entries and load any matched knowledge ` +
        `(knowledge-consult §1b). Return the verdict.`,
        { label: `guardian:${it.slug}`, phase: 'Gate', schema: VERDICT, ...gateOpts('guardian') },
      )
      if (!guard || guard.verdict === 'BLOCK' || guard.verdict === 'NO_OPINION')
        return { ...o, state: 'GATE_BLOCKED', guard }
      if (String(it.criticality || 'normal') === 'normal' && DEPTH.normal === 'gate+refute') {
        const refute = await agent(
          `ADVERSARIAL REFUTER: read ${o.r.reportPath} and the diff on ${o.r.branch} in ` +
          `${PROJECT}. Try to REFUTE the report's claims (gate passed, scope held, acceptance ` +
          `met). verdict=BLOCK only with concrete evidence.`,
          { label: `refute:${it.slug}`, phase: 'Gate', schema: VERDICT, ...gateOpts('refuter') },
        )
        if (refute && refute.verdict === 'BLOCK') return { ...o, state: 'REFUTED', guard, refute }
      }
      const obs = await agent(
        `Garelier Observer review (read-only) for pm_id=${PM_ID} in ${PROJECT}: branch ` +
        `${o.r.branch} vs the assignment ${it.assignmentPath} per garelier-observer, ` +
        `including the assignment's Constitution check vs AGENTS.md §0 (violation = BLOCK, ` +
        `cite the P-number). Before judging, match the diff paths against your role_index ` +
        `[[triggers]] entries and load any matched knowledge (knowledge-consult §1b). ` +
        `Judge adversarially. Return the verdict.`,
        { label: `observer:${it.slug}`, phase: 'Gate', schema: VERDICT, ...gateOpts('observer') },
      )
      if (!obs || obs.verdict === 'BLOCK' || obs.verdict === 'REWORK_RECOMMENDED')
        return { ...o, state: 'NEEDS_REWORK', guard, obs }
      return { ...o, state: 'GATED', guard, obs }
    }
    // DEC-082 fix-2: WARM rework loop. On a fixable verdict (NEEDS_REWORK/REFUTED)
    // resume the producer's OWN warm worktree (out.produce, kind:'rework') with the
    // findings and re-gate, up to MAX_REWORK rounds — never a cold PM re-dispatch.
    // Falls back to the prior behavior (return NEEDS_REWORK to PM) when there is no
    // warm worktree (no dispatchId / no produce) or the rounds are exhausted.
    let cur = out
    for (let round = 0; ; round++) {
      cur = await runGate(cur)
      const fixable = cur.state === 'NEEDS_REWORK' || cur.state === 'REFUTED'
      if (fixable && round < MAX_REWORK && out.produce && cur.r && cur.r.dispatchId != null) {
        const findings = [cur.guard, cur.refute, cur.obs].filter(Boolean)
          .map((v) => v.verdict + ': ' + v.summary).join('\n')
        const r2 = await out.produce({ id: cur.r.dispatchId, branch: cur.r.branch, kind: 'rework', findings })
        if (r2 && r2.state === 'REPORTING') { cur = { ...out, state: 'REPORTING', r: r2 }; continue }
        // resume returned BLOCKED (warm worktree gone / real blocker) or died.
        cur = { ...cur, state: r2 ? r2.state : 'AGENT_DIED', r: r2 || cur.r }
      }
      return cur
    }
  },
)

// SMITH WINDOW (DEC-069) — accumulated-window hardening. Per-merge gates
// cover each merge alone; the Smith batch covers what only shows up ACROSS
// merges (interaction of merges, contract drift at window scale, cumulative
// perf, doc drift). Mechanical due-check; the Smith judges content using the
// ordered views in the quality/integration_hardening_views.md knowledge doc.
phase('Smith')
const MARKER = `${PROJECT}/__garelier/${PM_ID}/runtime/dispatch/last_smith_window`
const SMITH_CHECK = {
  type: 'object', required: ['due'],
  properties: {
    due: { type: 'boolean' },
    window: { type: ['string', 'null'] },   // "<last>..<tip>"
    tip: { type: ['string', 'null'] },
    targets: { type: ['string', 'null'] },  // newline list "sha: subject"
  },
}
const sw = SMITH_EVERY === 0 ? null : await agent(
  `Mechanical check, no judgment. In ${PROJECT}: ` +
  `STUDIO=$(grep '^integration' __garelier/${PM_ID}/_pm/setup_config.toml | cut -d'"' -f2); ` +
  `TIP=$(git rev-parse --short "$STUDIO"). ` +
  `If ${MARKER} is missing: write $TIP into it and return due=false (window starts now). ` +
  `Else LAST=$(cat ${MARKER}); N=$(git rev-list --count --merges --first-parent "$LAST..$STUDIO"). ` +
  `due = (N >= ${SMITH_EVERY}). When due, also return window="$LAST..$TIP", tip="$TIP", and ` +
  `targets = git log --merges --first-parent --format="%h: %s" "$LAST..$STUDIO" (max 20 lines).`,
  { label: 'smith:window-check', phase: 'Smith', schema: SMITH_CHECK },
)
let smith = null
if (sw && sw.due) {
  log(`smith batch due: ${sw.window}`)
  const sp = await agent(
    `You are the Garelier smith producer for pm_id=${PM_ID} in ${PROJECT}.\n` +
    `1. Run: TARGET_ARG=""; [ -f "${PROJECT}/container.lock.toml" ] && TARGET_ARG="--target-root ${PROJECT}/target"; ` +
    `bash ${CORE}/scripts/dispatch_prepare.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
    `--role smith --slug window-hardening $TARGET_ARG — parse its JSON {id, container, checkout, branch}.\n` +
    `2. cd into the checkout and harden the ACCUMULATED WINDOW ${sw.window} per the ` +
    `garelier-smith skill, applying the ordered views in ` +
    `the quality/integration_hardening_views.md knowledge doc (V1 interaction map of these merges:\n` +
    `${sw.targets || '(see git log)'}\n` +
    `then V2-V7). Fix integration/system/release-tooling/spec-consistency findings ON YOUR ` +
    `ANVIL BRANCH (commits allowed; product feature changes are OUT of scope — report them). ` +
    `Run the full project gates.${BASE_NOTE}\n` +
    `3. Fill the report scaffold at <container>/report.md with per-view findings or an honest ` +
    `"clean", and return {state, branch, sha, reportPath, summary, dispatchId}. A clean window ` +
    `is state=REPORTING with sha=null and summary starting "WINDOW CLEAN". Never merge, never push.`,
    { label: 'smith:window-hardening', phase: 'Smith', schema: PRODUCER_RESULT },
  )
  if (sp && sp.state === 'REPORTING' && sp.sha) {
    // Findings were fixed on the anvil branch — same gate order as any branch.
    const g = await agent(
      `Garelier Guardian gate (read-only, commit-free) for pm_id=${PM_ID} in ${PROJECT}: review ` +
      `the diff of ${sp.branch} vs the studio branch per garelier-guardian (secrets, PII, deps, ` +
      `licenses, unsafe, Smith scope, and the AGENTS.md §0 principles — violation is BLOCK, ` +
      `cite the P-number). Before judging, match the diff paths against your role_index ` +
      `[[triggers]] entries and load any matched knowledge (knowledge-consult §1b). ` +
      `Return the verdict.`,
      { label: 'smith:guardian', phase: 'Smith', schema: VERDICT, ...gateOpts('guardian') },
    )
    const o = (g && g.verdict !== 'BLOCK' && g.verdict !== 'NO_OPINION') ? await agent(
      `Garelier Observer review (read-only) for pm_id=${PM_ID} in ${PROJECT}: anvil branch ` +
      `${sp.branch} vs the window-hardening scope (integration/system/release/spec-consistency ` +
      `only) and ${sp.reportPath}. Before judging, match the diff paths against your role_index ` +
      `[[triggers]] entries and load any matched knowledge (knowledge-consult §1b). ` +
      `Judge adversarially. Return the verdict.`,
      { label: 'smith:observer', phase: 'Smith', schema: VERDICT, ...gateOpts('observer') },
    ) : null
    if (g && o && g.verdict !== 'BLOCK' && o.verdict !== 'BLOCK' && o.verdict !== 'REWORK_RECOMMENDED') {
      const mi = await agent(
        `Mechanical step, no judgment. Run exactly:
` +
        `TARGET_ARG=""; [ -f "${PROJECT}/container.lock.toml" ] && TARGET_ARG="--target-root ${PROJECT}/target"; ` +
        `bash ${CORE}/scripts/merge_request.sh --project ${PROJECT} --pm-id ${PM_ID} $TARGET_ARG ` +
        `--branch "${sp.branch}" --task "smith-window-hardening" --guardian "${g.verdict}" ` +
        `--observer "${o.verdict}"
` +
        `Return its final JSON verbatim.`,
        { label: 'smith:merge', phase: 'Smith' },
      )
      smith = { state: 'ENQUEUED', window: sw.window, branch: sp.branch, integrated: mi }
    } else {
      smith = { state: 'GATE_BLOCKED', window: sw.window, guard: g, obs: o, summary: sp.summary }
    }
  } else if (sp) {
    smith = { state: sp.state === 'REPORTING' ? 'CLEAN' : sp.state, window: sw.window, summary: sp.summary }
  }
  // Advance the window marker on a decided outcome (clean or enqueued);
  // blocked/failed outcomes keep the window open for the next tick.
  if (smith && (smith.state === 'CLEAN' || smith.state === 'ENQUEUED')) {
    await agent(
      `Mechanical step, no judgment. 1. Write "${sw.tip}" (just the sha) into ${MARKER} (overwrite). ` +
      `2. Run: bash ${CORE}/scripts/dispatch_event.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
      `--kind ${smith.state === 'CLEAN' ? 'note' : 'complete'} --role "smith(window)" ` +
      `--task "smith window ${sw.window} -> ${smith.state}"
` +
      `Then reply done.`,
      { label: 'smith:record', phase: 'Smith' },
    )
  }
}

const ok = (results || []).filter(Boolean)

// DEC-083: the MECHANICAL tail (merge_request -> await terminal -> dispatch_event
// -> cleanup-on-success) for EVERY GATED branch now runs in deterministic zero-LLM
// TS (dock_integrate.ts), driven by ONE thin journaled agent. The friction-1
// failure class (the schema-bearing merge-await agent dropping StructuredOutput)
// is GONE from the merge PATH: dock_integrate records + cleans deterministically,
// so even if THIS agent drops its summary the work is DONE + recorded + cleaned
// (durable state correct — `garelier status` confirms). The GATE warm-rework loop
// (DEC-082 fix-2) stays in the pipeline; only the mechanical tail left the DSL.
const gated = ok.filter((x) => x.state === 'GATED')
let integ = { integrated: [], enqueued: [], mergeFailed: [], integrateError: [], warnings: [], untracked: [] }
if (gated.length > 0) {
  phase('Integrate')
  const clip = (s) => (typeof s === 'string' ? s.slice(0, 400) : s)
  const items = gated.map((x) => ({
    slug: x.it.slug, branch: x.r.branch, guardianVerdict: x.guard.verdict,
    observerVerdict: x.obs ? x.obs.verdict : null, dispatchId: x.r.dispatchId,
    reportPath: x.r.reportPath, role: x.it.role, sha: x.r.sha, summary: clip(x.r.summary),
    hasWarmProducer: (x.produce != null && x.r.dispatchId != null),
    guardianSummary: clip(x.guard.summary), observerSummary: x.obs ? clip(x.obs.summary) : null,
    refuterSummary: x.refute ? clip(x.refute.summary) : null, task: x.it.slug, deleteBranch: false,
  }))
  // Hand items to the zero-LLM tail via a quoted-heredoc file (JSON.stringify is a
  // standard built-in; the items are ONE line so a `<<'EOF'` heredoc cannot be
  // broken by interpolation/quotes/UTF-8 in summaries). No base64/btoa dependency
  // on the workflow runtime; a mangled write just makes dock_integrate parse-error
  // (-> integrateError, no merge) — a SAFE failure, never a half-merge.
  const itemsJson = JSON.stringify({ items })
  const itemsPath = `${PROJECT}/__garelier/${PM_ID}/runtime/jig/integrate_items.json`
  const outPath = `${PROJECT}/__garelier/${PM_ID}/runtime/jig/integrate_result.json`
  try {
    const r = await agent(
      `Mechanical step, NO judgment, NO prose. Run these two commands EXACTLY:\n` +
      `1. Write the items file verbatim — the JSON is ONE line between the markers, do NOT alter it:\n` +
      `cat > ${itemsPath} <<'DOCKITEMS'\n${itemsJson}\nDOCKITEMS\n` +
      `2. TARGET_ARG=""; [ -f "${PROJECT}/container.lock.toml" ] && TARGET_ARG="--target-root ${PROJECT}/target"; ` +
      `bun ${CORE}/driver/src/dispatch/dock_integrate.ts run --pm-id ${PM_ID} --project ${PROJECT} $TARGET_ARG --items ${itemsPath} --out ${outPath}\n` +
      `Step 2 deterministically integrates each GATED branch (merge_request -> await terminal -> ` +
      `dispatch_event -> cleanup-on-success), zero LLM. Your ONLY output is the StructuredOutput ` +
      `carrying the {integrated,enqueued,mergeFailed,integrateError,warnings} JSON step 2 printed.`,
      { label: 'integrate:dock', phase: 'Integrate', schema: INTEGRATE_BATCH },
    )
    if (r) integ = { ...integ, ...r }
  } catch (_e) {
    // The thin agent dropped its summary, but dock_integrate already ran the merge
    // tail deterministically (recorded via dispatch_event + cleaned). Nothing is
    // lost — surface a pointer so the operator confirms from the durable state.
    integ = { ...integ, untracked: gated.map((x) => x.it.slug),
      warnings: [`dock_integrate ran (merge done + recorded + cleaned) but the agent dropped its result — confirm via 'garelier status' or ${outPath}`] }
  }
}

return {
  smith,
  // W-034: WORKING dispatches (usually from a PRIOR tick/session) contract_check.ts
  // judged genuinely stalled (zero commits, dirty checkout, no live build on that
  // checkout) — [] on every normal tick. Act via contract_check.ts --stall-scan
  // --handoff <N> for a respawn-handoff prompt that preserves the partial worktree.
  stallSuspects,
  // enqueued = integrated (merged:true) + await-timeout (merged:false). dock_integrate
  // recorded + cleaned the merged ones; timeouts are still in-flight (re-resolved next tick).
  enqueued: [...(integ.integrated || []), ...(integ.enqueued || [])],
  // gate-rejected revisions (already warm-retried in-gate up to maxRework, DEC-082
  // fix-2) PLUS merge-gate rejections (mergeFailed): hasWarmProducer -> re-dispatch
  // warm next tick; else escalate to PM (e.g. the gate_held path).
  needsRework: ok.filter((x) => ['NEEDS_REWORK', 'REFUTED'].includes(x.state))
    .map((x) => ({ slug: x.it.slug, maxRework: MAX_REWORK, obs: (x.obs && x.obs.summary) }))
    .concat((integ.mergeFailed || []).map((m) => ({
      slug: m.slug, mergeStatus: m.mergeStatus, hasWarmProducer: m.hasWarmProducer,
      obs: 'merge gate ' + (m.mergeStatus || 'failed') + (m.hasWarmProducer ? ' — re-dispatch warm next tick' : ' — escalate (no warm producer)'),
    }))),
  // DEC-082 fix-4: a producer that DIED mid-task (quota) keeps its warm worktree;
  // retry via warm-resume if the checkout survives, else cold re-dispatch.
  agentDied: ok.filter((x) => x.state === 'AGENT_DIED')
    .map((x) => ({ slug: x.it.slug, dispatchId: (x.r && x.r.dispatchId) || null, branch: (x.r && x.r.branch) || null, retry: 'warm-resume if _dispatch<id>/checkout exists, else cold re-dispatch' })),
  // DEC-083: a malformed/incomplete GATED hand-off (e.g. missing guardian) — recorded as rework, never merged.
  integrateError: integ.integrateError || [],
  // DEC-083: dock_integrate ran but the thin agent dropped its summary (work is DONE
  // + recorded + cleaned — confirm via `garelier status`); strictly safer than the
  // old fix-5 MERGE_UNTRACKED (which left record+cleanup to the operator).
  integrateUntracked: integ.untracked || [],
  blockedOrParked: ok.filter((x) => ['BLOCKED', 'PARKED', 'GATE_BLOCKED', 'FAILED'].includes(x.state)).map((x) => ({ slug: x.it.slug, state: x.state }))
    .concat(parkedUnfilled),
  overCap,
  note: 'DEC-083: GATED branches integrate via the deterministic zero-LLM dock_integrate.ts (one thin journaled agent) — no StructuredOutput in the merge path, so a dropped agent summary loses nothing (the merge is done + recorded + cleaned; `garelier status` confirms). enqueued = merged or await-timeout. needsRework = gate-rejected (warm-retried in-gate up to maxRework) OR merge-gate-rejected (mergeFailed; hasWarmProducer re-dispatches warm next tick). integrateError = bad gate hand-off. agentDied = producer died (warm worktree survives). integrateUntracked = dock_integrate ran but its summary dropped (state is correct, confirm via garelier status).',
}
