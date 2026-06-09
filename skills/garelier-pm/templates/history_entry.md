<!--
  Template for ONE entry in __garelier/<pm_id>/_pm/history.md.

  PM appends one block per dispatched blueprint or structural event. The entry
  is a FIXED-SCHEMA record so it does not vary by AI/session and stays cheap to
  read. Number is sequential, never reused, zero-padded to a MINIMUM of 3 digits
  and grows beyond three naturally (see control_contract.md "ID numbering").

  FIELD RULES (the lint `scripts/lint_history.ts` checks these — keep them exact):
  - Every "- Field:" below is REQUIRED and is ONE line. Use "-" when N/A.
  - Outcome ∈ { in-progress | shipped | abandoned | aborted | setup-only |
      setup-change | promoted | merge-resolution | blocked }.
  - Reason = <reason-code> — <≤1 line>, where reason-code ∈ { user-request |
      scheduled | escalation-resolved | rework-complete | setup |
      promote-approved | conflict-resolved | abort-user | abort-blocker |
      autonomous-decision }.
  - Decision: a DEC-NNN id, a resolution file path, or "-".
  - Escalation: ESC-id(s) (comma-separated) or "none".
  - Commits: integer count or "-".
  - Follow-up: the single next action, or "-".
  - Notes: OPTIONAL, ≤ 4 lines, WHY-only. NEVER paste diffs, logs, command
      output, file bodies, or long narrative — reference a path/SHA instead
      (compact handoff). This is what previously caused per-session bloat/variance.

  "Next entry number: <N>" marker lives at the BOTTOM of the hot history.md
  (not here). Archived monthly files (history/archive/YYYY-MM.md) never carry it.

  Append-only. The only in-place edits allowed:
    - Updating the Milestone: line of an in-progress entry
    - Changing Outcome from in-progress to a terminal value
    - Appending within the ≤4-line Notes budget
  Retention rotation may move an unchanged completed entry to the monthly archive.
-->

## #{{NNN}} — {{ISO_TIMESTAMP}} — {{short_title}}
- Blueprint: {{blueprint_path | -}}
- Milestone: {{milestone_slug | -}}
- Outcome: {{outcome}}
- Reason: {{reason-code}} — {{one line}}
- Decision: {{DEC-NNN | resolution_path | -}}
- Escalation: {{ESC-id(s) | none}}
- Commits: {{N | -}}
- Follow-up: {{next_action | -}}
- Notes: {{optional, ≤4 lines, WHY only — no diffs/logs/pasted output}}
