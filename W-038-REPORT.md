# W-038 Report — SubagentStop marker-missing block

## Summary

- `skills/garelier-core/hooks/runtime_recovery_hook.ts`: extended `handleSubagentStop`
  so that even with no open runtime incident, a subagent that stops without a
  `GARELIER_RUNTIME_STATUS` marker in `last_assistant_message` is blocked
  (decision:block, reason = fixed text instructing the agent to end the final
  message's last line with `GARELIER_RUNTIME_STATUS: {"runtime_ok": true|false, ...}`
  and complete the register before finishing).
  - Marker-present check is presence-only (`hasStatusMarker`) — unlike the
    existing incident-close check (`runtimeOk`, which requires `runtime_ok === true`),
    a marker with `runtime_ok: false` still counts as "finished cleanly with
    status" for this check, since there is no incident to recover from.
  - Attempts counter reuses the existing `state.json` `open_by_agent_id` map
    (same mechanism as incident blocks); a synthetic entry
    (`kind: "missing_marker"`, `incident_id: gri-marker-<agent_id>`) is used
    when there is no real incident, so incident-block attempts and
    marker-block attempts share one counter per agent (2 blocks total, as
    specified).
  - 3rd `SubagentStop` call (attempts > 2) does not block; it emits
    `GARELIER_PM_ESCALATION` context instead (same shape as the existing
    incident-escalation branch), matching current escalation behavior.
  - Extracted the shared attempts/block/escalate logic into
    `stepAttemptsAndRespond()` to avoid duplicating the two branches (incident
    vs. marker-missing).

## Test cases added

`skills/garelier-core/hooks/runtime_recovery_hook.test.sh`:

- Case 8: no open incident + no marker → block (1st, 2nd call), 3rd call
  escalates instead of blocking.
- Case 9: no open incident + marker present (with `runtime_ok: false`) →
  silent pass, no state file written.

Existing cases 1–7 unchanged (regression pin).

## Verification

- `bash skills/garelier-core/hooks/runtime_recovery_hook.test.sh`: PASS (9/9
  cases, includes the 2 new W-038 cases plus the original 7).
- `bun test src/dispatch/install_runtime_recovery_hook.test.ts` (run from
  `skills/garelier-core/driver/`): PASS (9 pass, 0 fail, 43 expect() calls) —
  unaffected by this change (installer wiring untouched).
- `bunx tsc --noEmit` (from `skills/garelier-core/driver/`): PASS, no errors.

## Commits

- `<see git log>` feat(core): W-038 SubagentStop の marker 不在終了を block (clean stall 対策)

## Notes

- This worker ran as the Sonnet fallback after the Codex attempt failed in
  this worktree with `windows sandbox: runner error: CreateProcessAsUserW
  failed: 1312` (see `codex_last_message.md`, left untouched/uncommitted in
  the worktree as pre-existing residue from that failed attempt).
- Push not performed (worker discipline — Dock/PM owns the merge).
