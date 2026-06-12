// Jig tick — Mode E (DEC-062) Phase 1 template, hardened by live dispatch runs
// (2026-06-11): every step below that is code was a step the prose tick lost
// in practice (worktree not cut from studio; merge request missing verdicts /
// merge_message; RECORD skipped so the Status Web showed nothing).
//
// The Dock orchestrator substitutes {{placeholders}} and runs ONE tick:
// DISPATCH → GATE (Guardian→Observer) → INTEGRATE → RECORD. LOW/NORMAL review
// depths; CRITICAL items PARK to PM (Phase 2). DEC-061 invariants hold: runs
// inside the attended session; human gates park, never auto-decide; promote out
// of scope.
//
// args: { items: [{ id?, role, slug, assignmentPath, criticality }] }
// (id optional — dispatch_prepare claims one when absent).
export const meta = {
  name: 'garelier-jig-tick',
  description: 'One deterministic dock-lane tick: prepare → produce → Guardian→Observer → merge gate → record (DEC-062 Phase 1)',
  phases: [
    { title: 'Dispatch', detail: 'dispatch_prepare + producers in isolated worktrees' },
    { title: 'Gate', detail: 'Guardian then Observer, fixed order, verdicts as artifacts' },
    { title: 'Integrate', detail: 'merge request JSON (verdicts + merge_message) + zero-LLM poll' },
    { title: 'Record', detail: 'events.jsonl + in-flight notes — the Status Web source' },
  ],
}

const PROJECT = '{{project_root}}'
const PM_ID = '{{pm_id}}'
const CORE = '{{garelier_core_dir}}'           // skills/garelier-core
const FAN_OUT_CAP = {{jig_fan_out_cap}}        // [jig] fan_out_cap
const MAX_REWORK = {{jig_max_rework_rounds}}   // [jig] max_rework_rounds
const DEPTH = { low: '{{jig_depth_low}}', normal: '{{jig_depth_normal}}' } // [jig.review_depth]

