// Jig gate-held — resume path for ALREADY-PRODUCED branches (DEC-062).
//
// When a jig-tick producer finishes its work but returns BLOCKED (typically a
// question the Dock/PM must answer, or a pre-existing base failure repaired by
// a separate task), the work survives on its workbench/anvil branch while the
// tick ends. After the Dock resolves the block (answers.md / repair
// merged), run THIS template to take the held branches through the SAME gate
// order as the tick — Guardian → adversarial refuter → Observer →
// merge_request → dispatch_event — without re-running the producer.
//
// The Dock substitutes {{placeholders}} and passes:
//   args: {
//     items: [{ slug, branch, assignmentPath, reportPath }],
//     note?: "reviewer context — e.g. which pre-existing failure was already
//             dispositioned/repaired, so reviewers do not re-block on it"
//   }
export const meta = {
  name: 'ga-gate',
  description: 'Gate (Guardian→refute→Observer) + merge gate + record for held producer branches (DEC-062 resume path)',
  phases: [
    { title: 'Gate', detail: 'Guardian then adversarial refuter then Observer, per branch' },
    { title: 'Integrate', detail: 'dock_integrate.ts — zero-LLM merge_request + await + record + branch delete (DEC-083)' },
  ],
}

const PROJECT = '{{project_root}}'
const PM_ID = '{{pm_id}}'
const CORE = '{{garelier_core_dir}}'           // skills/garelier-core

const VERDICT = {
  type: 'object', required: ['verdict', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'PASS_WITH_NOTES', 'REWORK_RECOMMENDED', 'BLOCK', 'NO_OPINION'] },
    summary: { type: 'string' },
  },
}

// DEC-083: the mechanical tail (merge_request -> await -> record -> cleanup) runs
// in the deterministic zero-LLM dock_integrate.ts (one thin journaled agent over
// all GATED held branches), matching jig_tick — no schema merge-await agent to
// drop its StructuredOutput. This schema is only the advisory batch summary.
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

const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const items = A.items || []
const KNOWN = A.note
  ? ` Known context from Dock (answers.md — do NOT re-block on it): ${A.note}.`
  : ''

phase('Gate')
log(`gating ${items.length} held branch(es)`)

const results = await pipeline(
  items,
  async (it) => {
    const guard = await agent(
      `Garelier Guardian gate (read-only, commit-free) for pm_id=${PM_ID} in ${PROJECT}: review ` +
      `the diff of ${it.branch} vs the studio branch per garelier-guardian (secrets, PII, ` +
      `deps, licenses, unsafe, scope vs ${it.assignmentPath}, and the AGENTS.md §0 principles ` +
      `— a principle violation is BLOCK, cite the P-number).${KNOWN} Return the verdict.`,
      { label: `guardian:${it.slug}`, phase: 'Gate', schema: VERDICT },
    )
    if (!guard || guard.verdict === 'BLOCK' || guard.verdict === 'NO_OPINION')
      return { state: 'GATE_BLOCKED', guard, it }
    const refute = await agent(
      `ADVERSARIAL REFUTER: read ${it.reportPath} and the diff on ${it.branch} in ${PROJECT}. ` +
      `Try to REFUTE the work's claims (in-scope gates green, scope held, acceptance met, ` +
      `red->green regression tests real).${KNOWN} verdict=BLOCK only with concrete evidence.`,
      { label: `refute:${it.slug}`, phase: 'Gate', schema: VERDICT },
    )
    if (refute && refute.verdict === 'BLOCK') return { state: 'REFUTED', refute, it }
    const obs = await agent(
      `Garelier Observer review (read-only) for pm_id=${PM_ID} in ${PROJECT}: branch ` +
      `${it.branch} vs the assignment ${it.assignmentPath} per garelier-observer, ` +
      `including the assignment's Constitution check vs AGENTS.md §0 (violation = BLOCK, ` +
      `cite the P-number).${KNOWN} Judge adversarially. Return the verdict.`,
      { label: `observer:${it.slug}`, phase: 'Gate', schema: VERDICT },
    )
    if (!obs || obs.verdict === 'BLOCK' || obs.verdict === 'REWORK_RECOMMENDED')
      return { state: 'NEEDS_REWORK', guard, obs, it }
    return { state: 'GATED', guard, obs, it }
  },
)

