// Jig tick — Mode E (DEC-062) Phase 1 template, hardened by live dispatch runs
// (2026-06-11): every step below that is code was a step the prose tick lost
// in practice (worktree not cut from studio; merge request missing verdicts /
// merge_message; RECORD skipped so the Status Web showed nothing).
//
// The Dock substitutes {{placeholders}} and runs ONE tick:
// DISPATCH → GATE (Guardian→Observer) → INTEGRATE → RECORD. LOW/NORMAL review
// depths; CRITICAL items PARK to PM (Phase 2). DEC-061 invariants hold: runs
// inside the attended session; human gates park, never auto-decide; promote out
// of scope.
//
// args: { items: [{ id?, role, slug, assignmentPath, criticality }] }
// (id optional — dispatch_prepare claims one when absent).
export const meta = {
  name: 'ga-tick',
  description: 'One deterministic dock-lane tick: prepare → produce → Guardian→Observer → merge gate → record (DEC-062 Phase 1)',
  phases: [
    { title: 'Dispatch', detail: 'dispatch_prepare + producers in isolated worktrees' },
    { title: 'Gate', detail: 'Guardian then Observer, fixed order, verdicts as artifacts' },
    { title: 'Integrate', detail: 'merge request JSON (verdicts + merge_message) + zero-LLM poll' },
    { title: 'Record', detail: 'events.jsonl + in-flight notes — the Status Web source' },
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
    note: 'Doctor reported P0 findings — fix them (doctor.{sh,ps1}) and re-run the tick. Nothing was dispatched.',
  }
}
const BASE_NOTE = pre && pre.baseKnownGreen === false
  ? `\nCAUTION: the studio base is NOT verified green (${pre.note || pre.tipSha || 'unverified tip'}). ` +
    `Budget for pre-existing failures.`
  : ''
if (pre && pre.baseKnownGreen === false) log(`base not verified green: ${pre.note || pre.tipSha || ''}`)

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

