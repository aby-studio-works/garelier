<!--
  Gate verdict marker — the machine-read completion marker a Guardian or
  Observer subagent writes as the LAST step before its final message
  (DEC-090: the gate role authors its own verdict; the PM never writes or
  edits it). This is SEPARATE from the role's full canonical report
  (guardian_report.md / report.md) — it is the compact token the merge gate
  and `contract_check.ts --gate` read mechanically.

  Path (exact — use the BRANCH SLUG, not a shortened name, or auto-read
  cannot find it; W-020):
    __garelier/<pm_id>/runtime/guardian/results/<branch-slug>-guardian.md
    __garelier/<pm_id>/runtime/observer/results/<branch-slug>-observer.md

  Parser contract (driver/src/merge_gate_parse.ts extractVerdict):
    - The verdict is read ONLY from under the "## Verdict" heading.
    - The body must be EXACTLY ONE canonical token (whole-token match):
        Guardian: PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION
        Observer: PASS | PASS_WITH_NOTES | REWORK_RECOMMENDED | BLOCK | NO_OPINION
    - An unfilled {{...}} menu, a typo (PASSED, BLOCKING), or a truncation
      resolves to NULL = "no verdict" = fail-closed (it never silently
      becomes PASS). So an untouched template safely blocks the merge.
    - Replace the whole menu line under "## Verdict" with one bare token.

  Every finding cited under "## Evidence" needs file:line or diff evidence
  (DEC-088) — a bare adjective verdict is not acceptable.
-->

# Gate verdict — {{guardian | observer}} for `{{branch-slug}}`

- Role: {{guardian | observer}}
- Branch: `{{branch}}`
- Reviewed SHA: {{head_sha}}
- Canonical report: `__garelier/{{pm_id}}/_{{guardians|observers}}/{{id}}/{{guardian_report.md | report.md}}`

## Verdict

{{PASS | PASS_WITH_NOTES | REWORK_RECOMMENDED | BLOCK | NO_OPINION}}

## Evidence

<!-- One line per finding: `path:line — finding`. Use "none" only for a clean PASS. -->

- {{path:line — finding, or "none"}}
