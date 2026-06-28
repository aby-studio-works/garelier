# Garelier Dock Main Loop Reference

## §3. The main loop

What you do on each session, in order:

```
0. Build the dock pulse (DEC-081 Piece 3):
   bun <core>/driver/src/dock_pulse.ts --project <P> --pm-id <ID> [--out __garelier/<ID>/runtime/dock/pulse.json]
   (write it under the gitignored `runtime/` tree, not the main checkout, so it
   never shows up as untracked noise in the target project)
   → one compact digest: the role-status vector — each REPORTING role carrying
   its report.json claims (status / verdict / tests / risk_flags / summary /
   files_changed_count) so you TRIAGE and route (e.g. risk_flagged_roles →
   Guardian, failing tests → REWORK) WITHOUT opening every report — plus inbox /
   resolutions / queue counts + merge-gate lock + signals (has_reporting /
   has_blocked / risk_flagged_roles + WHICH containers, merge_in_flight). Steps
   3–6c then open the full report.md ONLY for the roles you actually review.
   Advisory: read the raw runtime state whenever the pulse looks stale or thin —
   it never replaces a read you need.
1. Pre-flight reading                                              (§1)
2. Process __garelier/<pm_id>/runtime/pm/resolutions/                     (§11)
3. Process __garelier/<pm_id>/runtime/dock/inbox/ (oldest first)     (§6)
4. Check each Worker's STATE.md:
   - REPORTING → run review                                        (§7)
   - BLOCKED → answer or escalate                                  (§11)
   - IDLE + backlog has matching work → integrate target, dispatch (§5, §8.0)
5. Check each Scout's STATE.md:
   - REPORTING → review inspection                                 (§7.2)
   - BLOCKED → answer or escalate                                  (§11)
6. Check each Smith's STATE.md:
   - REPORTING → run review                                        (§7.3)
   - BLOCKED → answer or escalate                                  (§11)
   - IDLE + post-merge hardening pending → dispatch                (§4.2.1, §5)
6b. Check each Librarian's STATE.md:
   - REPORTING → run Librarian Review                              (§7.4)
   - BLOCKED → answer or escalate                                  (§11)
   - IDLE + knowledge/registry/runbook work pending → integrate target, dispatch (§4.2, §5, §8.0)
6c. Check each Observer's STATE.md (_observers/*/):
   - REPORTING → consume verdict, then merge gate or REWORK/escalate (§7.5)
   - BLOCKED → answer or escalate                                  (§11)
7. Scan __garelier/<pm_id>/control/blueprints/ for new active blueprints
   not yet in backlog → plan execution                             (§4)
8. Update __garelier/<pm_id>/runtime/manifest.md only if semantic content changed (§10)
9. If significant changes occurred, write a status
   summary to __garelier/<pm_id>/runtime/pm/inbox/                        (§11)
```

No-op writes are prohibited in driver mode: do not rewrite `manifest.md`,
backlog files, or PM inbox summaries when the computed content is identical and
only the mtime would change. Leaving hot derived indexes untouched is what lets
the driver's interest-file pre-check skip idle iterations.

If any step fails (e.g., merge conflict on a workbench merge, quality
gate failure, missing template), **do not silently retry**. Either
escalate to PM or write a clear failure record to the affected
Worker's `review.md`. Base-tracking conflicts are the exception —
those you resolve yourself (§8.0).

Compact handoff is always active for files you write to Workers,
Scouts, Smiths, PM, and runtime state. Before writing assignments, manifest
activity, inbox notes, escalations, reviews, or backlog entries, apply
`garelier-core/compact_handoff.md`: one fact per line, source pointers
instead of pasted context, no process diary, and no hidden risk.

In Plant-Crust, PM may send container-local cross-container requests into this
Dock's inbox. Dock must handle only the active container and, when the request
asks for a returned result, write the compact response under
`__garelier/<pm_id>/runtime/dock/outbox/` for PM aggregation.
