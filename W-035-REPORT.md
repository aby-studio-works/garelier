# W-035 Report — runtime recovery hook

## Summary

- Implemented `skills/garelier-core/hooks/runtime_recovery_hook.ts`.
- Added hook fixture test: `skills/garelier-core/hooks/runtime_recovery_hook.test.sh`.
- Added merge-aware installer + bun tests:
  - `skills/garelier-core/driver/src/dispatch/install_runtime_recovery_hook.ts`
  - `skills/garelier-core/driver/src/dispatch/install_runtime_recovery_hook.test.ts`
- Wired setup wizard fresh/diff/teardown and project-root `.claude/.gitignore`.
- Extended `run_summarized.sh` with `--status-file`.
- Added PM runtime incident procedure and dispatch preamble runtime marker / timeout rerun discipline.
- Wired ci smoke coverage for hook, preamble marker, and status-file.

## Blueprint corrections reflected

- Uses official failure fields only for hook input: `exit_code`, `error_message`, `tool_name`, `tool_input`, plus common `session_id`, `cwd`, `agent_id`, `agent_type`.
- Uses `agent_id` as the SubagentStop state key.
- Does not use `duration_ms` or `TASK_MAX_OUTPUT_LENGTH`; timeout is classified from `error_message` text.

## Commits

- `3a717fd` feat(core): W-035 runtime recovery hook
- `59d838e` feat(dispatch): W-035 install runtime recovery hook
- `718b43d` feat(scripts): W-035 status file for run_summarized
- `e1912a8` docs(dispatch): W-035 runtime incident discipline
- `b85cf02` chore(core): W-035 mark runtime hook test executable

## Verification

- `git diff --check`: PASS
- `git diff --cached --check`: PASS
- Hook / bun / ci gates: NOT EXECUTED in this sandbox. `bash` and `bun` process startup failed with runner error `CreateProcessAsUserW failed: 1312`.

## Timeout fixture calibration note

The test pins the official field shape with a representative failure fixture:

```json
{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","exit_code":124,"error_message":"Command timed out after 120000ms"}
```

To refresh with a real captured event, run a Claude Code session with the hook installed, execute a Bash command that exceeds the configured timeout, then copy the emitted `PostToolUseFailure` JSON fields into the fixture while preserving the official schema names above.

## Follow-up: Windows/MSYS path fix

- Fixed the hook fixture to pass `cwd` to Bun in Windows mixed form via `cygpath -m` when running under Git Bash/MSYS.
- Added hook-side defensive normalization for MSYS drive paths such as `/c/path` to `C:/path`.
- Verified the installer test remains green:
  - `bun test src/dispatch/install_runtime_recovery_hook.test.ts`: PASS (7 pass)
- Verified the hook behavior with an equivalent Bun-driven 7-case harness, including `/c/...` cwd normalization: PASS.
- `bash skills/garelier-core/hooks/runtime_recovery_hook.test.sh`: NOT EXECUTED in this sandbox because Git Bash startup fails before the test runs with runner error `CreateProcessAsUserW failed: 1312`.
