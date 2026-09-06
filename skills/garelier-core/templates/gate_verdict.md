+++
# Machine face. Every value sits under a [section] / [[array]] table; no VALUE is
# read from the prose below the closing +++. (One thing there is read: a line
# starting uncovered_dimension: / uncovered_cause: / uncovered_tracking_row: /
# alternate_confidence_basis: is the retired disclosure form and refuses the
# verdict, table or no table.) Values are TOML strings, so
# parentheses, backticks, quotes and newlines are ordinary characters - never
# reword a finding to suit the parser. Use '''...''' for anything multi-line.

[verdict]
# Guardian: PASS | PASS_WITH_NOTES | BLOCK | NO_OPINION
# Observer: PASS | PASS_WITH_NOTES | REWORK_RECOMMENDED | BLOCK | NO_OPINION
# An unfilled placeholder, a typo (PASSED, BLOCKING) or a truncation resolves to
# NULL = no verdict = fail-closed. An untouched template safely blocks the merge.
result = '{{PASS | PASS_WITH_NOTES | REWORK_RECOMMENDED | BLOCK | NO_OPINION}}'
# Full 40..64-character lowercase SHA of the reviewed commit. A verdict with no
# review_sha binds to no commit and can never gate a merge.
review_sha = '{{head_sha}}'
role = '{{guardian | observer}}'
branch = '{{branch}}'
canonical_report = '__garelier/{{pm_id}}/_crew/{{guardians|observers}}/{{id}}/{{guardian_report.md | report.md}}'

# One [[finding]] per cited finding. DEC-088: every finding needs file:line or
# diff evidence - a bare adjective verdict is not acceptable. Omit the tables
# entirely for a clean PASS.
# [[finding]]
# site = 'path:line'
# note = '''what is wrong and why it decides the verdict'''

# Guardian only. One [[uncovered]] table per dimension the verdict could NOT
# cover. Omitting them means "nothing uncovered" - you no longer have to avoid
# the word UNCOVERED in prose to say that (W-619 UC-1). A declared table needs
# all four fields, and tracking_row must be a real row id. Writing the four as
# uncovered_<field>: lines in the prose instead is the retired form and refuses
# the verdict - a table beside them does not make it acceptable.
# [[uncovered]]
# dimension = 'secret_pii'
# cause = '''why this dimension could not be covered'''
# tracking_row = 'W-000'
# alternate_confidence_basis = '''what confidence remains, and from where'''
+++

# Gate verdict — {{guardian | observer}} for `{{branch-slug}}`

## Verdict

{{PASS | PASS_WITH_NOTES | REWORK_RECOMMENDED | BLOCK | NO_OPINION}}

<!--
  W-668 / F-20: the marker has TWO readers and they do not read the same surface.
  `merge_land.ts` (via merge_gate_parse.ts) reads `[verdict] result` from the front
  matter above; `contract_check.ts --gate` requires this `## Verdict` heading with a
  BARE canonical token directly under it. A marker carrying only one of the two is
  refused by the other, so write BOTH and keep them identical.

  Bare means bare: no bold (`**PASS**`), no sentence around it, no unfilled `{{…}}`
  menu, no near-miss spelling (PASSED, BLOCKING). Each of those reads as no verdict
  and fails closed.
-->

The gate verdict marker a Guardian or Observer subagent writes as the LAST step
before its final message (DEC-090: the gate role authors its own verdict; the PM
never writes or edits it). SEPARATE from the role's full canonical report
(`guardian_report.md` / `report.md`) — this is the compact record the merge gate
and `contract_check.ts --gate` read mechanically.

Path (exact — use the BRANCH SLUG, not a shortened name, or auto-read cannot find
it; W-020. Do NOT append the role yourself either: the emitter already appends it,
so a slug ending in `-guardian` produces `...-guardian-guardian.md` — a SECOND
candidate path for one seat. The doubled file is still found, since writer and
reader both derive it from `seatReportPath`; what loses a verdict is a prompt that
names two paths and lets the seat pick, which `dispatch_prepare` now refuses at
spawn; W-634):

    __garelier/<pm_id>/runtime/guardian/results/<branch-slug>-guardian.md
    __garelier/<pm_id>/runtime/observer/results/<branch-slug>-observer.md

Token budget (W-190): THIS FILE is the canonical verdict. Your SendMessage
register to the PM is a POINTER + DELTA — the verdict token + this file's path +
the one or two findings that decide the verdict, never a restatement of the diff,
the row, or the review checkpoints (reference a checkpoint by NUMBER). Do NOT
re-send a register you already sent — the PM's register_received marker (or a
wake) confirms receipt.
