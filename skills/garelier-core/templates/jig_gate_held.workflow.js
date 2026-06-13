// Jig gate-held — resume path for ALREADY-PRODUCED branches (DEC-062).
//
// When a jig-tick producer finishes its work but returns BLOCKED (typically a
// question the Dock/PM must answer, or a pre-existing base failure repaired by
// a separate task), the work survives on its workbench/anvil branch while the
// tick ends. After the orchestrator resolves the block (answers.md / repair
// merged), run THIS template to take the held branches through the SAME gate
// order as the tick — Guardian → adversarial refuter → Observer →
// merge_request → dispatch_event — without re-running the producer.
//
// The Dock orchestrator substitutes {{placeholders}} and passes:
//   args: {
//     items: [{ slug, branch, assignmentPath, reportPath }],
//     note?: "reviewer context — e.g. which pre-existing failure was already
//             dispositioned/repaired, so reviewers do not re-block on it"
//   }
export const meta = {
  name: 'garelier-jig-gate-held',
  description: 'Gate (Guardian→refute→Observer) + merge gate + record for held producer branches (DEC-062 resume path)',
  phases: [
    { title: 'Gate', detail: 'Guardian then adversarial refuter then Observer, per branch' },
    { title: 'Integrate', detail: 'merge_request.sh (verdicts + non-empty message) + zero-LLM poll' },
    { title: 'Record', detail: 'dispatch_event.sh — event append + in_flight view regen' },
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
  async (out, it) => {
    if (!out || out.state !== 'GATED') return out
    const integrated = await agent(
      `Mechanical step, no judgment. Run exactly:
` +
      `bash ${CORE}/scripts/merge_request.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
      `--branch "${it.branch}" --task "${it.slug}" --guardian "${out.guard.verdict}" ` +
      `--observer "${out.obs.verdict}"
` +
      `If its JSON says the gate is busy or the request stays pending, run the same poll once more: ` +
      `(cd ${CORE}/driver && bun src/dispatch/dock_merge.ts poll --project ${PROJECT} --pm-id ${PM_ID}). ` +
      `Return the final JSON verbatim.`,
      { label: `merge:${it.slug}`, phase: 'Integrate' },
    )
    return { ...out, state: 'ENQUEUED', integrated }
  },
  async (out, it) => {
    if (!out) return out
    const kind = out.state === 'ENQUEUED' ? 'complete' : 'rework'
    await agent(
      `Mechanical step, no judgment. Run exactly:
` +
      `bash ${CORE}/scripts/dispatch_event.sh --project ${PROJECT} --pm-id ${PM_ID} ` +
      `--kind ${kind} --role "worker(${it.slug})" --task "${it.slug} -> ${out.state}"
` +
      `Then reply done.`,
      { label: `record:${it.slug}`, phase: 'Record' },
    )
    return out
  },
)

const ok = (results || []).filter(Boolean)
return {
  enqueued: ok.filter((x) => x.state === 'ENQUEUED').map((x) => x.it.slug),
  needsRework: ok.filter((x) => ['NEEDS_REWORK', 'REFUTED', 'GATE_BLOCKED'].includes(x.state))
    .map((x) => ({ slug: x.it.slug, state: x.state, why: (x.refute || x.obs || x.guard || {}).summary })),
  note: 'After ENQUEUED: verify merge results, then dispatch_cleanup --id <n> --delete-branch (it archives the report to backlog/done/).',
}