const results = await pipeline(
  dispatchable,
  // DISPATCH. The producer's FIRST action is dispatch_prepare.{sh,ps1} — it
  // claims the task id atomically and cuts the worktree OFF THE STUDIO TIP on
  // the right branch family (NEVER rely on the Agent tool's session-repo
  // worktree isolation: that branches from the session HEAD, not studio).
  (it) => {
    if (String(it.criticality || 'normal') === 'critical') return { state: 'PARKED', it }
    // A producer may request ONE round of Observer direction advice
    // (observer_policy.allow_worker_direction_request) when the assignment is
    // genuinely silent on an in-scope HOW fork — instead of guessing. The
    // advice is advisory; the producer still decides and stays in scope.
    const produce = (resume) => agent(
      `You are the Garelier ${it.role} producer for pm_id=${PM_ID} in ${PROJECT}.\n` +
      (resume
        ? `RESUME in your EXISTING worktree __garelier/${PM_ID}/_dispatch${resume.id}/checkout ` +
          `(do NOT run dispatch_prepare again — your work-in-progress is there on branch ` +
          `${resume.branch}). You asked for direction advice; the Observer replied (ADVISORY, ` +
          `non-binding — you decide):\n<<<ADVICE\n${resume.advice}\nADVICE>>>\n` +
          `Weigh it within assignment scope, finish the work, run the local quality gate, commit, ` +
          `fill the report (incl. "Context pack gaps"), and return {state, branch, sha, reportPath, ` +
          `summary, dispatchId: ${resume.id}}. state=BLOCKED only for a real blocker; do NOT ` +
          `request advice again.`
        : `1. Run: bash ${CORE}/scripts/dispatch_prepare.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
          `--role ${it.role} --slug ${it.slug}  — parse its JSON {id, container, checkout, branch}.\n` +
          `2. cd into the checkout and work ONLY there, per the garelier-${it.role} skill and the ` +
          `binding assignment at ${it.assignmentPath} (load role_index read_first + matching ` +
          `[[triggers]] knowledge per knowledge-consult §1b). Implement, run the local quality gate the ` +
          `skill requires, commit (red tests before fix where the assignment demands red→green). ` +
          `If a required gate failure REPRODUCES at the base SHA (stash your diff and re-run), it ` +
          `is PRE-EXISTING: do not widen scope to fix it — record the evidence and the failing ` +
          `command, and return state=BLOCKED.${BASE_NOTE}` +
          `${(checkOf(it.slug) || {}).thin ? THIN_NOTE : ''}\n` +
          `If you hit a genuinely uncertain IN-SCOPE implementation-direction fork the assignment ` +
          `does NOT settle, you MAY (once) commit your work-so-far and return state=NEEDS_ADVICE ` +
          `with adviceQuestion = the specific question + the options you weigh, instead of guessing. ` +
          `Decide yourself when the assignment is clear.\n` +
          `3. Fill in the report scaffold at <container>/report.md (created by dispatch_prepare, ` +
          `one level above your checkout) including "Context pack gaps" (facts you had to rediscover ` +
          `that the assignment should have carried; "none" when it sufficed), and return ` +
          `{state, branch, sha, reportPath, summary, dispatchId: <id>}. If blocked, return ` +
          `state=BLOCKED with the question in summary. Never merge, never touch studio, never push.`),
      { label: `produce:${it.slug}`, phase: 'Dispatch', schema: PRODUCER_RESULT },
    )
    return produce(null).then(async (r) => {
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
          { label: `advise:${it.slug}`, phase: 'Dispatch', schema: ADVICE },
        )
        return produce({ id: r.dispatchId, branch: r.branch, advice: (adv && adv.advice) || '(no advice; use your own judgment)' })
          .then((r2) => ({ state: r2 ? r2.state : 'FAILED', r: r2, it }))
      }
      return { state: r ? r.state : 'FAILED', r, it }
    })
  },
  // GATE — Guardian then Observer, code-enforced order. Verdicts come back as
  // STRUCTURED VALUES so INTEGRATE can attach them as artifacts (the merge
  // gate mechanically rejects a request without a passing Guardian verdict).
  async (out, it) => {
    if (!out || out.state !== 'REPORTING') return out
    const guard = await agent(
      `Garelier Guardian gate (read-only, commit-free) for pm_id=${PM_ID} in ${PROJECT}: review ` +
      `the diff of ${out.r.branch} vs the studio branch per garelier-guardian (secrets, PII, ` +
      `deps, licenses, unsafe, scope vs ${it.assignmentPath}, and the AGENTS.md §0 principles ` +
      `— a principle violation is BLOCK, cite the P-number). Return the verdict.`,
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
      `${out.r.branch} vs the assignment ${it.assignmentPath} per garelier-observer, ` +
      `including the assignment's Constitution check vs AGENTS.md §0 (violation = BLOCK, ` +
      `cite the P-number). Judge adversarially. Return the verdict.`,
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
  // On a non-complete outcome the WHY is also persisted into the container
  // (questions.md) so the Dock never digs through transcripts for
  // the block reason (DEC-067 operator-comfort rule).
  async (out, it) => {
    if (!out) return out
    const kind = out.state === 'ENQUEUED' ? 'complete'
      : out.state === 'BLOCKED' ? 'blocked'
      : ['NEEDS_REWORK', 'REFUTED', 'GATE_BLOCKED', 'FAILED'].includes(out.state) ? 'rework'
      : 'note'
    const ref = out.r && out.r.reportPath ? ` --ref "${out.r.reportPath}"` : ''
    const why = kind !== 'complete' && out.r && out.r.dispatchId
      ? `Then write this verbatim (create/overwrite) to ` +
        `${PROJECT}/__garelier/${PM_ID}/_dispatch${out.r.dispatchId}/questions.md:
` +
        `# ${it.slug} -> ${out.state}
` +
        `## Producer summary
${(out.r.summary || '(none)')}
` +
        `${out.guard ? '## Guardian: ' + out.guard.verdict + ' - ' + out.guard.summary + '\n' : ''}` +
        `${out.refute ? '## Refuter: ' + out.refute.verdict + ' - ' + out.refute.summary + '\n' : ''}` +
        `${out.obs ? '## Observer: ' + out.obs.verdict + ' - ' + out.obs.summary + '\n' : ''}
`
      : ''
    await agent(
      `Mechanical step, no judgment. Run exactly:
` +
      `bash ${CORE}/scripts/dispatch_event.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
      `--kind ${kind} --role "${it.role}(${it.slug})" ` +
      `--task "${it.slug} -> ${out.state}${out.r && out.r.sha ? ' @' + out.r.sha : ''}"${ref}
` +
      `${why}Then reply done.`,
      { label: `record:${it.slug}`, phase: 'Record' },
    )
    return out
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
    `1. Run: bash ${CORE}/scripts/dispatch_prepare.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
    `--role smith --slug window-hardening — parse its JSON {id, container, checkout, branch}.\n` +
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
      `cite the P-number). Return the verdict.`,
      { label: 'smith:guardian', phase: 'Smith', schema: VERDICT },
    )
    const o = (g && g.verdict !== 'BLOCK' && g.verdict !== 'NO_OPINION') ? await agent(
      `Garelier Observer review (read-only) for pm_id=${PM_ID} in ${PROJECT}: anvil branch ` +
      `${sp.branch} vs the window-hardening scope (integration/system/release/spec-consistency ` +
      `only) and ${sp.reportPath}. Judge adversarially. Return the verdict.`,
      { label: 'smith:observer', phase: 'Smith', schema: VERDICT },
    ) : null
    if (g && o && g.verdict !== 'BLOCK' && o.verdict !== 'BLOCK' && o.verdict !== 'REWORK_RECOMMENDED') {
      const mi = await agent(
        `Mechanical step, no judgment. Run exactly:
` +
        `bash ${CORE}/scripts/merge_request.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
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
return {
  smith,
  enqueued: ok.filter((x) => x.state === 'ENQUEUED').map((x) => ({ slug: x.it.slug, branch: x.r.branch, sha: x.r.sha })),
  needsRework: ok.filter((x) => ['NEEDS_REWORK', 'REFUTED'].includes(x.state)).map((x) => ({ slug: x.it.slug, maxRework: MAX_REWORK, obs: x.obs && x.obs.summary })),
  blockedOrParked: ok.filter((x) => ['BLOCKED', 'PARKED', 'GATE_BLOCKED', 'FAILED'].includes(x.state)).map((x) => ({ slug: x.it.slug, state: x.state }))
    .concat(parkedUnfilled),
  overCap,
  note: 'Poll dock_merge until results land; on rework, re-dispatch the same producer with the reviewer findings (max ' + MAX_REWORK + ' rounds); run dispatch_cleanup.sh --id <n> after integration.',
}