const ok = (results || []).filter(Boolean)

// DEC-083: the mechanical tail for every GATED held branch runs in the
// deterministic zero-LLM dock_integrate.ts via ONE thin journaled agent — no
// schema merge-await agent to drop StructuredOutput. Held branches have NO warm
// producer (hasWarmProducer:false) and NO container (dispatchId:null -> cleanup
// deletes the merged branch directly); a MERGE_FAILED escalates to PM (nothing to
// warm-resume). A dropped agent summary loses nothing (merge done + recorded +
// branch deleted; `garelier status` confirms).
const gated = ok.filter((x) => x.state === 'GATED')
let integ = { integrated: [], enqueued: [], mergeFailed: [], integrateError: [], warnings: [], untracked: [] }
if (gated.length > 0) {
  phase('Integrate')
  const clip = (s) => (typeof s === 'string' ? s.slice(0, 400) : s)
  const bItems = gated.map((x) => ({
    slug: x.it.slug, branch: x.it.branch, guardianVerdict: x.guard.verdict,
    observerVerdict: x.obs ? x.obs.verdict : null, dispatchId: null,
    reportPath: x.it.reportPath, role: 'worker', sha: null, summary: null, hasWarmProducer: false,
    guardianSummary: clip(x.guard.summary), observerSummary: x.obs ? clip(x.obs.summary) : null,
    refuterSummary: x.refute ? clip(x.refute.summary) : null, task: x.it.slug, deleteBranch: true,
  }))
  const itemsJson = JSON.stringify({ items: bItems })
  const itemsPath = `${PROJECT}/__garelier/${PM_ID}/runtime/jig/gate_held_items.json`
  const outPath = `${PROJECT}/__garelier/${PM_ID}/runtime/jig/gate_held_result.json`
  try {
    const r = await agent(
      `Mechanical step, NO judgment, NO prose. Run these two commands EXACTLY:\n` +
      `1. Write the items file verbatim — the JSON is ONE line between the markers, do NOT alter it:\n` +
      `cat > ${itemsPath} <<'DOCKITEMS'\n${itemsJson}\nDOCKITEMS\n` +
      `2. bun ${CORE}/driver/src/dispatch/dock_integrate.ts run --pm-id ${PM_ID} --project ${PROJECT} --items ${itemsPath} --out ${outPath}\n` +
      `Step 2 deterministically integrates each GATED held branch (merge_request -> await terminal -> ` +
      `dispatch_event -> branch delete on success), zero LLM. Your ONLY output is the StructuredOutput ` +
      `carrying the {integrated,enqueued,mergeFailed,integrateError,warnings} JSON step 2 printed.`,
      { label: 'integrate:dock', phase: 'Integrate', schema: INTEGRATE_BATCH },
    )
    if (r) integ = { ...integ, ...r }
  } catch (_e) {
    integ = { ...integ, untracked: gated.map((x) => x.it.slug),
      warnings: [`dock_integrate ran (merge done + recorded + branch deleted) but the agent dropped its result — confirm via 'garelier status' or ${outPath}`] }
  }
}

return {
  enqueued: [...(integ.integrated || []), ...(integ.enqueued || [])],
  needsRework: ok.filter((x) => ['NEEDS_REWORK', 'REFUTED', 'GATE_BLOCKED'].includes(x.state))
    .map((x) => ({ slug: x.it.slug, state: x.state, why: (x.refute || x.obs || x.guard || {}).summary }))
    .concat((integ.mergeFailed || []).map((m) => ({ slug: m.slug, state: 'MERGE_FAILED', why: 'merge gate ' + (m.mergeStatus || 'failed') + ' — escalate (held path has no warm producer)' }))),
  integrateError: integ.integrateError || [],
  integrateUntracked: integ.untracked || [],
  note: 'DEC-083: held branches integrate via the deterministic zero-LLM dock_integrate.ts (one thin journaled agent) — no StructuredOutput in the merge path. enqueued = merged (or await-timeout). needsRework = gate-rejected or merge-gate-rejected (held path escalates to PM, no warm producer). integrateUntracked = dock_integrate ran but its summary dropped (state is correct — `garelier status` confirms). dock_integrate deletes the merged branch on success; run dispatch_cleanup --sweep to archive reports.',
}