const VERDICT = {
  type: 'object', required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'PASS_WITH_NOTES', 'REWORK_RECOMMENDED', 'BLOCK', 'NO_OPINION'] },
    summary: { type: 'string' },
  },
}
const PRODUCER_RESULT = {
  type: 'object', required: ['state', 'branch', 'sha', 'reportPath', 'summary'],
  properties: {
    state: { type: 'string', enum: ['REPORTING', 'BLOCKED'] },
    branch: { type: ['string', 'null'] },
    sha: { type: ['string', 'null'] },
    reportPath: { type: ['string', 'null'] },
    summary: { type: 'string' },
    dispatchId: { type: ['number', 'null'] },
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

// PREFLIGHT — base health (live-run lesson: two producers independently
// diagnosed the same pre-existing breakage). Cheap heuristic, advisory only:
// the studio tip should be the merge commit of the newest SUCCESS gate result.
const PREFLIGHT = {
  type: 'object', required: ['baseKnownGreen'],
  properties: {
    baseKnownGreen: { type: 'boolean' },
    tipSha: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
  },
}
const pre = items.length === 0 ? null : await agent(
  `Mechanical check, no judgment, read-only. In ${PROJECT}: ` +
  `1. STUDIO=$(grep '^integration' __garelier/${PM_ID}/_pm/setup_config.toml | cut -d'"' -f2). ` +
  `2. TIP=$(git rev-parse --short "$STUDIO"); SUBJ=$(git log -1 --format=%s "$STUDIO"). ` +
  `3. Read the newest non-summary __garelier/${PM_ID}/runtime/merge_gate/results/*.json status. ` +
  `Return baseKnownGreen=true ONLY IF the newest result is "success" AND the tip subject ` +
  `starts with "merge " (i.e. the tip is gate-made — no manual commits after the last gate). ` +
  `Else false, with tipSha and a one-line note.`,
  { label: 'preflight:base', phase: 'Dispatch', schema: PREFLIGHT },
)
const BASE_NOTE = pre && pre.baseKnownGreen === false
  ? `\nCAUTION: the studio base is NOT verified green (${pre.note || pre.tipSha || 'unverified tip'}). ` +
    `Budget for pre-existing failures.`
  : ''
if (pre && pre.baseKnownGreen === false) log(`base not verified green: ${pre.note || pre.tipSha || ''}`)

const results = await pipeline(
  items,
  // DISPATCH. The producer's FIRST action is dispatch_prepare.{sh,ps1} — it
  // claims the task id atomically and cuts the worktree OFF THE STUDIO TIP on
  // the right branch family (NEVER rely on the Agent tool's session-repo
  // worktree isolation: that branches from the session HEAD, not studio).
  (it) => {
    if (String(it.criticality || 'normal') === 'critical') return { state: 'PARKED', it }
    return agent(
      `You are the Garelier ${it.role} producer for pm_id=${PM_ID} in ${PROJECT}.\n` +
      `1. Run: bash ${CORE}/scripts/dispatch_prepare.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
      `--role ${it.role} --slug ${it.slug}  — parse its JSON {id, container, checkout, branch}.\n` +
      `2. cd into the checkout and work ONLY there, per the garelier-${it.role} skill and the ` +
      `binding assignment at ${it.assignmentPath}. Implement, run the local quality gate the ` +
      `skill requires, commit (red tests before fix where the assignment demands red→green). ` +
      `If a required gate failure REPRODUCES at the base SHA (stash your diff and re-run), it ` +
      `is PRE-EXISTING: do not widen scope to fix it — record the evidence and the failing ` +
      `command, and return state=BLOCKED.${BASE_NOTE}\n` +
      `3. Fill in the report scaffold at <container>/report.md (created by dispatch_prepare, ` +
      `one level above your checkout), and return ` +
      `{state, branch, sha, reportPath, summary, dispatchId: <id>}. If blocked, return ` +
      `state=BLOCKED with the question in summary. Never merge, never touch studio, never push.`,
      { label: `produce:${it.slug}`, phase: 'Dispatch', schema: PRODUCER_RESULT },
    ).then((r) => ({ state: r ? r.state : 'FAILED', r, it }))
  },
  // GATE — Guardian then Observer, code-enforced order. Verdicts come back as
  // STRUCTURED VALUES so INTEGRATE can attach them as artifacts (the merge
  // gate mechanically rejects a request without a passing Guardian verdict).
  async (out, it) => {
    if (!out || out.state !== 'REPORTING') return out
    const guard = await agent(
      `Garelier Guardian gate (read-only, commit-free) for pm_id=${PM_ID} in ${PROJECT}: review ` +
      `the diff of ${out.r.branch} vs the studio branch per garelier-guardian (secrets, PII, ` +
      `deps, licenses, unsafe, scope vs ${it.assignmentPath}). Return the verdict.`,
      { label: `guardian:${it.slug}`, phase: 'Gate', schema: VERDICT },
    )
    if (!guard || guard.verdict === 'BLOCK' || guard.verdict === 'NO_OPINION')
      return { ...out, state: 'GATE_BLOCKED', guard }
    if (String(it.criticality || 'normal') === 'normal' && DEPTH.normal === 'gate+refute') {
      const refute = await agent(
        `ADVERSARIAL REFUTER: read ${out.r.reportPath} and the diff on ${out.r.branch} in ` +
        `${PROJECT}. Try to REFUTE the report's claims (gate passed, scope held, acceptance ` +
        `met). verdict=BLOCK only with concrete evidence.`,
        { label: `refute:${it.slug}`, phase: 'Gate', schema: VERDICT },
      )
      if (refute && refute.verdict === 'BLOCK') return { ...out, state: 'REFUTED', refute }
    }
    const obs = await agent(
      `Garelier Observer review (read-only) for pm_id=${PM_ID} in ${PROJECT}: branch ` +
      `${out.r.branch} vs the assignment ${it.assignmentPath} per garelier-observer. ` +
      `Judge adversarially. Return the verdict.`,
      { label: `observer:${it.slug}`, phase: 'Gate', schema: VERDICT },
    )
    if (!obs || obs.verdict === 'BLOCK' || obs.verdict === 'REWORK_RECOMMENDED')
      return { ...out, state: 'NEEDS_REWORK', guard, obs }
    return { ...out, state: 'GATED', guard, obs }
  },
  // INTEGRATE — write the merge request WITH the verdict fields AND a non-empty
  // merge_message (the gate rejects empty messages), then run the zero-LLM poll.
  // One agent does the mechanical file-write + poll with exact commands.
  async (out, it) => {
    if (!out || out.state !== 'GATED') return out
    const integrated = await agent(
      `Mechanical step, no judgment. Run exactly:
` +
      `bash ${CORE}/scripts/merge_request.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
      `--branch "${out.r.branch}" --task "${it.slug}" --guardian "${out.guard.verdict}"` +
      `${out.obs ? ' --observer "' + out.obs.verdict + '"' : ''}
` +
      `(one command: derives the studio branch + non-empty merge_message, writes the request, ` +
      `runs the zero-LLM poll - DEC-064 §1). Return its final JSON verbatim.`,
      { label: `merge:${it.slug}`, phase: 'Integrate' },
    )
    return { ...out, state: 'ENQUEUED', integrated }
  },
  // RECORD — the Status Web reads runtime files, not this conversation.
  // One command appends the event AND regenerates the in_flight.md derived
  // view (W-011, DEC-064 §3) — no hand-written JSON, nothing to remember.
  async (out, it) => {
    if (!out) return out
    const kind = out.state === 'ENQUEUED' ? 'complete'
      : out.state === 'BLOCKED' ? 'blocked'
      : ['NEEDS_REWORK', 'REFUTED', 'GATE_BLOCKED', 'FAILED'].includes(out.state) ? 'rework'
      : 'note'
    const ref = out.r && out.r.reportPath ? ` --ref "${out.r.reportPath}"` : ''
    await agent(
      `Mechanical step, no judgment. Run exactly:
` +
      `bash ${CORE}/scripts/dispatch_event.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
      `--kind ${kind} --role "${it.role}(${it.slug})" ` +
      `--task "${it.slug} -> ${out.state}${out.r && out.r.sha ? ' @' + out.r.sha : ''}"${ref}
` +
      `Then reply done.`,
      { label: `record:${it.slug}`, phase: 'Record' },
    )
    return out
  },
)

const ok = (results || []).filter(Boolean)
return {
  enqueued: ok.filter((x) => x.state === 'ENQUEUED').map((x) => ({ slug: x.it.slug, branch: x.r.branch, sha: x.r.sha })),
  needsRework: ok.filter((x) => ['NEEDS_REWORK', 'REFUTED'].includes(x.state)).map((x) => ({ slug: x.it.slug, maxRework: MAX_REWORK, obs: x.obs && x.obs.summary })),
  blockedOrParked: ok.filter((x) => ['BLOCKED', 'PARKED', 'GATE_BLOCKED', 'FAILED'].includes(x.state)).map((x) => ({ slug: x.it.slug, state: x.state })),
  overCap,
  note: 'Poll dock_merge until results land; on rework, re-dispatch the same producer with the reviewer findings (max ' + MAX_REWORK + ' rounds); run dispatch_cleanup.sh --id <n> after integration.',
}
