# Inbox Notification

<!--
  Sent from one role to another via filesystem. Lightweight; the bulk of
  information lives in the referenced files (assignment.md, report.md,
  questions.md, etc.).
  Path: __garelier/<pm_id>/runtime/dock/inbox/<YYYYMMDD-HHMMSS>-<from>-<topic-slug>.md
        OR __garelier/<pm_id>/runtime/pm/inbox/<...>
  Compact handoff: single requested action, pointers only.
-->

## Header

- From: {{sender_role_and_id}}
- To: {{recipient_role}}
- Sent at: {{ISO8601_timestamp}}
- Type: {{report_complete | blocked | escalation | status_update | other}}
- Related task: #{{ID}} (if applicable)

## Reason for this notification

{{one short reason}}

## What to read

<!-- Pointers only. The recipient reads these, not this notification. -->

- {{path/to/file.md}}
- {{path/to/another.md}}

## Action requested

{{single action: review+merge | answer questions.md | approve/reject escalation | acknowledge}}

## Urgency

{{low | normal | high}}

<!-- Use "high" only when the recipient's delay actively blocks others.
     "Normal" is the default. -->
